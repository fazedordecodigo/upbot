import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WHEN_SCHEDULES, whenToRoutine } from "@boto/protocol";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { RoutineService } from "../src/routines";
import { DaemonClient, ROOT, startDaemon, stopDaemon, tmp } from "./helpers";

test("Quando maps local dates and recurring schedules", () => {
  const now = new Date(2026, 2, 7, 23, 45).getTime();
  expect(whenToRoutine("now", now)).toBeNull();
  expect(whenToRoutine("in1h", now)).toEqual({ runAt: now + 3_600_000, schedule: null });
  expect(whenToRoutine("tomorrow", now)).toEqual({
    runAt: new Date(2026, 2, 8, 8).getTime(),
    schedule: null,
  });
  for (const when of ["daily", "weekly"] as const)
    expect(whenToRoutine(when, now)).toEqual({ runAt: null, schedule: WHEN_SCHEDULES[when] });
});

test("templates seed, lifecycle, prefill, validation and events", async () => {
  const data = tmp("templates-data-");
  const root = tmp("templates-bots-");
  const token = crypto.randomUUID();
  const daemon = await startDaemon(data, root, token);
  const c = await DaemonClient.connect(daemon.port, token);
  try {
    const templates = await c.request("templates.list", {});
    expect(templates.map((t) => t.id)).toEqual([
      "ci",
      "email",
      "deps",
      "research",
      "sales",
      "inbox",
    ]);
    const prototype = readFileSync(join(ROOT, "docs/design/index.html"), "utf8");
    for (const t of templates) {
      const block = prototype.split(`data-template="${t.id}"`)[1]!.split("</button>")[0]!;
      expect(t.name).toBe(block.match(/class="template-name">([^<]+)/)![1]!);
      expect(t.prompt).toBe(t.name);
      expect(t.description).toBe(block.match(/class="template-desc">([^<]+)/)![1]!);
      expect(t.icon).toBe(block.match(/icons.svg#i-([^"]+)/)![1]!);
      expect(t.builtin).toBe(true);
      expect(t.hidden).toBe(false);
      expect(t.kind).toBe(["sales", "inbox"].includes(t.id) ? "routine" : "task");
      expect(t.toolMode).toBe(t.id === "research" ? "browser" : "both");
      expect(t.requireApproval).toBe(["ci", "email", "deps"].includes(t.id));
      expect(t.schedule).toBe(
        t.id === "sales" ? WHEN_SCHEDULES.weekly : t.id === "inbox" ? WHEN_SCHEDULES.daily : null,
      );
    }
    expect(await c.request("templates.use", { id: "ci" })).toEqual({
      templateId: "ci",
      prompt: templates[0]!.prompt,
      toolMode: "both",
      requireApproval: true,
      when: "now",
      schedule: null,
    });
    expect((await c.request("templates.use", { id: "sales" })).when).toBe("weekly");
    const user = await c.request("templates.create", {
      kind: "task",
      name: " Custom ",
      prompt: " test ",
    });
    expect(user.name).toBe("Custom");
    await c.waitForEventWhere("templates.changed", (e) => e.id === user.id);
    expect((await c.request("templates.list", {})).at(-1)?.id).toBe(user.id);
    expect(
      (await c.request("templates.update", { id: user.id, kind: "routine", schedule: "every 2h" }))
        .kind,
    ).toBe("routine");
    expect((await c.request("templates.use", { id: user.id })).when).toBeNull();
    await c.request("templates.delete", { id: user.id });
    await expect(c.request("templates.use", { id: user.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await c.request("templates.delete", { id: "ci" });
    expect((await c.request("templates.list", {})).some((t) => t.id === "ci")).toBe(false);
    expect((await c.request("templates.list", { includeHidden: true }))[0]?.hidden).toBe(true);
    expect((await c.request("templates.restore", { id: "ci" })).hidden).toBe(false);
    for (const params of [
      { kind: "routine", name: "x", prompt: "x" },
      { kind: "task", name: "x", prompt: "x", schedule: "daily 08:00" },
      { kind: "routine", name: "x", prompt: "x", schedule: "invalid" },
      { kind: "task", name: " ", prompt: "x" },
      { kind: "task", name: "x", prompt: "x", unknown: true },
    ])
      await expect(c.request("templates.create", params)).rejects.toMatchObject({
        code: "bad_request",
      });
    const bot = await c.request("agents.create", {
      name: "Scheduler",
      provider: "devin",
      instructions: "",
    });
    for (const params of [{ schedule: "daily 08:00", runAt: Date.now() + 60_000 }, { runAt: 1 }])
      await expect(
        c.request("routines.create", { agentId: bot.id, name: "x", prompt: "x", ...params }),
      ).rejects.toMatchObject({ code: "bad_request" });
  } finally {
    await stopDaemon(daemon, c);
    for (const path of [data, root]) rmSync(path, { recursive: true, force: true });
  }
}, 30_000);

test("one-shot routines create tasks once, retain runAt and record sink errors", () => {
  const data = tmp("oneshot-data-");
  const root = tmp("oneshot-bots-");
  const db = openDatabase(data);
  try {
    const agents = new AgentStore(db, root);
    const bot = agents.create({ name: "Scheduler", provider: "devin", instructions: "" });
    const routines = new RoutineService(
      db,
      agents,
      () => {
        throw new Error("fallback must not run");
      },
      () => {},
    );
    const calls: unknown[] = [];
    routines.setTaskSink({
      create(p) {
        calls.push(p);
        return { taskId: "task-1", queueId: null };
      },
    });
    const runAt = Date.now() + 60_000;
    const r = routines.create({
      agentId: bot.id,
      name: "Once",
      prompt: "Hello",
      runAt,
      toolMode: "browser",
      requireApproval: true,
      private: true,
      templateId: "research",
    });
    routines.tick(runAt - 1);
    expect(calls).toHaveLength(0);
    routines.tick(runAt);
    routines.tick(runAt + 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentId: bot.id,
      prompt: "Hello",
      title: "Once",
      toolMode: "browser",
      requireApproval: true,
      private: true,
      templateId: "research",
      routineId: r.id,
      trigger: "schedule",
    });
    expect(routines.get(r.id)).toMatchObject({ enabled: false, nextRunAt: null, runAt });
    expect(routines.runs(r.id)).toHaveLength(1);
    expect(routines.runs(r.id)[0]).toMatchObject({ taskId: "task-1", error: null });
    expect(routines.update({ id: r.id, schedule: "daily 08:00" }).runAt).toBeNull();
    expect(routines.update({ id: r.id, runAt }).schedule).toBeNull();
    expect(() => routines.update({ id: r.id, runAt, schedule: "daily 08:00" })).toThrow(
      "mutually exclusive",
    );
    routines.setTaskSink({
      create() {
        throw new Error("sink failed");
      },
    });
    expect(routines.run(r.id, "manual")).toMatchObject({
      taskId: null,
      queueId: null,
      error: "sink failed",
    });
  } finally {
    db.close();
    for (const path of [data, root]) rmSync(path, { recursive: true, force: true });
  }
});
