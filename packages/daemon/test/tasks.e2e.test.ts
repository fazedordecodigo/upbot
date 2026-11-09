import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Approval, ChatItem, Task } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

const TOKEN = `tasks-test-${crypto.randomUUID()}`;
const T = 60_000;

describe("tasks e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let b: Agent;

  const newAgent = (name: string) =>
    c.request("agents.create", { name, provider: "devin", instructions: "" });

  async function waitTask(id: string, pred: (t: Task) => boolean, ms = 30_000): Promise<Task> {
    const deadline = Date.now() + ms;
    for (;;) {
      const t = await c.request("tasks.get", { id });
      if (pred(t)) return t;
      if (Date.now() > deadline) throw new Error(`task ${id} stuck in ${t.situation}`);
      await Bun.sleep(50);
    }
  }

  async function taskItems(id: string): Promise<ChatItem[]> {
    return (await c.request("tasks.history", { id })).items;
  }

  const agentTexts = (items: ChatItem[]) =>
    items.filter((i) => i.kind === "agent_message").map((i) => ("text" in i ? i.text : ""));

  /** Text streamed only to the task's subscribed view. */
  function firstReply(taskId: string): Promise<string> {
    return c
      .waitForEventWhere(
        "task.event",
        (e) =>
          e.taskId === taskId &&
          e.event === "item.created" &&
          (e.data as ChatItem).kind === "agent_message",
        30_000,
      )
      .then((e) => {
        const item = e.data as ChatItem;
        return "text" in item ? item.text : "";
      });
  }

  beforeAll(async () => {
    dataDir = tmp("tasks-data-");
    agentsRoot = tmp("tasks-agents-");
    stateDir = tmp("tasks-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_CANCEL_GRACE_MS: "2000",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = await newAgent("Alpha");
    b = await newAgent("Beta");
  }, T);

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir]) await removeDir(dir);
  }, T);

  test(
    "routine attachments survive restart and reach every run with routine metadata",
    async () => {
      const files = [
        {
          name: "report.txt",
          mime: "text/plain",
          dataBase64: Buffer.from("saved report").toString("base64"),
        },
      ];
      await expect(
        c.request("routines.create", {
          agentId: b.id,
          name: "Too many",
          prompt: "echo:x",
          schedule: "daily 08:00",
          attachments: Array.from({ length: 11 }, () => files[0]!),
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        c.request("routines.create", {
          agentId: b.id,
          name: "Too large",
          prompt: "echo:x",
          schedule: "daily 08:00",
          attachments: [
            { ...files[0]!, dataBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") },
          ],
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const routine = await c.request("routines.create", {
        agentId: b.id,
        name: "Saved report",
        prompt: "echo:report",
        schedule: "daily 08:00",
        attachments: files,
        requireApproval: true,
      });
      await stopDaemon(daemon, c, stateDir);
      daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
        BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
        FAKE_ACP_STATE_DIR: stateDir,
      });
      c = await DaemonClient.connect(daemon.port, TOKEN);
      for (let i = 0; i < 2; i++) {
        const run = await c.request("routines.run", { id: routine.id });
        expect(run.error).toBeNull();
        await waitTask(run.taskId!, (task) => task.situation === "done");
        const item = (await taskItems(run.taskId!)).find((item) => item.kind === "user_message");
        if (!item || item.kind !== "user_message") throw new Error("missing user message");
        expect(item.routine).toEqual({ id: routine.id, name: routine.name, trigger: "manual" });
        expect(item.attachments).toHaveLength(1);
        expect(item.attachments![0]!.path.startsWith(join(b.workspacePath, "attachments"))).toBe(
          true,
        );
        expect(readFileSync(item.attachments![0]!.path, "utf8")).toBe("saved report");
        expect((await c.request("tasks.get", { id: run.taskId! })).requireApproval).toBe(true);
      }
      const prompt = readLog(stateDir)
        .filter((entry) => entry.method === "session/prompt")
        .at(-1);
      expect(JSON.stringify(prompt?.params)).toContain("<attachments>");
      expect(JSON.stringify(prompt?.params)).toContain('name=\\"Saved report\\"');
      await c.request("routines.delete", { id: routine.id });
    },
    T,
  );

  test(
    "removing queued instructions finishes only idle tasks with no remaining work",
    async () => {
      await c.request("queue.pause", { agentId: b.id });
      try {
        const task = await c.request("tasks.create", { agentId: b.id, text: "echo:removed" });
        const next = await c.request("tasks.instruct", { id: task.id, text: "echo:remaining" });
        const initial = (await c.request("queue.get", { agentId: b.id })).items.find(
          (i) => i.taskId === task.id && i.id !== next.queueId,
        );
        expect(initial).toBeDefined();
        await c.request("queue.remove", { queueId: initial!.id });
        expect((await c.request("tasks.get", { id: task.id })).situation).toBe("run");

        const updated = c.waitForEventWhere(
          "task.updated",
          (t) => t.id === task.id && t.situation === "done",
        );
        await c.request("queue.remove", { queueId: next.queueId });
        expect(await updated).toMatchObject({ outcome: "stopped", sessionId: null });
        const done = await c.request("tasks.get", { id: task.id });
        expect(done.endedAt).not.toBeNull();
        expect((await c.request("tasks.history", { id: task.id })).turns).toEqual([]);

        const hidden = await c.request("tasks.create", {
          agentId: b.id,
          text: "echo:private removed",
          private: true,
        });
        await c.request("tasks.stop", { id: hidden.id });
        expect(await c.request("tasks.get", { id: hidden.id })).toMatchObject({
          situation: "done",
          outcome: "stopped",
          prompt: "",
        });
        expect(
          (await c.request("tasks.list", { includePrivate: true })).items.map((t) => t.id),
        ).not.toContain(hidden.id);
      } finally {
        await c.request("queue.resume", { agentId: b.id });
      }

      const running = await c.request("tasks.create", {
        agentId: b.id,
        text: "slow",
        requireApproval: false,
      });
      await waitTask(running.id, (t) => t.sessionId !== null);
      const followup = await c.request("tasks.instruct", { id: running.id, text: "echo:removed" });
      await c.request("queue.remove", { queueId: followup.queueId });
      expect((await c.request("tasks.get", { id: running.id })).situation).toBe("run");
      await c.request("tasks.stop", { id: running.id });
      await c.waitForEventWhere("turn.ended", (t) => t.taskId === running.id, 30_000);
    },
    T,
  );

  test(
    "routine runs create tasks with saved policy and routine prompt metadata",
    async () => {
      await c.request("queue.pause", { agentId: b.id });
      try {
        const routine = await c.request("routines.create", {
          agentId: b.id,
          name: "Routine integration",
          prompt: "echo:routine",
          schedule: "daily 08:00",
          templateId: "research",
          toolMode: "browser",
          private: true,
          requireApproval: true,
        });
        const run = await c.request("routines.run", { id: routine.id });
        expect(run.error).toBeNull();
        expect(run.taskId).not.toBeNull();
        expect(run.queueId).not.toBeNull();
        const task = await c.request("tasks.get", { id: run.taskId! });
        expect(task).toMatchObject({
          agentId: b.id,
          title: routine.name,
          routineId: routine.id,
          templateId: "research",
          toolMode: "browser",
          private: true,
          requireApproval: true,
        });
        expect(await c.request("routines.runs", { id: routine.id })).toEqual([]);
        await c.request("queue.resume", { agentId: b.id });
        await waitTask(task.id, (t) => t.situation === "done");
        const prompt = readLog(stateDir).find(
          (l) =>
            l.method === "session/prompt" &&
            JSON.stringify(l.params).includes('name=\\"Routine integration\\"'),
        );
        expect(prompt).toBeDefined();
        await c.request("routines.delete", { id: routine.id });
      } finally {
        await c.request("queue.resume", { agentId: b.id });
      }
    },
    T,
  );

  test(
    "create -> run -> done in a fresh task session, with events in order and a message delivery",
    async () => {
      const start = c.events.length;
      // agentId omitted: the default (oldest) agent takes the task
      const task = await c.request("tasks.create", {
        text: "echo:relatório pronto\nsegunda linha",
        requireApproval: false,
      });
      expect(task).toMatchObject({
        agentId: a.id,
        title: "echo:relatório pronto",
        situation: "run",
        outcome: null,
        private: false,
        toolMode: "both",
        requireApproval: false,
        routineId: null,
        templateId: null,
        endedAt: null,
      });
      const done = await waitTask(task.id, (t) => t.situation === "done");
      expect(done.outcome).toBe("completed");
      expect(done.endedAt).not.toBeNull();
      expect(done.sessionId).toBeTruthy();
      expect(done.deliveryCount).toBe(1);

      const items = await taskItems(task.id);
      expect(items.map((i) => i.kind)).toEqual(["user_message", "agent_message"]);
      expect(items.every((i) => i.taskId === task.id)).toBe(true);
      const { turns } = await c.request("tasks.history", { id: task.id });
      expect(turns.map((t) => t.taskId)).toEqual([task.id]);

      const ev = c.events.slice(start);
      const at = (pred: (e: { event: string; data: unknown }) => boolean) => ev.findIndex(pred);
      const created = at((e) => e.event === "task.created" && (e.data as Task).id === task.id);
      const started = at(
        (e) => e.event === "turn.started" && (e.data as { taskId?: string }).taskId === task.id,
      );
      const ended = at(
        (e) => e.event === "turn.ended" && (e.data as { taskId?: string }).taskId === task.id,
      );
      const delivery = at(
        (e) => e.event === "task.delivery" && (e.data as { taskId: string }).taskId === task.id,
      );
      const finished = at(
        (e) =>
          e.event === "task.updated" &&
          (e.data as Task).id === task.id &&
          (e.data as Task).situation === "done",
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(created).toBeLessThan(started);
      expect(started).toBeLessThan(ended);
      expect(ended).toBeLessThan(delivery);
      expect(delivery).toBeLessThan(finished);

      const deliveries = await c.request("tasks.deliveries", { taskId: task.id });
      expect(deliveries).toEqual([
        expect.objectContaining({
          kind: "message",
          name: "relatório pronto",
          path: null,
          mime: "text/markdown",
        }),
      ]);

      // the task's first prompt carries the task context in a brand-new session
      const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
      const text = JSON.stringify(prompts.at(-1)?.params);
      expect(text).toContain("<task_context>");
      expect(text).toContain(JSON.stringify(join(a.workspacePath, "tasks", task.id)).slice(1, -1));

      const list = await c.request("tasks.list", { agentId: a.id });
      expect(list.items.map((t) => t.id)).toContain(task.id);
      expect(
        (await c.request("tasks.list", { agentId: b.id })).items.map((t) => t.id),
      ).not.toContain(task.id);
      const chat = await c.request("chat.history", { agentId: a.id });
      expect(chat.items.some((i) => i.taskId === task.id)).toBe(true);
    },
    T,
  );

  test(
    "pause cancels the turn and keeps the task muted; resume continues in the same session",
    async () => {
      const task = await c.request("tasks.create", {
        agentId: b.id,
        text: "slow",
        requireApproval: false,
      });
      const started = await waitTask(task.id, (t) => t.sessionId !== null);
      const paused = await c.request("tasks.pause", { id: task.id });
      expect(paused.situation).toBe("muted");
      await c.waitForEventWhere(
        "turn.ended",
        (t) => t.taskId === task.id && t.status === "cancelled",
        30_000,
      );
      expect((await c.request("tasks.get", { id: task.id })).situation).toBe("muted");
      // the agent's own queue is not paused by a task pause
      expect((await c.request("queue.get", { agentId: b.id })).paused).toBe(false);

      const resumed = await c.request("tasks.resume", { id: task.id });
      expect(resumed.situation).toBe("run");
      const done = await waitTask(task.id, (t) => t.situation === "done");
      expect(done.outcome).toBe("completed");
      expect(done.sessionId).toBe(started.sessionId);
      const texts = (await taskItems(task.id))
        .filter((i) => i.kind === "user_message")
        .map((i) => ("text" in i ? i.text : ""));
      expect(texts).toEqual(["slow", "Continuar de onde parou"]);
    },
    T,
  );

  test(
    "stop ends the task for good, records output files and rejects new instructions",
    async () => {
      const task = await c.request("tasks.create", {
        agentId: b.id,
        text: "slow",
        requireApproval: false,
      });
      await waitTask(task.id, (t) => t.sessionId !== null);
      const out = join(b.workspacePath, "tasks", task.id);
      mkdirSync(join(out, "sub"), { recursive: true });
      writeFileSync(join(out, "sub", "relatorio.pdf"), "%PDF-1.4 fake");
      const stopped = await c.request("tasks.stop", { id: task.id });
      expect(stopped).toMatchObject({ situation: "done", outcome: "stopped" });
      const file = await c.waitForEventWhere(
        "task.delivery",
        (d) => d.taskId === task.id && d.kind === "file",
        30_000,
      );
      expect(file).toMatchObject({
        name: "relatorio.pdf",
        path: join(out, "sub", "relatorio.pdf"),
        mime: "application/pdf",
        size: 13,
      });
      const after = await waitTask(task.id, (t) => t.deliveryCount === 1);
      expect(after).toMatchObject({ situation: "done", outcome: "stopped" });
      await expect(
        c.request("tasks.instruct", { id: task.id, text: "echo:more" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(c.request("tasks.resume", { id: task.id })).rejects.toMatchObject({
        code: "bad_request",
      });
    },
    T,
  );

  test(
    "a pending permission makes the task wait; an instruction queues without cancelling",
    async () => {
      const task = await c.request("tasks.create", {
        agentId: a.id,
        text: "tool",
        requireApproval: false,
      });
      const perm = await c.waitForEventWhere("permission.requested", (p) => p.agentId === a.id);
      await waitTask(task.id, (t) => t.situation === "wait");
      const { queueId } = await c.request("tasks.instruct", { id: task.id, text: "echo:depois" });
      const q = await c.request("queue.get", { agentId: a.id });
      expect(q.items.find((i) => i.id === queueId)?.taskId).toBe(task.id);
      expect((await c.request("tasks.get", { id: task.id })).situation).toBe("wait");
      await c.request("permissions.respond", { requestId: perm.requestId, optionId: "allow_once" });
      const done = await waitTask(task.id, (t) => t.situation === "done");
      expect(done.outcome).toBe("completed");
      const items = await taskItems(task.id);
      expect(agentTexts(items)).toEqual(["permission:allow_once", "depois"]);
      const { turns } = await c.request("tasks.history", { id: task.id });
      expect(turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    },
    T,
  );

  test(
    "private tasks stay out of list, history, search, deliveries and memories",
    async () => {
      const live = await c.request("tasks.create", {
        agentId: b.id,
        text: "slow",
        private: true,
        requireApproval: false,
      });
      await waitTask(live.id, (t) => t.sessionId !== null);
      expect((await c.request("tasks.list", {})).items.map((t) => t.id)).not.toContain(live.id);
      expect(
        (await c.request("tasks.list", { includePrivate: true })).items.map((t) => t.id),
      ).not.toContain(live.id);
      await c.request("tasks.stop", { id: live.id });

      await c.request("queue.pause", { agentId: b.id });
      const task = await c.request("tasks.create", {
        agentId: b.id,
        text: "mcp-list",
        private: true,
        requireApproval: false,
      });
      await c.request("tasks.subscribe", { id: task.id, watch: true });
      const replying = firstReply(task.id);
      await c.request("queue.resume", { agentId: b.id });
      const reply = await replying;
      expect(reply).toContain("send_message");
      expect(reply).not.toContain("remember");
      const done = await waitTask(task.id, (t) => t.situation === "done");
      expect(done).toMatchObject({ outcome: "completed", private: true, deliveryCount: 0 });
      await waitTask(live.id, (t) => t.prompt === "");

      for (const id of [live.id, task.id]) {
        expect(
          (await c.request("tasks.list", { includePrivate: true })).items.map((t) => t.id),
        ).not.toContain(id);
        expect(await taskItems(id)).toEqual([]);
        expect(await c.request("tasks.deliveries", { taskId: id })).toEqual([]);
        const chat = await c.request("chat.history", { agentId: b.id });
        expect(chat.items.some((i) => i.taskId === id)).toBe(false);
      }
      expect((await c.request("tasks.search", { query: "mcp-list" })).tasks).toEqual([]);
      expect((await c.request("tasks.get", { id: task.id })).prompt).toBe("");
    },
    T,
  );

  test(
    "toolMode filters tools/list and rejects forbidden tools/call and ACP permissions",
    async () => {
      const term = await c.request("tasks.create", {
        agentId: a.id,
        text: "mcp-list",
        toolMode: "terminal",
        requireApproval: false,
      });
      await waitTask(term.id, (t) => t.situation === "done");
      const termTools = agentTexts(await taskItems(term.id)).join("");
      expect(termTools).toContain("share_file");
      expect(termTools).not.toContain("browser_open");
      expect(termTools).not.toContain("computer_click");

      const browser = await c.request("tasks.create", {
        agentId: a.id,
        text: "mcp-list",
        toolMode: "browser",
        requireApproval: false,
      });
      await waitTask(browser.id, (t) => t.situation === "done");
      const browserTools = agentTexts(await taskItems(browser.id)).join("");
      expect(browserTools).toContain("browser_open");
      expect(browserTools).not.toContain("share_file");
      expect(browserTools).not.toContain("computer_click");

      const forbidden = await c.request("tasks.create", {
        agentId: a.id,
        text: 'mcp:browser_open {"url":"https://example.com"}',
        toolMode: "terminal",
        requireApproval: false,
      });
      await waitTask(forbidden.id, (t) => t.situation === "done");
      expect(agentTexts(await taskItems(forbidden.id)).join("")).toContain(
        "browser_open is not available in this task",
      );

      // a provider-native execute permission is rejected under browser-only
      const exec = await c.request("tasks.create", {
        agentId: a.id,
        text: "tool",
        toolMode: "browser",
        requireApproval: false,
      });
      await waitTask(exec.id, (t) => t.situation === "done");
      expect(agentTexts(await taskItems(exec.id))).toEqual(["permission:reject_once"]);
      expect((await c.request("permissions.list", {})).length).toBe(0);

      // the plain chat session keeps every tool
      const { queueId } = await c.request("chat.send", { agentId: a.id, text: "mcp-list" });
      const turn = await c.waitForEventWhere("turn.ended", (t) => t.queueId === queueId, 30_000);
      expect(turn.taskId).toBeUndefined();
      const chat = await c.request("chat.history", { agentId: a.id });
      const reply = chat.items.filter((i) => i.turnId === turn.id && i.kind === "agent_message");
      expect(agentTexts(reply).join("")).toContain("computer_click");
    },
    T,
  );

  test(
    "requireApproval asks before a send-like tool; without it the call goes straight through",
    async () => {
      const call = `mcp:send_message ${JSON.stringify({ to: "Beta", text: "echo:oi" })}`;
      const task = await c.request("tasks.create", { agentId: a.id, text: call });
      expect(task.requireApproval).toBe(true);
      const approval = await c.waitForEventWhere(
        "approval.updated",
        (ap) => ap.status === "pending" && ap.agentId === a.id,
        30_000,
      );
      expect(approval.tool).toBe("send_message");
      await waitTask(task.id, (t) => t.situation === "wait");
      await c.request("approvals.respond", { id: approval.id, decision: "approve" });
      const done = await waitTask(task.id, (t) => t.situation === "done");
      expect(done.outcome).toBe("completed");
      expect(agentTexts(await taskItems(task.id)).join("")).toContain("queued for Beta");

      const before = (await c.request("approvals.list", {})).length;
      const free = await c.request("tasks.create", {
        agentId: a.id,
        text: call,
        requireApproval: false,
      });
      await waitTask(free.id, (t) => t.situation === "done");
      expect(agentTexts(await taskItems(free.id)).join("")).toContain("queued for Beta");
      expect((await c.request("approvals.list", {})).length).toBe(before);
    },
    T,
  );

  test(
    "ambiguous bridge calls intersect policies including restrictive extra instances",
    async () => {
      const agent = await c.request("agents.create", {
        name: "Concurrent policies",
        provider: "devin",
        maxInstances: 2,
        requireApproval: false,
      });
      const primary = await c.request("tasks.create", {
        agentId: agent.id,
        text: "slow",
        toolMode: "browser",
        requireApproval: false,
      });
      await waitTask(primary.id, (t) => t.sessionId !== null);
      const extra = await c.request("tasks.create", {
        agentId: agent.id,
        text: "slow",
        toolMode: "terminal",
        private: true,
        requireApproval: true,
      });
      try {
        await c.request("tasks.subscribe", { id: extra.id, watch: true });
        await c.waitForEventWhere(
          "task.event",
          (e) =>
            e.taskId === extra.id &&
            e.event === "item.created" &&
            (e.data as ChatItem).kind === "agent_message",
        );
        const turns = (await c.request("agents.overview", {})).agents.find(
          (a) => a.agentId === agent.id,
        );
        expect(turns?.running).toHaveLength(1);
        const request = readLog(stateDir).find(
          (r) =>
            r.method === "session/new" && (r.params as { cwd: string }).cwd === agent.workspacePath,
        );
        if (!request) throw new Error("missing session request");
        const spec = (
          request.params as {
            mcpServers: { name: string; env: { name: string; value: string }[] }[];
          }
        ).mcpServers.find((s) => s.name === "boto");
        const env = Object.fromEntries(spec!.env.map((e) => [e.name, e.value]));
        const bridge = async (method: string, params = {}) => {
          const response = await fetch(env.BOTO_BRIDGE_URL!, {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.BOTO_BRIDGE_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ method, params }),
          });
          expect(response.ok).toBe(true);
          return response.json();
        };
        const listed = await bridge("tools/list");
        const names = listed.tools.map((t: { name: string }) => t.name);
        expect(names).not.toContain("remember");
        expect(names).not.toContain("share_file");
        expect(names).not.toContain("browser_open");
        for (const name of ["remember", "share_file", "browser_open"])
          expect(await bridge("tools/call", { name, arguments: {} })).toMatchObject({
            isError: true,
          });
        expect(await c.request("memories.list", { agentId: agent.id })).toEqual([]);
        const sending = await bridge("tools/call", {
          name: "send_message",
          arguments: { to: "Beta", text: "must not send" },
        });
        expect(sending).toMatchObject({ isError: true });
        expect(JSON.stringify(sending)).toContain("unambiguous private task context");
        expect(await c.request("approvals.list", { agentId: agent.id })).toEqual([]);
        expect(await c.request("approvals.list", { taskId: extra.id })).toEqual([]);
        await c.request("tasks.stop", { id: extra.id });
        await c.waitForEventWhere(
          "task.event",
          (event) => event.taskId === extra.id && event.event === "turn.ended",
        );
        const restored = (await bridge("tools/list")).tools.map((t: { name: string }) => t.name);
        expect(restored).toContain("remember");
        expect(restored).toContain("browser_open");
        expect(restored).not.toContain("share_file");
      } finally {
        await c.request("agents.delete", { id: agent.id });
      }
    },
    T,
  );

  test(
    "search, rename, deliveries and list pagination",
    async () => {
      const task = await c.request("tasks.create", {
        agentId: b.id,
        text: "echo:Relatório de vendas",
        requireApproval: false,
        templateId: "tpl-vendas",
      });
      await waitTask(task.id, (t) => t.situation === "done");
      const routine = await c.request("routines.create", {
        agentId: b.id,
        name: "Relatório semanal",
        prompt: "echo:semana",
        enabled: false,
      });
      const found = await c.request("tasks.search", { query: "relatorio" });
      expect(found.tasks.map((t) => t.id)).toContain(task.id);
      expect(found.routines.map((r) => r.id)).toContain(routine.id);
      expect((await c.request("tasks.search", { query: "beta vendas" })).tasks[0]?.id).toBe(
        task.id,
      );

      const renamed = await c.request("tasks.rename", { id: task.id, title: "Vendas do mês" });
      expect(renamed).toMatchObject({ title: "Vendas do mês", templateId: "tpl-vendas" });
      await c.waitForEventWhere(
        "task.updated",
        (t) => t.id === task.id && t.title === "Vendas do mês",
      );

      const recent = await c.request("tasks.deliveries", { limit: 1 });
      expect(recent[0]).toMatchObject({ taskId: task.id, kind: "message" });

      const page1 = await c.request("tasks.list", { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await c.request("tasks.list", { limit: 2, cursor: page1.nextCursor ?? "" });
      expect(page2.items.map((t) => t.id)).not.toContain(page1.items[0]?.id);
      const done = await c.request("tasks.list", { situation: "done", limit: 200 });
      expect(done.items.every((t) => t.situation === "done" && !t.private)).toBe(true);

      await expect(c.request("tasks.get", { id: "missing" })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        c.request("tasks.create", { agentId: "missing", text: "echo:x" }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
    T,
  );
});

describe("tasks across a daemon restart", () => {
  test(
    "a running task becomes paused and resumes in its own provider session",
    async () => {
      const dataDir = tmp("tasks-rs-data-");
      const agentsRoot = tmp("tasks-rs-agents-");
      const stateDir = tmp("tasks-rs-fake-");
      const env = {
        BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
        FAKE_ACP_STATE_DIR: stateDir,
      };
      let d = await startDaemon(dataDir, agentsRoot, TOKEN, env);
      let c = await DaemonClient.connect(d.port, TOKEN);
      try {
        const agent = await c.request("agents.create", {
          name: "Gamma",
          provider: "devin",
          instructions: "",
        });
        const task = await c.request("tasks.create", {
          agentId: agent.id,
          text: "slow",
          requireApproval: false,
        });
        let sessionId: string | null = null;
        for (let i = 0; i < 200 && !sessionId; i++) {
          sessionId = (await c.request("tasks.get", { id: task.id })).sessionId;
          if (!sessionId) await Bun.sleep(50);
        }
        expect(sessionId).toBeTruthy();
        await stopDaemon(d, c, stateDir);

        d = await startDaemon(dataDir, agentsRoot, TOKEN, env);
        c = await DaemonClient.connect(d.port, TOKEN);
        const after = await c.request("tasks.get", { id: task.id });
        expect(after).toMatchObject({ situation: "muted", outcome: null, sessionId });
        await c.request("tasks.resume", { id: task.id });
        const turn = await c.waitForEventWhere("turn.ended", (t) => t.taskId === task.id, 30_000);
        expect(turn.status).toBe("completed");
        const loads = readLog(stateDir).filter((l) => l.method === "session/load");
        expect(loads.map((l) => (l.params as { sessionId: string }).sessionId)).toContain(
          sessionId as string,
        );

        const { queueId } = await c.request("chat.send", { agentId: agent.id, text: "echo:chat" });
        const chatTurn = await c.waitForEventWhere(
          "turn.ended",
          (t) => t.queueId === queueId,
          30_000,
        );
        expect(chatTurn.taskId).toBeUndefined();
        const news = readLog(stateDir).filter((l) => l.method === "session/new");
        expect(news.length).toBe(2);
        expect((await c.request("tasks.get", { id: task.id })).sessionId).toBe(sessionId);

        await c.request("queue.pause", { agentId: agent.id });
        const queued = await c.request("tasks.create", { agentId: agent.id, text: "echo:queued" });
        const entry = (await c.request("queue.get", { agentId: agent.id })).items[0]!;
        await stopDaemon(d, c, stateDir);
        d = await startDaemon(dataDir, agentsRoot, TOKEN, env);
        c = await DaemonClient.connect(d.port, TOKEN);
        expect((await c.request("tasks.get", { id: queued.id })).situation).toBe("run");
        const queueUpdated = c.waitForEventWhere("queue.updated", (q) => q.agentId === agent.id);
        await c.request("queue.remove", { queueId: entry.id });
        expect((await queueUpdated).items).toEqual([]);
        expect(await c.request("tasks.get", { id: queued.id })).toMatchObject({
          situation: "done",
          outcome: "stopped",
          sessionId: null,
        });
        await stopDaemon(d, c, stateDir);
        d = await startDaemon(dataDir, agentsRoot, TOKEN, env);
        c = await DaemonClient.connect(d.port, TOKEN);
        expect(await c.request("tasks.get", { id: queued.id })).toMatchObject({
          situation: "done",
          outcome: "stopped",
        });
      } finally {
        await stopDaemon(d, c, stateDir);
        for (const dir of [dataDir, agentsRoot, stateDir]) await removeDir(dir);
      }
    },
    T,
  );
});
