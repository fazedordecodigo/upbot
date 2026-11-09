import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  Agent,
  Approval,
  ChatAttachment,
  ChatItem,
  MethodParsedParams,
  Routine,
  Task,
  TaskDefaults,
  TaskDelivery,
  TaskOutcome,
  TaskSituation,
  Turn,
} from "@boto/protocol";
import type { AgentStore } from "./agents";
import { attachmentsBlock, saveAttachments } from "./attachments";
import type { ChatStore, QueueSource, QueueStore } from "./chat-store";
import { errorFields, RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { TaskRuntimeHooks, TaskRuntimeInfo } from "./task-policy";

// Tasks: a first-class unit of work over an agent session. Each task runs in its own
// provider session (queue entries, turns and items carry task_id) and its situation is
// derived from runtime events: run (working or queued), wait (a permission or approval is
// pending for the task's running turn), muted (paused by the user) and done (outcome
// completed | stopped | failed). Private tasks never appear in history, search or
// deliveries, never save memories, and their items/texts are purged once done.

type Broadcast = (event: string, data: unknown) => void;

type TaskRow = {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  situation: string;
  outcome: string | null;
  private: number;
  tool_mode: string;
  require_approval: number;
  session_id: string | null;
  routine_id: string | null;
  template_id: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  delivery_count: number;
};

type DeliveryRow = {
  id: string;
  task_id: string;
  kind: string;
  name: string;
  path: string | null;
  url: string | null;
  mime: string | null;
  size: number | null;
  created_at: number;
};

const SELECT_TASK =
  "SELECT t.*, (SELECT COUNT(*) FROM task_deliveries d WHERE d.task_id = t.id) AS delivery_count FROM tasks t";

const TITLE_MAX = 80;
const DELIVERY_NAME_MAX = 120;
const MAX_SCAN_FILES = 500;
const MAX_SCAN_DEPTH = 4;
const SEARCH_CANDIDATES = 2000;

const CONTINUE_TEXT = "Continuar de onde parou";
const CONTINUE_PROMPT =
  "The user paused this task and has now resumed it. Continue where you left off.";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    prompt: r.prompt,
    situation: r.situation as TaskSituation,
    outcome: (r.outcome as TaskOutcome | null) ?? null,
    private: r.private === 1,
    toolMode: r.tool_mode as Task["toolMode"],
    requireApproval: r.require_approval === 1,
    sessionId: r.session_id,
    routineId: r.routine_id,
    templateId: r.template_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
    deliveryCount: r.delivery_count,
  };
}

