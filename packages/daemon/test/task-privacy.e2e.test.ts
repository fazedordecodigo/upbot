import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Agent, Approval, PendingPermission } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

const token = `privacy-${crypto.randomUUID()}`;
let daemon: DaemonHandle;
let client: DaemonClient;
let agent: Agent;
const dirs = [tmp("privacy-data-"), tmp("privacy-agents-"), tmp("privacy-state-")];

beforeAll(async () => {
  daemon = await startDaemon(dirs[0]!, dirs[1]!, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: dirs[2]!,
    BOTO_MOBILE_HOST: "127.0.0.1",
    BOTO_MOBILE_PORT: "0",
  });
  client = await DaemonClient.connect(daemon.port, token);
  agent = await client.request("agents.create", {
    name: "Privacy",
    provider: "devin",
    instructions: "",
  });
});

afterAll(async () => {
  await stopDaemon(daemon, client, dirs[2]!);
  for (const dir of dirs) removeDir(dir);
});

test("private queued tasks are absent from queue.get and queue.updated", async () => {
  await client.request("queue.pause", { agentId: agent.id });
  const start = client.events.length;
  const task = await client.request("tasks.create", {
    agentId: agent.id,
    text: "queue-secret-canary",
    private: true,
  });
  try {
    const queue = await client.request("queue.get", { agentId: agent.id });
    expect(queue.items.some((item) => item.taskId === task.id)).toBe(false);
    expect(
      JSON.stringify(client.events.slice(start).filter((e) => e.event === "queue.updated")),
    ).not.toContain("queue-secret-canary");
  } finally {
    await client.request("tasks.stop", { id: task.id });
  }
});

test("private task metadata is absent from global events and all task listings", async () => {
  const start = client.events.length;
  const task = await client.request("tasks.create", {
    agentId: agent.id,
    text: "metadata-secret-canary",
    private: true,
  });
  try {
    expect(JSON.stringify(client.events.slice(start))).not.toContain("metadata-secret-canary");
    for (const includePrivate of [false, true])
      expect(
        (await client.request("tasks.list", { includePrivate })).items.map((t) => t.id),
      ).not.toContain(task.id);
    expect(
      (await client.request("tasks.search", { query: "metadata-secret-canary" })).tasks,
    ).toEqual([]);
    expect(await client.request("tasks.deliveries", { taskId: task.id })).toEqual([]);
    expect((await client.request("tasks.get", { id: task.id })).prompt).toBe(
      "metadata-secret-canary",
    );
  } finally {
    await client.request("tasks.stop", { id: task.id });
  }
});

test("private turn and item events never reach an unscoped desktop connection", async () => {
  const start = client.events.length;
  const task = await client.request("tasks.create", {
    agentId: agent.id,
    text: "slow",
    private: true,
    requireApproval: false,
  });
  try {
    await client.request("queue.resume", { agentId: agent.id });
    const deadline = Date.now() + 15_000;
    while (
      !(await client.request("tasks.history", { id: task.id })).items.some(
        (item) => item.kind === "agent_message",
      )
    ) {
      if (Date.now() > deadline) throw new Error("private turn did not produce an item");
      await Bun.sleep(25);
    }
    expect(JSON.stringify(client.events.slice(start))).not.toContain(task.id);
    expect((await client.request("chat.history", { agentId: agent.id })).items).toEqual([]);
    const overview = await client.request("agents.overview", {});
    expect(JSON.stringify(overview)).not.toContain(task.id);
  } finally {
    await client.request("tasks.stop", { id: task.id });
  }
}, 30_000);

test("private bridge approvals remain mandatory and available only in the task scope", async () => {
  const owner = await DaemonClient.connect(daemon.port, token);
  await client.request("queue.pause", { agentId: agent.id });
  const task = await owner.request("tasks.create", {
    agentId: agent.id,
    text: `mcp:send_message ${JSON.stringify({ to: agent.id, text: "approval-private-canary" })}`,
    private: true,
    requireApproval: true,
  });
  try {
    await owner.request("tasks.subscribe", { id: task.id, watch: true });
    await client.request("queue.resume", { agentId: agent.id });
    const event = await owner.waitForEventWhere(
      "task.event",
      (e) =>
        e.taskId === task.id &&
        e.event === "approval.updated" &&
        (e.data as Approval).status === "pending",
    );
    const approval = event.data as Approval;
    expect(approval.tool).toBe("send_message");
    expect(await owner.request("approvals.list", { taskId: task.id })).toContainEqual(approval);
    expect(await client.request("approvals.list", {})).toEqual([]);
    expect((await owner.request("tasks.get", { id: task.id })).situation).toBe("wait");
    await owner.request("approvals.respond", { id: approval.id, decision: "deny" });
    await owner.waitForEventWhere(
      "task.event",
      (e) => e.taskId === task.id && e.event === "turn.ended",
    );
    expect(JSON.stringify(client.events)).not.toContain("approval-private-canary");
    expect(JSON.stringify(client.events)).not.toContain(task.id);
    expect(await client.request("approvals.list", {})).toEqual([]);
    expect(
      (await owner.request("approvals.list", { taskId: task.id })).some(
        (a) => a.id === approval.id && a.status === "denied",
      ),
    ).toBe(true);
  } finally {
    await client.request("tasks.stop", { id: task.id });
    owner.ws.close();
  }
}, 30_000);

