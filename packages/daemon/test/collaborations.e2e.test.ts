import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, ChatItem, Collaboration, CollaborationMessage } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  sendAndWait,
  startDaemon,
  stopDaemon,
  tmp,
  toolCall,
} from "./helpers";

setDefaultTimeout(60_000);

const TOKEN = `collab-test-${crypto.randomUUID()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("collaborations e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let alice: Agent;
  let bob: Agent;
  let collab: Collaboration;

  const newAgent = async (name: string) =>
    c.request("agents.create", { name, provider: "devin", instructions: "" });

  /** Polls the persisted transcript — the authoritative record of what reached the table. */
  const message = async (
    pred: (m: CollaborationMessage) => boolean,
    timeoutMs = 20000,
    id?: string,
  ): Promise<CollaborationMessage> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { messages } = await c.request("collaborations.history", {
        id: id ?? collab.id,
        limit: 500,
      });
      const m = messages.find(pred);
      if (m) return m;
      if (Date.now() > deadline) throw new Error("collaboration message timeout");
      await sleep(100);
    }
  };

  const collabWhere = async (
    pred: (x: Collaboration) => boolean,
    timeoutMs = 20000,
    id?: string,
  ): Promise<Collaboration> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const x =
        id !== undefined
          ? await c.request("collaborations.get", { id })
          : (await c.request("collaborations.list", {})).find(pred);
      if (x && (id !== undefined ? pred(x) : true)) return x;
      if (Date.now() > deadline) throw new Error("collaboration timeout");
      await sleep(100);
    }
  };

  const taskItems = async (taskId: string): Promise<ChatItem[]> => {
    const { items } = await c.request("tasks.history", { id: taskId, limit: 200 });
    return items;
  };

  const pendingApproval = async (tool: string) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const list = await c.request("approvals.list", {});
      const a = list.find((x) => x.status === "pending" && x.tool === tool);
      if (a) return a;
      if (Date.now() > deadline) throw new Error(`approval timeout for ${tool}`);
      await sleep(100);
    }
  };

  beforeAll(async () => {
    dataDir = tmp("collab-data-");
    agentsRoot = tmp("collab-agents-");
    stateDir = tmp("collab-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_SHARED_ROOT: tmp("collab-shared-"),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    alice = await newAgent("Alice");
    bob = await newAgent("Bob");
  });

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("create validates members, opens private sessions and kicks off the leader", async () => {
    await expect(
      c.request("collaborations.create", {
        problem: "p",
        memberIds: [alice.id],
        leaderId: alice.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      c.request("collaborations.create", {
        problem: "p",
        memberIds: [alice.id, bob.id],
        leaderId: "missing",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    collab = await c.request("collaborations.create", {
      problem: "echo:table open",
      title: "Mesa X",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
    });
    expect(collab.status).toBe("active");
    expect(collab.phase).toBe("entender");
    expect(collab.leaderId).toBe(alice.id);
    expect(collab.members).toEqual([
      { agentId: alice.id, role: "leader" },
      { agentId: bob.id, role: "member" },
    ]);
    expect((await c.request("collaborations.list", {})).map((x) => x.id)).toContain(collab.id);
    // member sessions are private tasks: hidden from tasks.list
    expect((await c.request("tasks.list", {})).items).toHaveLength(0);
    // the kick-off lands on the leader's private session and its reply goes to the user
    const reply = await message((m) => m.fromAgentId === alice.id && m.kind === "message");
    expect(reply.toAgentId).toBeNull();
    expect(reply.text).toBe("table open");
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    const raw = JSON.stringify(prompts[prompts.length - 1]!.params);
    expect(raw).toContain("collaboration_context");
    expect(raw).toContain('role=\\"leader\\"');
    const { messages, collaboration } = await c.request("collaborations.history", {
      id: collab.id,
    });
    expect(collaboration.id).toBe(collab.id);
    expect(messages.map((m) => m.kind)).toEqual(["instruction", "message"]);
  });

  test("work mode fields round-trip; omitted ones get neutral defaults", async () => {
    const flagged = await c.request("collaborations.create", {
      problem: "echo:flagged table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
      topology: "hub",
      askExternal: true,
      checkpointPhases: true,
      useMemory: true,
    });
    expect(flagged.topology).toBe("hub");
    expect(flagged.askExternal).toBe(true);
    expect(flagged.checkpointPhases).toBe(true);
    expect(flagged.useMemory).toBe(true);
    expect(flagged.phasePending).toBeNull();
    const fetched = await c.request("collaborations.get", { id: flagged.id });
    expect(fetched.topology).toBe("hub");
    expect(fetched.askExternal).toBe(true);
    expect(fetched.checkpointPhases).toBe(true);
    expect(fetched.useMemory).toBe(true);
    expect(
      (await c.request("collaborations.list", {})).find((x) => x.id === flagged.id),
    ).toMatchObject({ topology: "hub", askExternal: true });
    await c.request("collaborations.stop", { id: flagged.id });

    const plain = await c.request("collaborations.create", {
      problem: "echo:plain table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
    });
    expect(plain.topology).toBe("mesh");
    expect(plain.askExternal).toBe(false);
    expect(plain.checkpointPhases).toBe(false);
    expect(plain.useMemory).toBe(false);
    expect(plain.phasePending).toBeNull();
    await c.request("collaborations.stop", { id: plain.id });
  });

  test("approvals raised inside a table turn carry collaborationId; outside, null", async () => {
    const table = await c.request("collaborations.create", {
      problem: "echo:gated table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, table.id);

    // alice's table session calls a gated tool; the approval names this table
    await c.request("collaborations.instruct", {
      id: table.id,
      text: `mcp:page_publish ${JSON.stringify({ title: "P", html: "<p>x</p>" })}`,
    });
    const inTable = await pendingApproval("page_publish");
    expect(inTable.collaborationId).toBe(table.id);
    await c.request("approvals.respond", { id: inTable.id, decision: "deny" });
    // the denied call comes back to the table as the member's reply
    await message(
      (m) => m.fromAgentId === alice.id && m.kind === "message" && m.text.includes("declined"),
      20000,
      table.id,
    );

    // the same gated call in plain chat is not tied to any table
    const turnPromise = sendAndWait(
      c,
      alice.id,
      `mcp:page_publish ${JSON.stringify({ title: "Q", html: "<p>y</p>" })}`,
    );
    const outside = await pendingApproval("page_publish");
    expect(outside.collaborationId).toBeNull();
    await c.request("approvals.respond", { id: outside.id, decision: "deny" });
    await turnPromise;
    await c.request("collaborations.stop", { id: table.id });
  });

  test("the leader's kickoff describes the table's work mode", async () => {
    const flagged = await c.request("collaborations.create", {
      problem: "echo:flagged kickoff",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
      topology: "hub",
      askExternal: true,
      checkpointPhases: true,
      useMemory: true,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, flagged.id);
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    const kick = JSON.stringify(prompts.at(-1)!.params);
    expect(kick).toContain("How this table works");
    expect(kick).toContain("through the leader");
    expect(kick).toContain("approval");
    expect(kick).toContain("phase");
    expect(kick).toContain("profile");
    await c.request("collaborations.stop", { id: flagged.id });
  });

  test("members talk pair-to-pair and can ask the user", async () => {
    // leader DMs a member: transcript row + delivery to Bob's table session
    await toolCall(c, alice, "table_message", {
      to: "Bob",
      text: "echo:hi Bob",
      table: collab.id,
    });
    const dm = await message(
      (m) => m.fromAgentId === alice.id && m.toAgentId === bob.id && m.text === "echo:hi Bob",
    );
    expect(dm.kind).toBe("message");
    // Bob's session reply goes back to the sender (Alice), also on the transcript
    const bobReply = await message(
      (m) => m.fromAgentId === bob.id && m.toAgentId === alice.id && m.text === "hi Bob",
    );
    expect(bobReply.kind).toBe("message");

    // to:"user" parks a pending request — nothing is delivered until the user answers
    await toolCall(c, bob, "table_message", {
      to: "user",
      text: "what color should the button be?",
      table: collab.id,
    });
    const req = await message((m) => m.kind === "request" && m.fromAgentId === bob.id);
    expect(req.toAgentId).toBeNull();
    expect(req.answeredAt).toBeNull();

    await c.request("collaborations.answer", {
      id: collab.id,
      messageId: req.id,
      text: "echo:blue",
    });
    // the answer goes back to the asking member's session; his reply lands to the user
    const back = await message(
      (m) => m.fromAgentId === null && m.toAgentId === bob.id && m.text === "echo:blue",
    );
    expect(back.kind).toBe("message");
    await message((m) => m.fromAgentId === bob.id && m.toAgentId === null && m.text === "blue");
    const stored = await message((m) => m.id === req.id);
    expect(stored.answeredAt).not.toBeNull();
  });

  test("leader drives phases, invites and removes members", async () => {
    const phase = await toolCall(c, alice, "table_phase", {
      phase: "investigar",
      table: collab.id,
    });
    expect(phase).toContain("investigar");
    await message((m) => m.kind === "phase" && m.text === "investigar");
    expect((await c.request("collaborations.get", { id: collab.id })).phase).toBe("investigar");
    // a member cannot drive the table
    expect(
      await toolCall(c, bob, "table_phase", { phase: "corrigir", table: collab.id }),
    ).toContain("leader");

    const dave = await newAgent("Dave");
    await toolCall(c, alice, "table_invite", { agent: "Dave", table: collab.id });
    await collabWhere((d) => d.members.some((m) => m.agentId === dave.id), 20000, collab.id);
    await message((m) => m.kind === "system" && m.text.includes("Dave joined"));
    // new member gets his own private session — still invisible to tasks.list
    expect((await c.request("tasks.list", {})).items).toHaveLength(0);
    // non-leader cannot invite
    expect(await toolCall(c, bob, "table_invite", { agent: "Nobody", table: collab.id })).toContain(
      "leader",
    );
    await toolCall(c, alice, "table_remove", { agent: "Dave", table: collab.id });
    await collabWhere((d) => d.members.every((m) => m.agentId !== dave.id), 20000, collab.id);
    await message((m) => m.kind === "system" && m.text.includes("Dave left"));
    // Dave is gone: a DM to him is rejected
    expect(
      await toolCall(c, alice, "table_message", {
        to: "Dave",
        text: "still here?",
        table: collab.id,
      }),
    ).toContain("not at this table");
  });

  test("hub topology clamps member messages to the leader", async () => {
    const carol = await newAgent("Carol-hub");
    const hub = await c.request("collaborations.create", {
      problem: "echo:hub table",
      memberIds: [alice.id, bob.id, carol.id],
      leaderId: alice.id,
      topology: "hub",
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, hub.id);

    // a member addressing another member is clamped to the leader
    const reply = await toolCall(c, bob, "table_message", {
      to: "Carol-hub",
      text: "echo:through hub",
      table: hub.id,
    });
    expect(reply).toContain("leader");
    const row = await message(
      (m) => m.fromAgentId === bob.id && m.text === "echo:through hub",
      20000,
      hub.id,
    );
    expect(row.toAgentId).toBe(alice.id);

    // the leader still talks straight to members
    await toolCall(c, alice, "table_message", {
      to: "Bob",
      text: "echo:leader to bob",
      table: hub.id,
    });
    const direct = await message(
      (m) => m.fromAgentId === alice.id && m.text === "echo:leader to bob",
      20000,
      hub.id,
    );
    expect(direct.toAgentId).toBe(bob.id);

    // mesh clamps nothing
    const mesh = await c.request("collaborations.create", {
      problem: "echo:mesh table",
      memberIds: [alice.id, bob.id, carol.id],
      leaderId: alice.id,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, mesh.id);
    await toolCall(c, bob, "table_message", {
      to: "Carol-hub",
      text: "echo:mesh direct",
      table: mesh.id,
    });
    const meshRow = await message(
      (m) => m.fromAgentId === bob.id && m.text === "echo:mesh direct",
      20000,
      mesh.id,
    );
    expect(meshRow.toAgentId).toBe(carol.id);
    await c.request("collaborations.stop", { id: hub.id });
    await c.request("collaborations.stop", { id: mesh.id });
  });

  test("ask_external gates external actions for every member of the table", async () => {
    const loose = await c.request("agents.create", {
      name: "Loose",
      provider: "devin",
      instructions: "",
      requireApproval: false,
    });
    // a member who never asks on his own publishes freely in a flagless table
    const plain = await c.request("collaborations.create", {
      problem: "echo:open table",
      memberIds: [loose.id, bob.id],
      leaderId: loose.id,
    });
    await message((m) => m.fromAgentId === loose.id && m.kind === "message", 20000, plain.id);
    await c.request("collaborations.instruct", {
      id: plain.id,
      text: `mcp:page_publish ${JSON.stringify({ title: "Free", html: "<p>f</p>" })}`,
    });
    await message(
      (m) => m.kind === "message" && m.fromAgentId === loose.id && m.text.includes("published"),
      20000,
      plain.id,
    );
    // and no approval was ever opened for that call
    const approvals = await c.request("approvals.list", {});
    expect(approvals.every((a) => a.collaborationId !== plain.id)).toBe(true);

    // the same member in a flagged table gets gated
    const gated = await c.request("collaborations.create", {
      problem: "echo:gated external",
      memberIds: [loose.id, bob.id],
      leaderId: loose.id,
      askExternal: true,
    });
    await message((m) => m.fromAgentId === loose.id && m.kind === "message", 20000, gated.id);
    await c.request("collaborations.instruct", {
      id: gated.id,
      text: `mcp:page_publish ${JSON.stringify({ title: "Gated", html: "<p>g</p>" })}`,
    });
    const approval = await pendingApproval("page_publish");
    expect(approval.collaborationId).toBe(gated.id);
    await c.request("approvals.respond", { id: approval.id, decision: "approve" });
    await message(
      (m) => m.kind === "message" && m.fromAgentId === loose.id && m.text.includes("published"),
      20000,
      gated.id,
    );
    await c.request("collaborations.stop", { id: plain.id });
    await c.request("collaborations.stop", { id: gated.id });
  });

  test("checkpoint_phases holds the phase until the user releases it", async () => {
    const cp = await c.request("collaborations.create", {
      problem: "echo:checkpoint table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
      checkpointPhases: true,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, cp.id);

    // the leader's table_phase becomes a user request; the phase does not move yet
    const reply = await toolCall(c, alice, "table_phase", {
      phase: "investigar",
      summary: "We mapped the failure modes.",
      table: cp.id,
    });
    expect(reply).toContain("release");
    const held = await collabWhere((x) => x.phasePending === "investigar", 20000, cp.id);
    expect(held.phase).toBe("entender");
    const req = await message((m) => m.kind === "request" && m.answeredAt === null, 20000, cp.id);
    expect(req.text).toContain("We mapped the failure modes.");

    // a second phase change while one is pending errors out
    const retry = await toolCall(c, alice, "table_phase", {
      phase: "corrigir",
      summary: "skip ahead",
      table: cp.id,
    });
    expect(retry).toContain("release");

    // the table keeps talking while the transition waits
    await toolCall(c, bob, "table_message", {
      to: "Alice",
      text: "echo:still talking",
      table: cp.id,
    });
    await message((m) => m.fromAgentId === bob.id && m.text === "echo:still talking", 20000, cp.id);

    // answering the request applies the pending phase
    await c.request("collaborations.answer", {
      id: cp.id,
      messageId: req.id,
      text: "go ahead",
    });
    const moved = await collabWhere(
      (x) => x.phase === "investigar" && x.phasePending === null,
      20000,
      cp.id,
    );
    expect(moved.phase).toBe("investigar");
    await message((m) => m.kind === "phase" && m.text === "investigar", 20000, cp.id);
    await c.request("collaborations.stop", { id: cp.id });
  });

  test("use_memory suppresses the user profile in member sessions only", async () => {
    await c.request("profile.update", { about: "a tester who likes mesas" });
    await c.request("memories.add", { agentId: alice.id, text: "remembers everything" });

    const off = await c.request("collaborations.create", {
      problem: "echo:off-memory table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
      useMemory: false,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, off.id);
    const on = await c.request("collaborations.create", {
      problem: "echo:on-memory table",
      memberIds: [alice.id, bob.id],
      leaderId: alice.id,
      useMemory: true,
    });
    await message((m) => m.fromAgentId === alice.id && m.kind === "message", 20000, on.id);

    const outsider = await newAgent("Outsider");
    await sendAndWait(c, outsider.id, "echo:outside chat", 20000);

    const prompts = readLog(stateDir)
      .filter((e) => e.method === "session/prompt")
      .map((e) => (e.params as { prompt: { text?: string }[] }).prompt?.[0]?.text ?? "");
    const offPrompt = prompts.find((p) => p.includes("off-memory table"));
    const onPrompt = prompts.find((p) => p.includes("on-memory table"));
    const chatPrompt = prompts.find((p) => p.includes("outside chat"));

    expect(offPrompt).toBeDefined();
    expect(offPrompt!).not.toContain("<user_profile>");
    expect(offPrompt!).toContain("<agent_memories>");
    expect(onPrompt).toBeDefined();
    expect(onPrompt!).toContain("<user_profile>");
    expect(onPrompt!).toContain("<agent_memories>");
    expect(chatPrompt).toBeDefined();
    expect(chatPrompt!).toContain("<user_profile>");
    await c.request("collaborations.stop", { id: off.id });
    await c.request("collaborations.stop", { id: on.id });
  });

  test("phase_pending survives a restart", async () => {
    const dataDir4 = tmp("collab-cp-data-");
    const agentsRoot4 = tmp("collab-cp-agents-");
    const stateDir4 = tmp("collab-cp-fake-");
    const env = {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir4,
      BOTO_SHARED_ROOT: tmp("collab-cp-shared-"),
    };
    const d5 = await startDaemon(dataDir4, agentsRoot4, `${TOKEN}-cp1`, env);
    const c5 = await DaemonClient.connect(d5.port, `${TOKEN}-cp1`);
    const lead = await c5.request("agents.create", {
      name: "CpLead",
      provider: "devin",
      instructions: "",
    });
    const other = await c5.request("agents.create", {
      name: "CpOther",
      provider: "devin",
      instructions: "",
    });
    const t = await c5.request("collaborations.create", {
      problem: "echo:cp restart",
      memberIds: [lead.id, other.id],
      leaderId: lead.id,
      checkpointPhases: true,
    });
    {
      const deadline = Date.now() + 20000;
      for (;;) {
        const { messages } = await c5.request("collaborations.history", { id: t.id });
        if (messages.some((m) => m.kind === "message")) break;
        if (Date.now() > deadline) throw new Error("kick-off reply timeout");
        await sleep(100);
      }
    }
    await toolCall(c5, lead, "table_phase", {
      phase: "investigar",
      summary: "halfway there",
      table: t.id,
    });
    {
      const deadline = Date.now() + 20000;
      for (;;) {
        const x = await c5.request("collaborations.get", { id: t.id });
        if (x.phasePending === "investigar") break;
        if (Date.now() > deadline) throw new Error("phase_pending timeout");
        await sleep(100);
      }
    }
    await c5.close();
    await stopDaemon(d5, undefined);
    const d6 = await startDaemon(dataDir4, agentsRoot4, `${TOKEN}-cp2`, env);
    const c6 = await DaemonClient.connect(d6.port, `${TOKEN}-cp2`);
    try {
      const after = await c6.request("collaborations.get", { id: t.id });
      expect(after.phasePending).toBe("investigar");
      expect(after.phase).toBe("entender");
    } finally {
      await stopDaemon(d6, c6, stateDir4);
      for (const d of [dataDir4, agentsRoot4, stateDir4])
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("pause freezes deliveries and resume restarts them", async () => {
    const paused = await c.request("collaborations.pause", { id: collab.id });
    expect(paused.status).toBe("paused");
    await c.request("collaborations.instruct", { id: collab.id, text: "echo:after pause" });
    await expect(
      message((m) => m.fromAgentId === alice.id && m.text === "after pause", 4000),
    ).rejects.toThrow("timeout");
    const resumed = await c.request("collaborations.resume", { id: collab.id });
    expect(resumed.status).toBe("active");
    await message((m) => m.fromAgentId === alice.id && m.text === "after pause");
  });

  test("start_collaboration from a task returns the summary to its origin", async () => {
    const carol = await newAgent("Carol");
    const task = await c.request("tasks.create", {
      agentId: carol.id,
      text: `mcp:start_collaboration ${JSON.stringify({ problem: "echo:fromtask", members: ["Alice", "Bob"], title: "Mesa Task" })}`,
    });
    const created = await collabWhere((d) => d.leaderId === carol.id && d.title === "Mesa Task");
    expect(created.members.map((m) => m.agentId).sort()).toEqual(
      [alice.id, bob.id, carol.id].sort(),
    );
    // bot-opened tables carry neutral defaults — no gates nobody chose
    expect(created).toMatchObject({
      topology: "mesh",
      askExternal: false,
      checkpointPhases: false,
      useMemory: false,
      phasePending: null,
    });
    // the user asks the leader to conclude; the instruction reaches Carol's table session
    await c.request("collaborations.instruct", {
      id: created.id,
      text: `mcp:conclude_collaboration ${JSON.stringify({ summary: "echo:result1", table: created.id })}`,
    });
    const done = await collabWhere((d) => d.status === "done", 20000, created.id);
    expect(done.summary).toBe("echo:result1");
    await message((m) => m.kind === "summary" && m.text === "echo:result1", 20000, created.id);
    // the summary lands back on the originating task as a new turn
    const deadline = Date.now() + 20000;
    let items2: ChatItem[] = [];
    for (;;) {
      items2 = await taskItems(task.id);
      if (
        items2.some(
          (i) => i.kind === "agent_message" && "text" in i && i.text.includes("result1"),
        ) ||
        Date.now() > deadline
      )
        break;
      await sleep(150);
    }
    expect(
      items2.some(
        (i) =>
          i.kind === "user_message" &&
          "text" in i &&
          i.text.includes("concluded. Summary") &&
          i.text.includes("result1"),
      ),
    ).toBe(true);
    expect(
      items2.some((i) => i.kind === "agent_message" && "text" in i && i.text.includes("result1")),
    ).toBe(true);
  });

  test("stop is terminal", async () => {
    const stopped = await c.request("collaborations.stop", { id: collab.id });
    expect(stopped.status).toBe("stopped");
    expect(stopped.endedAt).not.toBeNull();
    await expect(
      c.request("collaborations.instruct", { id: collab.id, text: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(
      await toolCall(c, alice, "table_message", { to: "Bob", text: "x", table: collab.id }),
    ).toContain("stopped");
  });

  test("restart pauses an idle active table", async () => {
    const dataDir3 = tmp("collab-recover-data-");
    const agentsRoot3 = tmp("collab-recover-agents-");
    const stateDir3 = tmp("collab-recover-fake-");
    const env = {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir3,
      BOTO_SHARED_ROOT: tmp("collab-recover-shared-"),
    };
    const d3 = await startDaemon(dataDir3, agentsRoot3, `${TOKEN}-r1`, env);
    const c3 = await DaemonClient.connect(d3.port, `${TOKEN}-r1`);
    const a = await c3.request("agents.create", {
      name: "R1",
      provider: "devin",
      instructions: "",
    });
    const b = await c3.request("agents.create", {
      name: "R2",
      provider: "devin",
      instructions: "",
    });
    const t = await c3.request("collaborations.create", {
      problem: "echo:recover",
      memberIds: [a.id, b.id],
      leaderId: a.id,
    });
    // let the kick-off fully land so nothing is pending when the daemon dies
    {
      const deadline = Date.now() + 20000;
      for (;;) {
        const { messages } = await c3.request("collaborations.history", { id: t.id });
        if (messages.some((m) => m.kind === "message")) break;
        if (Date.now() > deadline) throw new Error("kick-off reply timeout");
        await sleep(100);
      }
    }
    await c3.close();
    await stopDaemon(d3, undefined);
    const d4 = await startDaemon(dataDir3, agentsRoot3, `${TOKEN}-r2`, env);
    const c4 = await DaemonClient.connect(d4.port, `${TOKEN}-r2`);
    try {
      const after = await c4.request("collaborations.get", { id: t.id });
      expect(after.status).toBe("paused");
      const { messages } = await c4.request("collaborations.history", { id: t.id });
      expect(messages.some((m) => m.kind === "system" && m.text.includes("restarted"))).toBe(true);
    } finally {
      await stopDaemon(d4, c4, stateDir3);
      for (const d of [dataDir3, agentsRoot3, stateDir3])
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("message cap auto-pauses the table", async () => {
    const dataDir2 = tmp("collab-cap-data-");
    const agentsRoot2 = tmp("collab-cap-agents-");
    const stateDir2 = tmp("collab-cap-fake-");
    const d2 = await startDaemon(dataDir2, agentsRoot2, `${TOKEN}-cap`, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir2,
      BOTO_SHARED_ROOT: tmp("collab-cap-shared-"),
      BOTO_COLLAB_MAX_MESSAGES: "4",
    });
    const c2 = await DaemonClient.connect(d2.port, `${TOKEN}-cap`);
    try {
      const a = await c2.request("agents.create", {
        name: "A1",
        provider: "devin",
        instructions: "",
      });
      const b = await c2.request("agents.create", {
        name: "A2",
        provider: "devin",
        instructions: "",
      });
      const t = await c2.request("collaborations.create", {
        problem: "echo:cap",
        memberIds: [a.id, b.id],
        leaderId: a.id,
      });
      // kickoff (1) + reply (2), then one instruct (3) + reply (4) hits the cap
      const deadline = Date.now() + 20000;
      let status = "active";
      while (Date.now() < deadline) {
        status = (await c2.request("collaborations.get", { id: t.id })).status;
        if (status === "paused") break;
        if (
          status === "active" &&
          (await c2.request("collaborations.get", { id: t.id })).stats.messages === 2
        )
          await c2
            .request("collaborations.instruct", { id: t.id, text: "echo:two" })
            .catch(() => {});
        await sleep(150);
      }
      expect(status).toBe("paused");
      const { messages } = await c2.request("collaborations.history", { id: t.id });
      expect(messages.some((m) => m.kind === "system" && m.text.includes("Message limit"))).toBe(
        true,
      );
    } finally {
      await stopDaemon(d2, c2, stateDir2);
      for (const d of [dataDir2, agentsRoot2, stateDir2])
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