function rowToDelivery(r: DeliveryRow): TaskDelivery {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind as TaskDelivery["kind"],
    name: r.name,
    path: r.path,
    url: r.url,
    mime: r.mime,
    size: r.size,
    createdAt: r.created_at,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** First non-empty line of the prompt, whitespace collapsed and truncated. */
export function taskTitle(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return truncate(line ?? "", TITLE_MAX);
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function encodeCursor(r: { created_at: number; id: string }): string {
  return Buffer.from(`${r.created_at}|${r.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = Number(ts);
  if (!id || !Number.isSafeInteger(createdAt)) throw new RpcError("bad_request", "invalid cursor");
  return { createdAt, id };
}

export class TaskService {
  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
    private deps: {
      pendingApprovals: () => Approval[];
      routines: () => Routine[];
      defaults: () => TaskDefaults;
    },
  ) {}

  // ---- Store ----

  private row(id: string): TaskRow | null {
    return this.db.query(`${SELECT_TASK} WHERE t.id = ?`).get(id) as TaskRow | null;
  }

  private mustRow(id: string): TaskRow {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "task not found");
    return r;
  }

  get(id: string): Task {
    return rowToTask(this.mustRow(id));
  }

  private emit(id: string): Task | null {
    const r = this.row(id);
    if (!r) return null;
    const task = rowToTask(r);
    this.broadcast("task.updated", task);
    return task;
  }

  private setState(
    id: string,
    situation: TaskSituation,
    outcome: TaskOutcome | null,
    endedAt: number | null,
  ): void {
    this.db
      .query(
        "UPDATE tasks SET situation = ?, outcome = ?, ended_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(situation, outcome, endedAt, Date.now(), id);
  }

  private outputDir(agent: Agent, taskId: string): string {
    return join(agent.workspacePath, "tasks", taskId);
  }

  // ---- Runtime hooks ----

  runtimeInfo(id: string): TaskRuntimeInfo | null {
    const r = this.row(id);
    return r
      ? {
          id: r.id,
          agentId: r.agent_id,
          toolMode: r.tool_mode as TaskRuntimeInfo["toolMode"],
          private: r.private === 1,
          requireApproval: r.require_approval === 1,
          sessionId: r.session_id,
        }
      : null;
  }

  hooks(): TaskRuntimeHooks {
    return {
      get: (id) => this.runtimeInfo(id),
      setSession: (id, sessionId) => {
        const r = this.row(id);
        if (!r || r.session_id === sessionId) return;
        this.db
          .query("UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?")
          .run(sessionId, Date.now(), id);
        this.emit(id);
      },
      preamble: (id) => this.preamble(id),
    };
  }

  private preamble(id: string): string {
    const r = this.row(id);
    if (!r) return "";
    const agent = this.agents.get(r.agent_id);
    const lines = ["This message starts a Boto task."];
    if (agent)
      lines.push(
        `Save every file you produce for the user in this folder: ${this.outputDir(agent, r.id)}`,
      );
    if (r.tool_mode === "browser")
      lines.push(
        "Work only in the browser (websites, email, dashboards and online spreadsheets). Do not run terminal commands and do not edit files: those tools are unavailable and their calls are rejected.",
      );
    else if (r.tool_mode === "terminal")
      lines.push(
        "Work only in the terminal (code, scripts and files). Do not browse the web: browser tools are unavailable and their calls are rejected.",
      );
    if (r.require_approval === 1)
      lines.push(
        "The user asked to approve every external action (sending, publishing, paying, booking, deleting) before it happens.",
      );
    if (r.private === 1)
      lines.push("This task is private: do not save memories about it or its content.");
    return `<task_context>\n${lines.join("\n")}\n</task_context>\n\n`;
  }

  /** Startup: live tasks whose turn died with the previous daemon become paused. */
  recover(): void {
    const rows = this.db.query("SELECT id FROM tasks WHERE situation IN ('run', 'wait')").all() as {
      id: string;
    }[];
    for (const { id } of rows) {
      if (this.queue.hasQueuedForTask(id)) {
        this.setState(id, "run", null, null);
      } else {
        this.setState(id, "muted", null, null);
      }
    }
  }

  /** Daemon events that move a task's situation. */
  onEvent(event: string, data: unknown): void {
    switch (event) {
      case "turn.started": {
        const taskId = (data as Turn).taskId;
        if (taskId) this.recompute(taskId);
        return;
      }
      case "turn.ended": {
        const turn = data as Turn;
        const taskId = turn.taskId;
        if (!taskId) return;
        // turn.ended fires before the runtime closes its streaming item
        this.runtimes().flushStreamText(turn.agentId);
        this.scanOutputs(taskId);
        this.recompute(taskId);
        this.purgeIfPrivateDone(taskId);
        return;
      }
      case "permission.requested":
      case "permission.resolved":
      case "approval.updated":
      case "queue.updated":
        this.recomputeAgent((data as { agentId: string }).agentId);
        return;
      case "agent.deleted":
        for (const id of this.liveIds((data as { id: string }).id)) this.stop(id);
        return;
    }
  }

  private liveIds(agentId: string, situations = ["run", "wait", "muted"]): string[] {
    const marks = situations.map(() => "?").join(",");
    return (
      this.db
        .query(`SELECT id FROM tasks WHERE agent_id = ? AND situation IN (${marks})`)
        .all(agentId, ...situations) as { id: string }[]
    ).map((r) => r.id);
  }

  private recomputeAgent(agentId: string): void {
    for (const id of this.liveIds(agentId, ["run", "wait"])) this.recompute(id);
  }

  private runningTurnId(taskId: string): string | null {
    const r = this.db
      .query("SELECT id FROM turns WHERE task_id = ? AND status = 'running' LIMIT 1")
      .get(taskId) as { id: string } | null;
    return r?.id ?? null;
  }

  private recompute(id: string): void {
    const r = this.row(id);
    if (!r || r.situation === "muted" || r.situation === "done") return;
    const turnId = this.runningTurnId(id);
    let next: TaskSituation;
    if (turnId) {
      const waiting =
        this.runtimes()
          .pendingPermissions()
          .some((p) => p.agentId === r.agent_id && p.turnId === turnId) ||
        this.deps
          .pendingApprovals()
          .some((a) => a.status === "pending" && a.agentId === r.agent_id && a.turnId === turnId);
      next = waiting ? "wait" : "run";
    } else if (this.queue.hasQueuedForTask(id)) {
      next = "run";
    } else {
      this.finish(id, this.lastTurnOutcome(id));
      return;
    }
    if (next === r.situation) return;
    this.setState(id, next, null, null);
    this.emit(id);
  }

  private lastTurn(taskId: string): { id: string; status: string } | null {
    return this.db
      .query(
        "SELECT id, status FROM turns WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(taskId) as { id: string; status: string } | null;
  }

  private lastTurnOutcome(taskId: string): TaskOutcome {
    const t = this.lastTurn(taskId);
    if (t?.status === "completed") return "completed";
    if (t?.status === "failed") return "failed";
    return "stopped";
  }

  private finish(id: string, outcome: TaskOutcome): void {
    const r = this.row(id);
    if (!r || r.situation === "done") return;
    this.setState(id, "done", outcome, Date.now());
    if (outcome === "completed" && r.private !== 1) {
      const last = this.lastTurn(id);
      const reply = last ? this.chat.finalReply(last.id) : "";
      if (reply) {
        const first = reply
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean);
        this.addDelivery(id, {
          kind: "message",
          name: truncate(first ?? r.title, DELIVERY_NAME_MAX),
          path: null,
          url: null,
          mime: "text/markdown",
          size: Buffer.byteLength(reply, "utf8"),
        });
      }
    }
    this.emit(id);
    this.purgeIfPrivateDone(id);
  }

  /** Private tasks keep no content once done and idle: items, queued texts and prompt go. */
  private purgeIfPrivateDone(id: string): void {
    const r = this.row(id);
    if (!r || r.private !== 1 || r.situation !== "done" || this.runningTurnId(id)) return;
    this.chat.purgeTaskItems(id);
    this.queue.purgeTaskTexts(id);
    this.db.query("UPDATE tasks SET prompt = '' WHERE id = ?").run(id);
  }

  // ---- Deliveries ----

  private addDelivery(taskId: string, d: Omit<TaskDelivery, "id" | "taskId" | "createdAt">): void {
    const delivery: TaskDelivery = {
      id: crypto.randomUUID(),
      taskId,
      createdAt: Date.now(),
      ...d,
    };
    this.db
      .query(
        "INSERT INTO task_deliveries (id, task_id, kind, name, path, url, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        delivery.id,
        taskId,
        delivery.kind,
        delivery.name,
        delivery.path,
        delivery.url,
        delivery.mime,
        delivery.size,
        delivery.createdAt,
      );
    this.broadcast("task.delivery", delivery);
  }

  /** Records new files in the task's output folder as file deliveries. */
  private scanOutputs(taskId: string): void {
    const r = this.row(taskId);
    if (!r || r.private === 1) return;
    const agent = this.agents.get(r.agent_id);
    if (!agent) return;
    const root = this.outputDir(agent, taskId);
    if (!existsSync(root)) return;
    const known = new Set(
      (
        this.db
          .query("SELECT path FROM task_deliveries WHERE task_id = ? AND kind = 'file'")
          .all(taskId) as { path: string }[]
      ).map((d) => d.path),
    );
    const found: { path: string; name: string; size: number }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_SCAN_DEPTH || found.length >= MAX_SCAN_FILES) return;
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of entries) {
        if (found.length >= MAX_SCAN_FILES) return;
        const path = join(dir, name);
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(path);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(path, depth + 1);
        else if (st.isFile() && !known.has(path)) found.push({ path, name, size: st.size });
      }
    };
    walk(root, 0);
    for (const f of found)
      this.addDelivery(taskId, {
        kind: "file",
        name: truncate(f.name, DELIVERY_NAME_MAX),
        path: f.path,
        url: null,
        mime: MIME[extname(f.name).toLowerCase()] ?? null,
        size: f.size,
      });
    if (found.length && r.situation !== "done") this.emit(taskId);
  }

  // ---- API ----

  create(
    p: MethodParsedParams<"tasks.create">,
    extra: {
      routineId?: string;
      title?: string;
      source?: Pick<QueueSource, "prompt" | "meta">;
      attachments?: ChatAttachment[];
    } = {},
  ): Task {
    const agent = p.agentId ? this.agents.get(p.agentId) : (this.agents.list()[0] ?? null);
    if (!agent) throw new RpcError("not_found", "agent not found");
    const defaults = this.deps.defaults();
    const saved =
      extra.attachments ??
      (p.attachments?.length ? saveAttachments(agent.workspacePath, p.attachments) : []);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO tasks (id, agent_id, title, prompt, situation, outcome, private, tool_mode,
           require_approval, session_id, routine_id, template_id, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, 'run', NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        agent.id,
        extra.title ?? taskTitle(p.text),
        p.text,
        (p.private ?? defaults.private ?? false) ? 1 : 0,
        p.toolMode ?? defaults.toolMode ?? "both",
        (p.requireApproval ?? defaults.requireApproval ?? true) ? 1 : 0,
        extra.routineId ?? null,
        p.templateId ?? null,
        now,
        now,
      );
    try {
      mkdirSync(this.outputDir(agent, id), { recursive: true });
    } catch (e) {
      console.error(`[botod] task output folder failed: task=${id} ${errorFields(e)}`);
    }
    this.broadcast("task.created", this.get(id));
    try {
      this.runtimes().sendFrom(agent.id, p.text, {
        agentId: null,
        hops: 0,
        taskId: id,
        ...extra.source,
        ...(saved.length
          ? {
              prompt: attachmentsBlock(saved) + (extra.source?.prompt ?? p.text),
              meta: { ...extra.source?.meta, attachments: saved },
            }
          : {}),
      });
    } catch (e) {
      this.finish(id, "failed");
      throw e;
    }
    return this.get(id);
  }

  list(p: MethodParsedParams<"tasks.list">): { items: Task[]; nextCursor: string | null } {
    const where: string[] = [
      p.includePrivate ? "(t.private = 0 OR t.situation != 'done')" : "t.private = 0",
    ];
    const args: (string | number)[] = [];
    if (p.situation) {
      where.push("t.situation = ?");
      args.push(p.situation);
    }
    if (p.agentId) {
      where.push("t.agent_id = ?");
      args.push(p.agentId);
    }
    if (p.cursor) {
      const c = decodeCursor(p.cursor);
      where.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
      args.push(c.createdAt, c.createdAt, c.id);
    }
    const limit = p.limit ?? 50;
    const rows = this.db
      .query(
        `${SELECT_TASK} WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as TaskRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(rowToTask),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  history(p: MethodParsedParams<"tasks.history">): {
    items: ChatItem[];
    turns: Turn[];
    hasMore: boolean;
  } {
    const r = this.mustRow(p.id);
    this.runtimes().flushStreamText(r.agent_id, p.before);
    const { items, hasMore } = this.chat.taskHistory(r.id, p.before, p.limit ?? 200);
    const turnIds = [...new Set(items.map((i) => i.turnId).filter((t): t is string => !!t))];
    return { items, turns: this.chat.turnsByIds(turnIds), hasMore };
  }

  /** Queues an instruction for the task without interrupting it; reopens a finished task. */
  instruct(id: string, text: string): { queueId: string; task: Task } {
    const r = this.mustRow(id);
    if (r.situation === "done" && r.outcome === "stopped")
      throw new RpcError("bad_request", "this task was stopped and cannot continue");
    const reopened = r.situation === "done";
    if (reopened) this.setState(id, "run", null, null);
    let queueId: string;
    try {
      ({ queueId } = this.runtimes().sendFrom(r.agent_id, text, {
        agentId: null,
        hops: 0,
        taskId: id,
      }));
    } catch (e) {
      if (reopened) this.setState(id, "done", r.outcome as TaskOutcome, r.ended_at);
      throw e;
    }
    this.db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    const task = this.emit(id) ?? this.get(id);
    return { queueId, task };
  }

  pause(id: string): Task {
    const r = this.mustRow(id);
    if (r.situation === "done") throw new RpcError("bad_request", "this task already ended");
    if (r.situation === "muted") return rowToTask(r);
    this.setState(id, "muted", null, null);
    const task = this.emit(id) ?? this.get(id);
    this.runtimes().cancelTask(r.agent_id, id);
    return task;
  }

  resume(id: string): Task {
    const r = this.mustRow(id);
    if (r.situation === "done") throw new RpcError("bad_request", "this task already ended");
    if (r.situation !== "muted") return rowToTask(r);
    this.setState(id, "run", null, null);
    const task = this.emit(id) ?? this.get(id);
    if (this.queue.hasQueuedForTask(id) || this.runningTurnId(id)) {
      this.runtimes().schedule(r.agent_id);
    } else {
      try {
        this.runtimes().sendFrom(r.agent_id, CONTINUE_TEXT, {
          agentId: null,
          hops: 0,
          taskId: id,
          prompt: CONTINUE_PROMPT,
        });
      } catch (e) {
        this.setState(id, "muted", null, null);
        this.emit(id);
        throw e;
      }
    }
    return task;
  }

  /** Ends the task for good: drops its queue and cancels its running turn. */
  stop(id: string): Task {
    const r = this.mustRow(id);
    if (r.situation === "done") return rowToTask(r);
    this.setState(id, "done", "stopped", Date.now());
    this.runtimes().removeTaskQueue(r.agent_id, id);
    this.runtimes().cancelTask(r.agent_id, id);
    const task = this.emit(id) ?? this.get(id);
    this.purgeIfPrivateDone(id);
    return task;
  }

  rename(id: string, title: string): Task {
    this.mustRow(id);
    this.db
      .query("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), id);
    return this.emit(id) ?? this.get(id);
  }

  /** Command palette search over non-private tasks (title, prompt, agent) and routines. */
  search(query: string, limit = 20): { tasks: Task[]; routines: Routine[] } {
    const tokens = fold(query).split(/\s+/).filter(Boolean);
    const names = new Map(this.agents.list().map((a) => [a.id, a.name]));
    const matches = (...fields: string[]) => {
      const hay = fold(fields.join(" "));
      return tokens.every((t) => hay.includes(t));
    };
    const rows = this.db
      .query(`${SELECT_TASK} WHERE t.private = 0 ORDER BY t.created_at DESC LIMIT ?`)
      .all(SEARCH_CANDIDATES) as TaskRow[];
    const tasks = rows
      .filter((r) => matches(r.title, r.prompt, names.get(r.agent_id) ?? ""))
      .slice(0, limit)
      .map(rowToTask);
    const routines = this.deps
      .routines()
      .filter((r) => matches(r.name, r.prompt, names.get(r.agentId) ?? ""))
      .slice(0, limit);
    return { tasks, routines };
  }

  deliveries(p: MethodParsedParams<"tasks.deliveries">): TaskDelivery[] {
    const rows = (
      p.taskId
        ? this.db
            .query(
              "SELECT d.* FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE t.private = 0 AND d.task_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?",
            )
            .all(p.taskId, p.limit ?? 20)
        : this.db
            .query(
              "SELECT d.* FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE t.private = 0 ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?",
            )
            .all(p.limit ?? 20)
    ) as DeliveryRow[];
    return rows.map(rowToDelivery);
  }
}