test("only a subscribed task view sees private live items and approval controls; mobile sees neither", async () => {
  const owner = await DaemonClient.connect(daemon.port, token);
  const status = await client.request("mobile.enable", { enabled: true });
  const base = status.urls[0]!.replace(/\/$/, "");
  const { code } = await client.request("mobile.pair", {});
  const paired = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { token: device } = (await paired.json()) as { token: string };
  const mobile = async (method: string, params: unknown) =>
    fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${device}` },
      body: JSON.stringify({ method, params }),
    });
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/events?token=${device}`, { signal: abort.signal });
  const reader = stream.body!.getReader();
  let frames = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  let taskId: string | undefined;
  try {
    await client.request("queue.pause", { agentId: agent.id });
    const task = await owner.request("tasks.create", {
      agentId: agent.id,
      text: "tool",
      private: true,
    });
    taskId = task.id;
    await expect(
      owner.request("tasks.subscribe", { id: "missing", watch: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    await owner.request("tasks.subscribe", { id: task.id, watch: true });
    expect(await (await mobile("queue.get", { agentId: agent.id })).json()).toMatchObject({
      result: { items: [] },
    });
    await client.request("queue.resume", { agentId: agent.id });
    const event = await owner.waitForEventWhere(
      "task.event",
      (e) => e.taskId === task.id && e.event === "permission.requested",
    );
    const permission = event.data as PendingPermission;
    expect(await owner.request("permissions.list", { taskId: task.id })).toEqual([permission]);
    expect(await client.request("permissions.list", {})).toEqual([]);
    expect(await (await mobile("permissions.list", {})).json()).toEqual({ result: [] });
    expect((await mobile("permissions.list", { taskId: task.id })).status).toBe(403);
    expect((await mobile("approvals.list", { taskId: task.id })).status).toBe(403);
    expect((await mobile("tasks.subscribe", { id: task.id, watch: true })).status).toBe(403);
    const history = await owner.request("tasks.history", { id: task.id });
    expect(history.items.some((item) => item.kind === "permission")).toBe(true);
    expect(await client.request("approvals.list", {})).toEqual([]);
    await owner.request("permissions.respond", {
      requestId: permission.requestId,
      optionId: "allow_once",
    });
    await owner.waitForEventWhere(
      "task.event",
      (e) => e.taskId === task.id && e.event === "turn.ended",
    );
    expect(JSON.stringify(owner.events.filter((e) => e.event === "task.event"))).toContain(
      "permission:allow_once",
    );
    expect(JSON.stringify(client.events)).not.toContain(task.id);
    const fence = `public-fence-${crypto.randomUUID()}`;
    await client.request("agents.update", { id: agent.id, name: fence });
    const deadline = Date.now() + 5000;
    while (!frames.includes(fence)) {
      if (Date.now() > deadline) throw new Error("mobile public event fence missing");
      await Bun.sleep(10);
    }
    expect(frames).not.toContain(task.id);
    expect(frames).not.toContain("Fake tool");
    expect(frames).not.toContain("permission:allow_once");
    expect(frames).not.toContain("task.event");
    await owner.request("tasks.subscribe", { id: task.id, watch: false });
    const count = owner.events.filter((e) => e.event === "task.event").length;
    await client.request("tasks.rename", { id: task.id, title: "still-private" });
    await owner.request("tasks.get", { id: task.id });
    expect(owner.events.filter((e) => e.event === "task.event")).toHaveLength(count);
  } finally {
    abort.abort();
    await reading;
    if (taskId) await client.request("tasks.stop", { id: taskId });
    owner.ws.close();
  }
}, 30_000);
