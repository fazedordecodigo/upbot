import type { Database } from "bun:sqlite";
import { type MethodParsedParams, type Template, WHEN_SCHEDULES } from "@boto/protocol";
import { parseSchedule } from "./routines";
import type { Broadcast } from "./rpc";
import { asBadRequest, RpcError } from "./runtime/agent-runtime";

type Row = {
  id: string;
  kind: Template["kind"];
  name: string;
  description: string;
  prompt: string;
  icon: string;
  tool_mode: Template["toolMode"];
  require_approval: number;
  schedule: string | null;
  builtin: number;
  hidden_at: number | null;
  created_at: number;
  updated_at: number;
};
const toTemplate = (r: Row): Template => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  description: r.description,
  prompt: r.prompt,
  icon: r.icon,
  toolMode: r.tool_mode,
  requireApproval: r.require_approval === 1,
  schedule: r.schedule,
  builtin: r.builtin === 1,
  hidden: r.hidden_at !== null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class TemplateService {
  constructor(
    private db: Database,
    private broadcast: Broadcast,
  ) {}

  list(includeHidden = false): Template[] {
    return (
      this.db
        .query(
          `SELECT * FROM templates ${includeHidden ? "" : "WHERE hidden_at IS NULL"} ORDER BY builtin DESC, created_at ASC, rowid ASC`,
        )
        .all() as Row[]
    ).map(toTemplate);
  }

  private get(id: string): Template {
    const row = this.db.query("SELECT * FROM templates WHERE id = ?").get(id) as Row | null;
    if (!row) throw new RpcError("not_found", "template not found");
    return toTemplate(row);
  }

  private validate(kind: Template["kind"], schedule: string | null): void {
    if ((kind === "routine") !== (schedule !== null))
      throw new RpcError("bad_request", "schedule is required only for routine templates");
    if (schedule !== null) asBadRequest(() => parseSchedule(schedule));
  }

  create(p: MethodParsedParams<"templates.create">): Template {
    const schedule = p.schedule ?? null;
    this.validate(p.kind, schedule);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO templates (id, kind, name, description, prompt, icon, tool_mode, require_approval, schedule, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        id,
        p.kind,
        p.name,
        p.description ?? "",
        p.prompt,
        p.icon ?? "file-text",
        p.toolMode ?? "both",
        p.requireApproval ? 1 : 0,
        schedule,
        now,
        now,
      );
    return this.emit(id);
  }

  update(p: MethodParsedParams<"templates.update">): Template {
    const old = this.get(p.id);
    const r = {
      kind: p.kind ?? old.kind,
      name: p.name ?? old.name,
      description: p.description ?? old.description,
      prompt: p.prompt ?? old.prompt,
      icon: p.icon ?? old.icon,
      toolMode: p.toolMode ?? old.toolMode,
      requireApproval: p.requireApproval ?? old.requireApproval,
      schedule: p.schedule === undefined ? old.schedule : p.schedule,
    };
    this.validate(r.kind, r.schedule);
    this.db
      .query(
        "UPDATE templates SET kind = ?, name = ?, description = ?, prompt = ?, icon = ?, tool_mode = ?, require_approval = ?, schedule = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        r.kind,
        r.name,
        r.description,
        r.prompt,
        r.icon,
        r.toolMode,
        r.requireApproval ? 1 : 0,
        r.schedule,
        Date.now(),
        p.id,
      );
    return this.emit(p.id);
  }

  delete(id: string): void {
    const r = this.get(id);
    if (r.builtin)
      this.db
        .query("UPDATE templates SET hidden_at = ?, updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), id);
    else this.db.query("DELETE FROM templates WHERE id = ?").run(id);
    this.broadcast("templates.changed", { id });
  }

  restore(id: string): Template {
    if (!this.get(id).builtin)
      throw new RpcError("bad_request", "only builtin templates can be restored");
    this.db
      .query("UPDATE templates SET hidden_at = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    return this.emit(id);
  }

  use(id: string) {
    const r = this.get(id);
    return {
      templateId: id,
      prompt: r.prompt,
      toolMode: r.toolMode,
      requireApproval: r.requireApproval,
      when:
        r.kind === "task"
          ? ("now" as const)
          : r.schedule === WHEN_SCHEDULES.daily
            ? ("daily" as const)
            : r.schedule === WHEN_SCHEDULES.weekly
              ? ("weekly" as const)
              : null,
      schedule: r.schedule,
    };
  }

  private emit(id: string): Template {
    this.broadcast("templates.changed", { id });
    return this.get(id);
  }
}
