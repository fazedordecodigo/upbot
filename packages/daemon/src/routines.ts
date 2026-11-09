import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type {
  ChatAttachment,
  MethodParsedParams,
  Routine,
  RoutineRun,
  RoutineTrigger,
  ToolMode,
} from "@boto/protocol";
import { ChatAttachment as AttachmentSchema } from "@boto/protocol";
import type { AgentStore } from "./agents";
import { attachmentsBlock, saveAttachments } from "./attachments";
import { envPositiveNumber } from "./env/vars";
import type { Broadcast } from "./rpc";
import { asBadRequest, RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";

// Routines: saved prompts sent to an agent on a schedule, via a local webhook, or manually.
// Schedules: "every <n>m|h|d", "daily HH:MM", "weekly mon..sun HH:MM" (local time).

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PAYLOAD_LIMIT = 20_000;

export function parseSchedule(s: string): (from: number) => number {
  const t = s.trim().toLowerCase();
  let m = /^every\s+(\d+)\s*(m|h|d)$/.exec(t);
  if (m) {
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    if (ms < 60_000) throw new Error("the shortest interval is 1 minute");
    return (from) => from + ms;
  }
  m = /^(daily|weekly\s+(sun|mon|tue|wed|thu|fri|sat))\s+(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const h = Number(m[3]);
    const min = Number(m[4]);
    if (h > 23 || min > 59) throw new Error("invalid time of day");
    const day = m[2] ? DAYS.indexOf(m[2]) : null;
    return (from) => {
      const d = new Date(from);
      d.setSeconds(0, 0);
      d.setHours(h, min);
      while (d.getTime() <= from || (day !== null && d.getDay() !== day))
        d.setDate(d.getDate() + 1);
      return d.getTime();
    };
  }
  throw new Error('schedule must look like "every 30m", "daily 09:00" or "weekly mon 09:00"');
}

type Row = {
  attachments: string;
  run_at: number | null;
  tool_mode: ToolMode;
  require_approval: number;
  private: number;
  template_id: string | null;
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string | null;
  webhook_token: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};
type RunRow = {
  task_id: string | null;
  queue_status?: RoutineRun["queueStatus"];
  turn_id?: string | null;
  turn_status?: NonNullable<RoutineRun["turn"]>["status"];
  turn_started_at?: number;
  turn_ended_at?: number | null;
  id: string;
  routine_id: string;
  trigger: string;
  queue_id: string | null;
  error: string | null;
  created_at: number;
};

export type WebhookAuth =
  | { kind: "ok"; routineId: string }
  | { kind: "notFound" }
  | { kind: "unauthorized"; known: boolean };

const toRun = (r: RunRow): RoutineRun => ({
  taskId: r.task_id,
  id: r.id,
  routineId: r.routine_id,
  trigger: r.trigger as RoutineTrigger,
  queueId: r.queue_id,
  queueStatus: r.queue_status ?? null,
  turn: r.turn_id
    ? {
        id: r.turn_id,
        status: r.turn_status!,
        startedAt: r.turn_started_at!,
        endedAt: r.turn_ended_at ?? null,
      }
    : null,
  error: r.error,
  createdAt: r.created_at,
});

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");

export interface RoutineTaskSink {
  create(p: {
    agentId: string;
    prompt: string;
    title: string;
    toolMode: ToolMode;
    requireApproval: boolean;
    private: boolean;
    routineId: string;
    templateId: string | null;
    trigger: RoutineTrigger;
    sendPrompt: string;
    attachments: ChatAttachment[];
  }): { taskId: string; queueId: string | null };
}

export class RoutineService {
  private taskSink: RoutineTaskSink | null = null;

  setTaskSink(sink: RoutineTaskSink): void {
    this.taskSink = sink;
  }
  baseUrl = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private agents: AgentStore,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
  ) {}

  private toRoutine(r: Row): Routine {
    return {
      attachments: AttachmentSchema.array().parse(JSON.parse(r.attachments)),
      runAt: r.run_at,
      toolMode: r.tool_mode,
      requireApproval: r.require_approval === 1,
      private: r.private === 1,
      templateId: r.template_id,
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      prompt: r.prompt,
      schedule: r.schedule,
      webhook: r.webhook_token !== null,
      webhookUrl: r.webhook_token ? `${this.baseUrl}/hooks/${r.id}` : null,
      webhookToken: r.webhook_token,
      enabled: r.enabled === 1,
      lastRunAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private row(id: string): Row | null {
    return this.db
      .query("SELECT * FROM routines WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | null;
  }

  exists(id: string): boolean {
    return this.row(id) !== null;
  }

  get(id: string): Routine {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "routine not found");
    return this.toRoutine(r);
  }

  list(agentId?: string): Routine[] {
    const rows = (
      agentId
        ? this.db
            .query(
              "SELECT * FROM routines WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
            )
            .all(agentId)
        : this.db
            .query("SELECT * FROM routines WHERE deleted_at IS NULL ORDER BY created_at ASC")
            .all()
    ) as Row[];
    return rows.map((r) => this.toRoutine(r));
  }

  private nextRun(
    schedule: string | null,
    enabled: boolean,
    from = Date.now(),
    runAt: number | null = null,
  ): number | null {
    if (!enabled) return null;
    if (runAt !== null) return runAt;
    if (!schedule) return null;
    return asBadRequest(() => parseSchedule(schedule)(from));
  }

  create(p: MethodParsedParams<"routines.create">): Routine {
    const agent = this.agents.get(p.agentId);
    if (!agent) throw new RpcError("not_found", "agent not found");
    const id = crypto.randomUUID();
    const now = Date.now();
    const schedule = p.schedule?.trim() || null;
    const runAt = p.runAt ?? null;
    if (schedule && runAt !== null)
      throw new RpcError("bad_request", "schedule and runAt are mutually exclusive");
    if (runAt !== null && runAt < now) throw new RpcError("bad_request", "runAt is in the past");
    if (schedule) asBadRequest(() => parseSchedule(schedule));
    const enabled = p.enabled ?? true;
    const attachments = p.attachments?.length
      ? saveAttachments(agent.workspacePath, p.attachments)
      : [];
    this.db
      .query(
        `INSERT INTO routines (id, agent_id, name, prompt, schedule, webhook_token, enabled, next_run_at, created_at, updated_at, run_at, tool_mode, require_approval, private, template_id, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.agentId,
        p.name,
        p.prompt,
        schedule,
        p.webhook ? newToken() : null,
        enabled ? 1 : 0,
        this.nextRun(schedule, enabled, now, runAt),
        now,
        now,
        runAt,
        p.toolMode ?? "both",
        p.requireApproval ? 1 : 0,
        p.private ? 1 : 0,
        p.templateId ?? null,
        JSON.stringify(attachments),
      );
    return this.emit(id);
  }

  update(p: MethodParsedParams<"routines.update">): Routine {
    const r = this.row(p.id);
    if (!r) throw new RpcError("not_found", "routine not found");
    if (p.runAt != null && p.runAt < Date.now())
      throw new RpcError("bad_request", "runAt is in the past");
    if (p.schedule && p.runAt != null)
      throw new RpcError("bad_request", "schedule and runAt are mutually exclusive");
    const schedule =
      p.runAt != null ? null : p.schedule === undefined ? r.schedule : p.schedule?.trim() || null;
    const runAt = p.schedule ? null : p.runAt === undefined ? r.run_at : p.runAt;
    if (schedule) asBadRequest(() => parseSchedule(schedule));
    const enabled = p.enabled ?? r.enabled === 1;
    const token =
      p.webhook === undefined
        ? r.webhook_token
        : p.webhook
          ? (r.webhook_token ?? newToken())
          : null;
    const next =
      schedule !== r.schedule ||
      runAt !== r.run_at ||
      enabled !== (r.enabled === 1) ||
      r.next_run_at === null
        ? this.nextRun(schedule, enabled, Date.now(), runAt)
        : r.next_run_at;
    const agent = this.agents.get(r.agent_id);
    if (!agent) throw new RpcError("not_found", "agent not found");
    const attachments =
      p.attachments === undefined
        ? r.attachments
        : JSON.stringify(
            p.attachments.length ? saveAttachments(agent.workspacePath, p.attachments) : [],
          );
    this.db
      .query(
        "UPDATE routines SET name = ?, prompt = ?, schedule = ?, webhook_token = ?, enabled = ?, next_run_at = ?, updated_at = ?, run_at = ?, tool_mode = ?, require_approval = ?, private = ?, attachments = ? WHERE id = ?",
      )
      .run(
        p.name ?? r.name,
        p.prompt ?? r.prompt,
        schedule,
        token,
        enabled ? 1 : 0,
        next,
        Date.now(),
        runAt,
        p.toolMode ?? r.tool_mode,
        p.requireApproval === undefined ? r.require_approval : Number(p.requireApproval),
        p.private === undefined ? r.private : Number(p.private),
        attachments,
        p.id,
      );
    return this.emit(p.id);
  }

  delete(id: string): void {
    if (!this.row(id)) throw new RpcError("not_found", "routine not found");
    this.db.query("UPDATE routines SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    this.broadcast("routine.deleted", { id });
  }

  runs(id: string): RoutineRun[] {
    const rows = this.db
      .query(
        `SELECT r.*, q.status AS queue_status, t.id AS turn_id, t.status AS turn_status,
          t.started_at AS turn_started_at, t.ended_at AS turn_ended_at
         FROM routine_runs r LEFT JOIN queue q ON q.id = r.queue_id
         LEFT JOIN turns t ON t.id = (SELECT id FROM turns WHERE queue_id = r.queue_id ORDER BY started_at DESC, rowid DESC LIMIT 1)
         WHERE r.routine_id = ? AND (r.task_id IS NULL OR r.task_id NOT IN (SELECT id FROM tasks WHERE private = 1))
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT 50`,
      )
      .all(id) as RunRow[];
    return rows.map(toRun);
  }

  run(id: string, trigger: RoutineTrigger, payload?: string): RoutineRun {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "routine not found");
    if (!this.agents.get(r.agent_id)) throw new RpcError("not_found", "agent not found");
    const body = payload
      ? `\n<webhook_payload>\n${payload.slice(0, PAYLOAD_LIMIT)}${payload.length > PAYLOAD_LIMIT ? "\n[truncated]" : ""}\n</webhook_payload>`
      : "";
    const prompt = `<routine name="${r.name.replace(/[<>"&]/g, "")}" trigger="${trigger}">\n${r.prompt}${body}\n</routine>`;
    const attachments: ChatAttachment[] = JSON.parse(r.attachments);
    let queueId: string | null = null;
    let taskId: string | null = null;
    let error: string | null = null;
    try {
      if (this.taskSink)
        ({ taskId, queueId } = this.taskSink.create({
          agentId: r.agent_id,
          prompt: r.prompt,
          title: r.name,
          toolMode: r.tool_mode,
          requireApproval: r.require_approval === 1,
          private: r.private === 1,
          routineId: r.id,
          templateId: r.template_id,
          trigger,
          sendPrompt: prompt,
          attachments,
        }));
      else
        ({ queueId } = this.runtimes().sendFrom(r.agent_id, r.prompt, {
          agentId: null,
          hops: 0,
          prompt: attachmentsBlock(attachments) + prompt,
          meta: { routine: { id: r.id, name: r.name, trigger }, attachments },
        }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const runId = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO routine_runs (id, routine_id, trigger, queue_id, error, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(runId, id, trigger, queueId, error, now, taskId);
    this.db.query("UPDATE routines SET last_run_at = ? WHERE id = ?").run(now, id);
    this.emit(id);
    return toRun(this.db.query("SELECT * FROM routine_runs WHERE id = ?").get(runId) as RunRow);
  }

  webhookAuth(id: string, token: string): WebhookAuth {
    const r = this.row(id);
    if (!r?.webhook_token || !r.enabled) return { kind: "unauthorized", known: r !== null };
    const a = Buffer.from(r.webhook_token);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return { kind: "unauthorized", known: true };
    return this.agents.get(r.agent_id) ? { kind: "ok", routineId: r.id } : { kind: "notFound" };
  }

  tick(now = Date.now()): void {
    const due = this.db
      .query(
        "SELECT routines.* FROM routines JOIN agents ON agents.id = routines.agent_id WHERE routines.deleted_at IS NULL AND agents.deleted_at IS NULL AND routines.enabled = 1 AND routines.next_run_at IS NOT NULL AND routines.next_run_at <= ?",
      )
      .all(now) as Row[];
    for (const r of due) {
      // missed runs collapse into one; the next run is computed from now
      this.db
        .query("UPDATE routines SET next_run_at = ?, enabled = ? WHERE id = ?")
        .run(
          r.run_at !== null ? null : this.nextRun(r.schedule, true, now),
          r.run_at !== null ? 0 : 1,
          r.id,
        );
      this.run(r.id, "schedule");
    }
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), envPositiveNumber("BOTO_ROUTINE_TICK_MS", 30_000));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private emit(id: string): Routine {
    const r = this.get(id);
    this.broadcast("routine.updated", r);
    return r;
  }
}
