import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, ChatItem, Collaboration, CollaborationMessage } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
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
