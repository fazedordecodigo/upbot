import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Agent, AgentOverview, AgentsOverviewResult, Approval, Turn } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

setDefaultTimeout(60_000);

const TOKEN = `cockpit-${crypto.randomUUID()}`;

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

describe("agents cockpit e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;

  const overviewOf = async (agentId: string): Promise<AgentOverview> => {
    const o = await c.request("agents.overview", {});
    const a = o.agents.find((x) => x.agentId === agentId);
    if (!a) throw new Error("agent missing from overview");
    return a;
  };

  const create = (name: string, extra: Partial<Agent> = {}) =>
    c.request("agents.create", { name, provider: "devin", ...extra });

  beforeAll(async () => {
    dataDir = tmp("cockpit-data-");
    agentsRoot = tmp("cockpit-root-");
    stateDir = tmp("cockpit-fake-");
    daemon = await startDaemon(dataDir, join(agentsRoot, "agents"), TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_CANCEL_GRACE_MS: "0",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  }, 30_000);

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir]) await removeDir(d);
  }, 30_000);

  test("agents carry role, requireApproval and maxInstances", async () => {
    const plain = await create("Plain");
    expect(plain).toMatchObject({ role: "", requireApproval: true, maxInstances: null });
    expect(plain.instructions).toBe("");

    const fin = await create("Financeiro", {
      role: "  confere as notas fiscais  ",
      requireApproval: false,
      maxInstances: 3,
      instructions: "keep me",
    });
    expect(fin).toMatchObject({
      role: "confere as notas fiscais",
      requireApproval: false,
      maxInstances: 3,
      instructions: "keep me",
    });

    const upd = await c.request("agents.update", { id: fin.id, role: "nova", maxInstances: null });
    expect(upd).toMatchObject({ role: "nova", requireApproval: false, maxInstances: null });
    expect(upd.instructions).toBe("keep me");
    const listed = (await c.request("agents.list", {})).find((a) => a.id === fin.id);
    expect(listed).toMatchObject({ role: "nova", requireApproval: false, maxInstances: null });

    await expect(create("X", { role: "x".repeat(141) })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(create("Y", { maxInstances: 0 })).rejects.toMatchObject({ code: "bad_request" });

    const o = await overviewOf(plain.id);
    expect(o).toEqual({
      agentId: plain.id,
      situation: "idle",
      error: null,
      paused: false,
      instances: { active: 0, max: null, capacity: 1 },
      running: [],
      waiting: [],
      queued: 0,
      machines: [],
    });
    await c.request("agents.delete", { id: plain.id });
    await c.request("agents.delete", { id: fin.id });
  });

  test("requireApproval asks before publishing; off publishes directly", async () => {
    const asks = await create("Asks");
    const free = await create("Free", { requireApproval: false });
    const html = "<!doctype html><h1>oi</h1>";

    const { queueId } = await c.request("chat.send", {
      agentId: asks.id,
      text: `mcp:page_publish ${JSON.stringify({ title: "Relatório", html })}`,
    });
    const approval = (await c.waitForEventWhere(
      "approval.updated",
      (a) => a.agentId === asks.id && a.status === "pending",
      20_000,
    )) as Approval;
    expect(approval.tool).toBe("page_publish");
    expect((await overviewOf(asks.id)).situation).toBe("wait");
    expect((await overviewOf(asks.id)).waiting).toHaveLength(1);
    await c.request("approvals.respond", { id: approval.id, decision: "deny" });
    await c.waitForEventWhere("turn.ended", (t) => t.queueId === queueId, 20_000);
    expect(await c.request("pages.list", {})).toHaveLength(0);

    const freeTurn = await c.request("chat.send", {
      agentId: free.id,
      text: `mcp:page_publish ${JSON.stringify({ title: "Livre", html })}`,
    });
    await c.waitForEventWhere("turn.ended", (t) => t.queueId === freeTurn.queueId, 20_000);
    const pages = await c.request("pages.list", {});
    expect(pages.map((p) => p.title)).toEqual(["Livre"]);
    expect(
      (await c.request("approvals.list", { agentId: free.id })).filter(
        (a) => a.status === "pending",
      ),
    ).toHaveLength(0);
    await c.request("agents.delete", { id: asks.id });
    await c.request("agents.delete", { id: free.id });
  });

  test("task enqueues fill extra instances and overview resolves task titles per agent", async () => {
    const agent = await create("Task runner", { maxInstances: 2, requireApproval: false });
    const other = await create("Other task runner");
    const first = await c.request("tasks.create", { agentId: agent.id, text: "slow" });
    const second = await c.request("tasks.create", { agentId: agent.id, text: "slow" });
    try {
      await c.request("tasks.rename", { id: first.id, title: "First task" });
      await c.request("tasks.rename", { id: second.id, title: "Second task" });
      const overview = await until(async () => {
        const value = await overviewOf(agent.id);
        return value.running.length === 2 ? value : undefined;
      });
      expect(overview.running.map((r) => r.taskId).sort()).toEqual([first.id, second.id].sort());
      expect(overview.running.map((r) => r.title).sort()).toEqual(["First task", "Second task"]);
      expect((await overviewOf(other.id)).running).toEqual([]);
    } finally {
      await c.request("agents.delete", { id: agent.id });
      await c.request("agents.delete", { id: other.id });
    }
  });

  test("overview counts running, waiting and queued work and emits overviewChanged", async () => {
    const runner = await create("Runner", { requireApproval: false });
    const asker = await create("Asker", { requireApproval: false });

    const first = await c.request("chat.send", { agentId: runner.id, text: "slow" });
    const second = await c.request("chat.send", { agentId: runner.id, text: "echo:depois" });
    await c.request("chat.send", { agentId: asker.id, text: "tool" });
    await c.waitForEventWhere("permission.requested", (p) => p.agentId === asker.id, 20_000);

    const snapshot = await until(async () => {
      const o = await c.request("agents.overview", {});
      const r = o.agents.find((a) => a.agentId === runner.id);
      const a = o.agents.find((x) => x.agentId === asker.id);
      return r?.running.length === 1 && a?.waiting.length === 1 ? o : undefined;
    });
    const r = snapshot.agents.find((a) => a.agentId === runner.id)!;
    expect(r.situation).toBe("run");
    expect(r.instances).toEqual({ active: 1, max: null, capacity: 1 });
    expect(r.running[0]).toMatchObject({ id: first.queueId, title: "slow", taskId: null });
    expect(r.queued).toBe(1);
    const a = snapshot.agents.find((x) => x.agentId === asker.id)!;
    expect(a.situation).toBe("wait");
    expect(a.running).toHaveLength(0);
    expect(snapshot.summary).toMatchObject({ agents: 2, running: 1, waiting: 1, queued: 1 });

    const changed = (await c.waitForEventWhere(
      "agents.overviewChanged",
      (o) => o.summary.running === 1 && o.summary.waiting === 1,
      5_000,
    )) as AgentsOverviewResult;
    expect(changed.summary.agents).toBe(2);

    const [perm] = await c.request("permissions.list", {});
    await c.request("permissions.respond", { requestId: perm!.requestId, optionId: null });
    await c.request("chat.cancel", { agentId: runner.id });
    await c.request("queue.remove", { queueId: second.queueId }).catch(() => undefined);
    await until(async () => {
      const o = await c.request("agents.overview", {});
      return o.summary.running === 0 && o.summary.waiting === 0 ? true : undefined;
    });
    await c.request("agents.delete", { id: runner.id });
    await c.request("agents.delete", { id: asker.id });
  });

  test("capacity: runs maxInstances turns at once and pulls the next one when an instance frees", async () => {
    const pool = await create("Pool", { requireApproval: false, maxInstances: 2 });
    const solo = await create("Solo", { requireApproval: false });
    const turnsStarted: Turn[] = [];
    const short = await c.request("chat.send", { agentId: pool.id, text: "watchdog-delay:1500" });
    const long = await c.request("chat.send", { agentId: pool.id, text: "slow" });
    const third = await c.request("chat.send", { agentId: pool.id, text: "watchdog-delay:200" });
    // isolation: another agent's capacity stays 1
    await c.request("chat.send", { agentId: solo.id, text: "slow" });
    const soloQueued = await c.request("chat.send", { agentId: solo.id, text: "echo:x" });

    const both = await until(async () => {
      const o = await overviewOf(pool.id);
      return o.instances.active === 2 ? o : undefined;
    });
    expect(both.instances).toEqual({ active: 2, max: 2, capacity: 2 });
    expect(both.running.map((t) => t.id).sort()).toEqual([short.queueId, long.queueId].sort());
    expect(both.queued).toBe(1);

    const soloView = await overviewOf(solo.id);
    expect(soloView.instances).toEqual({ active: 1, max: null, capacity: 1 });
    expect(soloView.queued).toBe(1);
    expect(soloView.running.every((t) => t.id !== short.queueId && t.id !== long.queueId)).toBe(
      true,
    );

    // lowering below the instances in use is rejected
    await expect(
      c.request("agents.update", { id: pool.id, maxInstances: 1 }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // the short turn ends -> the third request starts while "slow" still runs
    await c.waitForEventWhere("turn.ended", (t) => t.queueId === short.queueId, 20_000);
    const pulled = (await c.waitForEventWhere(
      "turn.started",
      (t) => t.queueId === third.queueId,
      20_000,
    )) as Turn;
    turnsStarted.push(pulled);
    const statuses = await c.request("agents.statuses", {});
    expect(["starting", "running"]).toContain(statuses[pool.id]!.status);
    const ended = (await c.waitForEventWhere(
      "turn.ended",
      (t) => t.queueId === third.queueId,
      20_000,
    )) as Turn;
    expect(ended.status).toBe("completed");
    const mid = await overviewOf(pool.id);
    expect(mid.running.map((t) => t.id)).toEqual([long.queueId]);
    expect(mid.queued).toBe(0);
    expect((await overviewOf(solo.id)).queued).toBe(1);

    // stopping the agent stops every instance; the other agent is untouched
    await c.request("chat.cancel", { agentId: pool.id });
    await c.waitForEventWhere("turn.ended", (t) => t.queueId === long.queueId, 20_000);
    const after = await until(async () => {
      const o = await overviewOf(pool.id);
      return o.instances.active === 0 ? o : undefined;
    });
    expect(after.situation).toBe("idle");
    expect((await overviewOf(solo.id)).instances.active).toBe(1);

    await c.request("chat.cancel", { agentId: solo.id });
    await c.request("queue.remove", { queueId: soloQueued.queueId }).catch(() => undefined);
    await c.request("agents.delete", { id: pool.id });
    await c.request("agents.delete", { id: solo.id });
  });

  test("raising maxInstances starts queued work right away", async () => {
    const grow = await create("Grow", { requireApproval: false });
    const a = await c.request("chat.send", { agentId: grow.id, text: "slow" });
    const b = await c.request("chat.send", { agentId: grow.id, text: "slow" });
    await c.waitForEventWhere("turn.started", (t) => t.queueId === a.queueId, 20_000);
    expect((await overviewOf(grow.id)).queued).toBe(1);
    await c.request("agents.update", { id: grow.id, maxInstances: 2 });
    await c.waitForEventWhere("turn.started", (t) => t.queueId === b.queueId, 20_000);
    const o = await overviewOf(grow.id);
    expect(o.instances).toEqual({ active: 2, max: 2, capacity: 2 });
    await c.request("chat.cancel", { agentId: grow.id });
    await until(async () =>
      (await overviewOf(grow.id)).instances.active === 0 ? true : undefined,
    );
    await c.request("agents.delete", { id: grow.id });
  });
});
