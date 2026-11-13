import type { Database } from "bun:sqlite";
import type {
  Collaboration,
  CollaborationMessage,
  CollaborationPhase,
  CollaborationStatus,
  Turn,
} from "@boto/protocol";
import type { AgentStore } from "./agents";
import { isExternalActionAsk } from "./agents-overview";
import type { AskPolicy } from "./approvals";
import { MAX_HOPS } from "./bridge";
import type { ChatStore } from "./chat-store";
import type { Broadcast } from "./rpc";
import { RpcError, xmlAttr } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";

// Collaborations ("mesas"): one lead bot gathers other bots around a problem and they
// talk pair-to-pair. Every addressed message is appended to the shared transcript
// (all members see it in their prompt tail). Delivery reuses the agent queue: each
// member's hidden private task is the dedicated provider session for the table, so
// the bot remembers the mesa inside it and nowhere else. `delivered`/`queue_id` on
// transcript rows make pause, resume and daemon restarts idempotent.

const TRANSCRIPT_MESSAGES = 20;
// per-table hard cap; e2e tests lower it via BOTO_COLLAB_MAX_MESSAGES
const MAX_MESSAGES = Number(process.env.BOTO_COLLAB_MAX_MESSAGES ?? 300) || 300;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 8;
const COUNTED_KINDS = new Set(["message", "instruction", "request"]);

export const COLLABORATION_PHASES: CollaborationPhase[] = [
  "entender",
  "investigar",
  "corrigir",
  "verificar",
  "avisar",
];

type CollabRow = {
  id: string;
  title: string;
  problem: string;
  leader_agent_id: string;
  origin_task_id: string | null;
  origin_agent_id: string | null;
  status: CollaborationStatus;
  phase: CollaborationPhase;
  topology: "mesh" | "hub";
  ask_external: number;
  checkpoint_phases: number;
  use_memory: number;
  phase_pending: CollaborationPhase | null;
  summary: string | null;
  message_count: number;
  action_count: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
};

type MemberRow = {
  collaboration_id: string;
  agent_id: string;
  role: "leader" | "member";
  task_id: string;
  joined_at: number;
  left_at: number | null;
};

type MessageRow = {
  id: string;
  collaboration_id: string;
  seq: number;
  kind: CollaborationMessage["kind"];
  from_agent_id: string | null;
  to_agent_id: string | null;
  text: string;
  delivered: number;
  queue_id: string | null;
  answered_at: number | null;
  created_at: number;
};

function rowToMessage(r: MessageRow): CollaborationMessage {
  return {
    id: r.id,
    collaborationId: r.collaboration_id,
    seq: r.seq,
    kind: r.kind,
    fromAgentId: r.from_agent_id,
    toAgentId: r.to_agent_id,
    text: r.text,
    answeredAt: r.answered_at,
    createdAt: r.created_at,
  };
}

export class CollaborationService {
  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
    private deps: { instructTask: (taskId: string, text: string) => void },
  ) {}

  /**
   * AskPolicy for ApprovalService: a table created with ask_external gates every
   * member's external actions, whatever the member's own approval setting says.
   * Policies only add asks.
   */
  askPolicy(): AskPolicy {
    return (q) => {
      if (!q.turnId) return false;
      const row = this.db
        .query(
          `SELECT c.ask_external AS flag FROM queue
           JOIN collaborations c ON c.id = queue.collaboration_id
           WHERE queue.turn_id = ?`,
        )
        .get(q.turnId) as { flag: number } | null;
      if (!row?.flag) return false;
      return isExternalActionAsk(q);
    };
  }

  /**
   * Whether the session owning this turn may see the user profile: tables created
   * without use_memory keep <user_profile> out of member sessions. Sessions that
   * do not belong to a table are unaffected.
   */
  sessionUsesMemory(turnId: string): boolean {
    const row = this.db
      .query(
        `SELECT c.use_memory AS flag FROM queue
         JOIN collaborations c ON c.id = queue.collaboration_id
         WHERE queue.turn_id = ?`,
      )
      .get(turnId) as { flag: number } | null;
    return row === null || row.flag === 1;
  }

  private row(id: string): CollabRow | null {
    return this.db.query("SELECT * FROM collaborations WHERE id = ?").get(id) as CollabRow | null;
  }

  private mustRow(id: string): CollabRow {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "collaboration not found");
    return r;
  }

  private memberRows(id: string, activeOnly = true): MemberRow[] {
    return this.db
      .query(
        `SELECT * FROM collaboration_members WHERE collaboration_id = ?
         ${activeOnly ? "AND left_at IS NULL" : ""} ORDER BY joined_at ASC, rowid ASC`,
      )
      .all(id) as MemberRow[];
  }

  private toCollab(r: CollabRow): Collaboration {
    const members = this.memberRows(r.id);
    return {
      id: r.id,
      title: r.title,
      problem: r.problem,
      leaderId: r.leader_agent_id,
      members: members.map((m) => ({ agentId: m.agent_id, role: m.role })),
      status: r.status,
      phase: r.phase,
      topology: r.topology,
      askExternal: r.ask_external === 1,
      checkpointPhases: r.checkpoint_phases === 1,
      useMemory: r.use_memory === 1,
      phasePending: r.phase_pending,
      stats: {
        members: members.length,
        messages: r.message_count,
        actions: r.action_count,
        elapsedMs: (r.ended_at ?? Date.now()) - r.created_at,
      },
      summary: r.summary,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      endedAt: r.ended_at,
    };
  }

  get(id: string): Collaboration {
    return this.toCollab(this.mustRow(id));
  }

  list(): Collaboration[] {
    const rows = this.db
      .query("SELECT * FROM collaborations ORDER BY created_at ASC")
      .all() as CollabRow[];
    return rows.map((r) => this.toCollab(r));
  }

  /** Active/paused tables the agent still sits at (bridge tool resolution). */
  forAgent(agentId: string): Collaboration[] {
    const rows = this.db
      .query(
        `SELECT c.* FROM collaborations c
         JOIN collaboration_members m ON m.collaboration_id = c.id
         WHERE m.agent_id = ? AND m.left_at IS NULL AND c.status IN ('active', 'paused')
         ORDER BY c.created_at ASC`,
      )
      .all(agentId) as CollabRow[];
    return rows.map((r) => this.toCollab(r));
  }

  resolveForAgent(agentId: string, key?: string): CollabRow {
    if (key) {
      const k = key.trim().toLowerCase();
      const r = this.db
        .query(
          `SELECT c.* FROM collaborations c
           JOIN collaboration_members m ON m.collaboration_id = c.id
           WHERE m.agent_id = ? AND m.left_at IS NULL AND (c.id = ? OR lower(c.title) = ?)
           ORDER BY c.created_at DESC LIMIT 1`,
        )
        .get(agentId, key, k) as CollabRow | null;
      if (!r) throw new Error(`you are not a member of a table named "${key}"`);
      return r;
    }
    const mine = this.forAgent(agentId);
    if (mine.length === 0) throw new Error("you are not a member of any table");
    if (mine.length > 1)
      throw new Error("you are at more than one table; pass `table` with its id or title");
    return this.mustRow(mine[0]!.id);
  }

  private emit(r: CollabRow): Collaboration {
    const collab = this.toCollab(r);
    this.broadcast("collaboration.updated", collab);
    return collab;
  }

  private touch(id: string): Collaboration {
    this.db.query("UPDATE collaborations SET updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.emit(this.mustRow(id));
  }

  private name(agentId: string | null): string {
    return (agentId && this.agents.get(agentId)?.name) || "deleted agent";
  }

  /** One hidden private task = the member's dedicated provider session at the table. */
  private createMemberTask(agentId: string, title: string): string {
    const taskId = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO tasks (id, agent_id, title, prompt, situation, outcome, private, tool_mode,
           require_approval, session_id, routine_id, template_id, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, '', 'run', NULL, 1, 'both', 0, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(taskId, agentId, `Table: ${title}`, now, now);
    return taskId;
  }

  private addMember(collabId: string, agentId: string, role: "leader" | "member"): MemberRow {
    const r = this.mustRow(collabId);
    const taskId = this.createMemberTask(agentId, r.title);
    this.db
      .query(
        `INSERT INTO collaboration_members (collaboration_id, agent_id, role, task_id, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(collabId, agentId, role, taskId, Date.now());
    return this.memberRows(collabId).find((m) => m.agent_id === agentId)!;
  }

  create(p: {
    problem: string;
    title?: string | undefined;
    memberIds: string[];
    leaderId: string;
    originTaskId?: string | null;
    originAgentId?: string | null;
    topology?: "mesh" | "hub" | undefined;
    askExternal?: boolean | undefined;
    checkpointPhases?: boolean | undefined;
    useMemory?: boolean | undefined;
  }): Collaboration {
    const memberIds = [...new Set([p.leaderId, ...p.memberIds])];
    if (memberIds.length < MIN_MEMBERS || memberIds.length > MAX_MEMBERS)
      throw new RpcError("bad_request", `a table needs ${MIN_MEMBERS}-${MAX_MEMBERS} bots`);
    for (const id of memberIds)
      if (!this.agents.get(id)) throw new RpcError("bad_request", `agent ${id} not found`);
    if (!memberIds.includes(p.leaderId))
      throw new RpcError("bad_request", "the leader must be a table member");
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = p.title ?? taskTitle(p.problem);
    this.db
      .query(
        `INSERT INTO collaborations (id, title, problem, leader_agent_id, origin_task_id,
           origin_agent_id, status, phase, topology, ask_external, checkpoint_phases, use_memory,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 'entender', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        p.problem,
        p.leaderId,
        p.originTaskId ?? null,
        p.originAgentId ?? null,
        p.topology ?? "mesh",
        p.askExternal ? 1 : 0,
        p.checkpointPhases ? 1 : 0,
        p.useMemory ? 1 : 0,
        now,
        now,
      );
    for (const agentId of memberIds)
      this.addMember(id, agentId, agentId === p.leaderId ? "leader" : "member");
    const created = this.toCollab(this.mustRow(id));
    this.broadcast("collaboration.created", created);
    const kickoff = this.append(id, "instruction", null, p.leaderId, p.problem);
    const leader = this.memberRows(id).find((m) => m.agent_id === p.leaderId)!;
    this.deliver(id, kickoff, leader, null, 0, "The user opened this table for you:");
    return created;
  }

  private append(
    collabId: string,
    kind: CollaborationMessage["kind"],
    fromAgentId: string | null,
    toAgentId: string | null,
    text: string,
  ): CollaborationMessage {
    const row: MessageRow = {
      id: crypto.randomUUID(),
      collaboration_id: collabId,
      seq: (
        this.db
          .query(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM collaboration_messages WHERE collaboration_id = ?",
          )
          .get(collabId) as { s: number }
      ).s,
      kind,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      text,
      delivered: 0,
      queue_id: null,
      answered_at: null,
      created_at: Date.now(),
    };
    this.db
      .query(
        `INSERT INTO collaboration_messages (id, collaboration_id, seq, kind, from_agent_id,
           to_agent_id, text, delivered, queue_id, answered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
      )
      .run(
        row.id,
        row.collaboration_id,
        row.seq,
        row.kind,
        row.from_agent_id,
        row.to_agent_id,
        row.text,
        row.created_at,
      );
    if (COUNTED_KINDS.has(kind))
      this.db
        .query("UPDATE collaborations SET message_count = message_count + 1 WHERE id = ?")
        .run(collabId);
    const msg = rowToMessage(row);
    this.broadcast("collaboration.message", msg);
    this.touch(collabId);
    if (this.row(collabId)!.message_count >= MAX_MESSAGES) this.capReached(collabId);
    return msg;
  }

  private capReached(collabId: string): void {
    const r = this.row(collabId);
    if (!r || r.status !== "active") return;
    this.halt(collabId);
    this.db
      .query("UPDATE collaborations SET status = 'paused', updated_at = ? WHERE id = ?")
      .run(Date.now(), collabId);
    this.appendNote(collabId, `Message limit reached (${MAX_MESSAGES}); the table is paused.`);
  }

  private appendNote(collabId: string, text: string): void {
    const row: MessageRow = {
      id: crypto.randomUUID(),
      collaboration_id: collabId,
      seq: (
        this.db
          .query(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM collaboration_messages WHERE collaboration_id = ?",
          )
          .get(collabId) as { s: number }
      ).s,
      kind: "system",
      from_agent_id: null,
      to_agent_id: null,
      text,
      delivered: 1,
      queue_id: null,
      answered_at: null,
      created_at: Date.now(),
    };
    this.db
      .query(
        `INSERT INTO collaboration_messages (id, collaboration_id, seq, kind, from_agent_id,
           to_agent_id, text, delivered, queue_id, answered_at, created_at)
         VALUES (?, ?, ?, 'system', NULL, NULL, ?, 1, NULL, NULL, ?)`,
      )
      .run(row.id, row.collaboration_id, row.seq, row.text, row.created_at);
    this.broadcast("collaboration.message", rowToMessage(row));
    this.touch(collabId);
  }

  history(
    id: string,
    limit = 500,
  ): { collaboration: Collaboration; messages: CollaborationMessage[] } {
    const collaboration = this.get(id);
    const rows = this.db
      .query(
        "SELECT * FROM collaboration_messages WHERE collaboration_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(id, limit) as MessageRow[];
    return { collaboration, messages: rows.reverse().map(rowToMessage) };
  }

  private transcript(id: string): string {
    const { messages } = this.history(id, TRANSCRIPT_MESSAGES);
    return messages
      .map((m) => {
        const from = m.fromAgentId
          ? this.name(m.fromAgentId)
          : m.kind === "instruction"
            ? "user"
            : "system";
        const to = m.toAgentId ? this.name(m.toAgentId) : "user";
        return `[${from} → ${to}] ${m.text}`;
      })
      .join("\n");
  }

  private framePrompt(r: CollabRow, member: MemberRow, intro: string, text: string): string {
    const members = this.memberRows(r.id);
    const roster = members
      .map((m) => `${this.name(m.agent_id)}${m.role === "leader" ? " (leader)" : ""}`)
      .join(", ");
    const roleHint =
      member.role === "leader"
        ? `You lead this table: invite or remove members (table_invite/table_remove), advance phases with table_phase (${COLLABORATION_PHASES.join(" → ")}) and conclude with conclude_collaboration {summary} once the problem is solved.`
        : `Report findings to the leader, ${this.name(r.leader_agent_id)}, and keep them posted on progress.`;
    const rules = [
      r.topology === "hub"
        ? "everything goes through the leader — address every table_message to them"
        : "members talk directly to each other",
      r.ask_external
        ? "external actions always require the user's approval"
        : "external actions follow each member's own approval settings",
      r.checkpoint_phases
        ? "phase changes wait for the user to release them (table_phase asks the user)"
        : "the leader advances phases directly with table_phase",
      r.use_memory
        ? "members can see the user's profile"
        : "the user's profile is hidden from this table",
    ];
    return `<collaboration_context title="${xmlAttr(r.title)}" id="${r.id}" role="${member.role}" leader="${xmlAttr(this.name(r.leader_agent_id))}" members="${xmlAttr(roster)}" phase="${r.phase}">
You are at a Boto collaboration table working on this problem: ${xmlAttr(r.problem)}
${roleHint}
- How this table works: ${rules.join("; ")}.
- Talk to one member at a time with the boto table_message tool (to = member name, or "user" to ask the user something; pass table="${r.id}" if it asks for a table).
- Your final reply in this turn goes back to whoever sent you the last message. Do not reply to pure acknowledgements.
<recent_messages>
${this.transcript(r.id)}
</recent_messages>
</collaboration_context>
${intro}
${text}`;
  }

  /** Enqueues the transcript row's delivery to the member's private task. */
  private deliver(
    collabId: string,
    msg: CollaborationMessage,
    member: MemberRow,
    fromAgentId: string | null,
    hops: number,
    intro: string,
  ): void {
    const r = this.mustRow(collabId);
    const done = () => {
      this.db.query("UPDATE collaboration_messages SET delivered = 1 WHERE id = ?").run(msg.id);
    };
    if (!this.agents.get(member.agent_id)) {
      // deleted agent: skip quietly
      done();
      return;
    }
    const prompt = this.framePrompt(r, member, intro, msg.text);
    try {
      const { queueId } = this.runtimes().sendFrom(member.agent_id, msg.text, {
        agentId: fromAgentId,
        hops,
        taskId: member.task_id,
        collaborationId: collabId,
        prompt,
      });
      this.db
        .query("UPDATE collaboration_messages SET delivered = 1, queue_id = ? WHERE id = ?")
        .run(queueId, msg.id);
    } catch (e) {
      done();
      this.appendNote(collabId, `Could not deliver a message to ${this.name(member.agent_id)}.`);
      throw e;
    }
  }

  private requireActive(id: string): CollabRow {
    const r = this.mustRow(id);
    if (r.status !== "active") throw new RpcError("bad_request", `table is ${r.status}`);
    return r;
  }

  private memberByName(r: CollabRow, key: string, exceptId?: string): MemberRow {
    const k = key.trim().toLowerCase();
    const member = this.memberRows(r.id).find(
      (m) =>
        m.agent_id !== exceptId &&
        (m.agent_id === key || this.agents.get(m.agent_id)?.name.toLowerCase() === k),
    );
    if (!member) throw new RpcError("bad_request", `"${key}" is not at this table`);
    return member;
  }

  /** Bridge: `table_message` from a member. `to` = member name/id or "user". */
  tableMessage(fromAgentId: string, key: string | undefined, to: string, text: string): string {
    const r = this.resolveForAgent(fromAgentId, key);
    if (r.status !== "active") throw new Error(`table is ${r.status}`);
    const target = to.trim().toLowerCase();
    if (target === "user" || target === "você" || target === "voce") {
      const msg = this.append(r.id, "request", fromAgentId, null, text);
      this.db.query("UPDATE collaboration_messages SET delivered = 1 WHERE id = ?").run(msg.id);
      return "your question is on the table; the user answers it in the app";
    }
    const member = this.memberByName(r, to, fromAgentId);
    // hub tables: a non-leader's message always lands on the leader, whoever it named
    const clamped =
      r.topology === "hub" &&
      fromAgentId !== r.leader_agent_id &&
      member.agent_id !== r.leader_agent_id;
    const dest = clamped
      ? (this.memberRows(r.id).find((m) => m.agent_id === r.leader_agent_id) ?? member)
      : member;
    const msg = this.append(r.id, "message", fromAgentId, dest.agent_id, text);
    const hops = this.runtimes().currentHops(fromAgentId) + 1;
    if (hops <= MAX_HOPS)
      this.deliver(r.id, msg, dest, fromAgentId, hops, `${this.name(fromAgentId)} said to you:`);
    return clamped
      ? `on the table for ${this.name(dest.agent_id)} — in this table everything goes through the leader, so address them`
      : `on the table for ${this.name(dest.agent_id)}`;
  }

  /** Bridge: `list_collaborations` for the calling member. */
  listForAgent(agentId: string): unknown[] {
    return this.forAgent(agentId).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      phase: c.phase,
      leader: this.name(c.leaderId),
      members: c.members.map(
        (m) => `${this.name(m.agentId)}${m.role === "leader" ? " (leader)" : ""}`,
      ),
      youAreLeader: c.leaderId === agentId,
    }));
  }

  private requireLeader(r: CollabRow, agentId: string): void {
    if (r.leader_agent_id !== agentId) throw new Error("only the table leader can do that");
  }

  /** Bridge: `table_invite` (leader only). */
  invite(fromAgentId: string, key: string | undefined, agentKey: string): string {
    const r = this.resolveForAgent(fromAgentId, key);
    this.requireLeader(r, fromAgentId);
    if (r.status !== "active") throw new Error(`table is ${r.status}`);
    if (this.memberRows(r.id).length >= MAX_MEMBERS) throw new Error("the table is full");
    const k = agentKey.trim().toLowerCase();
    const agent = this.agents.list().find((a) => a.id === agentKey || a.name.toLowerCase() === k);
    if (!agent) throw new Error(`no agent named "${agentKey}"`);
    if (this.memberRows(r.id).some((m) => m.agent_id === agent.id))
      throw new Error(`${agent.name} is already at the table`);
    const member = this.addMember(r.id, agent.id, "member");
    this.appendNote(r.id, `${agent.name} joined the table.`);
    const msg = this.append(
      r.id,
      "message",
      fromAgentId,
      agent.id,
      `${this.name(fromAgentId)} invited you to this table.`,
    );
    const hops = this.runtimes().currentHops(fromAgentId) + 1;
    if (hops <= MAX_HOPS)
      this.deliver(r.id, msg, member, fromAgentId, hops, "You were invited to this table:");
    return `${agent.name} joined the table`;
  }

  /** Bridge: `table_remove` (leader only). */
  remove(fromAgentId: string, key: string | undefined, agentKey: string): string {
    const r = this.resolveForAgent(fromAgentId, key);
    this.requireLeader(r, fromAgentId);
    const member = this.memberByName(r, agentKey, fromAgentId);
    this.db
      .query(
        "UPDATE collaboration_members SET left_at = ? WHERE collaboration_id = ? AND agent_id = ?",
      )
      .run(Date.now(), r.id, member.agent_id);
    this.db
      .query(
        "UPDATE queue SET status = 'removed' WHERE collaboration_id = ? AND agent_id = ? AND status = 'queued'",
      )
      .run(r.id, member.agent_id);
    this.runtimes().cancelCollaborationTurns(r.id, member.agent_id);
    this.appendNote(r.id, `${this.name(member.agent_id)} left the table.`);
    return `${this.name(member.agent_id)} left the table`;
  }

  private appendPhaseRow(collabId: string, fromAgentId: string | null, phase: string): void {
    const row: MessageRow = {
      id: crypto.randomUUID(),
      collaboration_id: collabId,
      seq: (
        this.db
          .query(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM collaboration_messages WHERE collaboration_id = ?",
          )
          .get(collabId) as { s: number }
      ).s,
      kind: "phase",
      from_agent_id: fromAgentId,
      to_agent_id: null,
      text: phase,
      delivered: 1,
      queue_id: null,
      answered_at: null,
      created_at: Date.now(),
    };
    this.db
      .query(
        `INSERT INTO collaboration_messages (id, collaboration_id, seq, kind, from_agent_id,
           to_agent_id, text, delivered, queue_id, answered_at, created_at)
         VALUES (?, ?, ?, 'phase', ?, NULL, ?, 1, NULL, NULL, ?)`,
      )
      .run(row.id, row.collaboration_id, row.seq, row.from_agent_id, row.text, row.created_at);
    this.broadcast("collaboration.message", rowToMessage(row));
  }

  /** Bridge: `table_phase` (leader only). */
  advancePhase(
    fromAgentId: string,
    key: string | undefined,
    phase: string,
    summary?: string,
  ): string {
    const r = this.resolveForAgent(fromAgentId, key);
    this.requireLeader(r, fromAgentId);
    if (r.status !== "active") throw new Error(`table is ${r.status}`);
    if (!COLLABORATION_PHASES.includes(phase as CollaborationPhase))
      throw new Error(`unknown phase "${phase}" (${COLLABORATION_PHASES.join(", ")})`);
    if (r.checkpoint_phases) {
      if (r.phase_pending)
        throw new Error(`still waiting for the user to release the move to "${r.phase_pending}"`);
      const s = summary?.trim();
      this.append(
        r.id,
        "request",
        fromAgentId,
        null,
        s ? `${s} — move the table to "${phase}"` : `Move the table to "${phase}"`,
      );
      this.db
        .query("UPDATE collaborations SET phase_pending = ?, updated_at = ? WHERE id = ?")
        .run(phase, Date.now(), r.id);
      this.emit(this.mustRow(r.id));
      return `phase request is on the table; the user releases the step in the app`;
    }
    this.db
      .query("UPDATE collaborations SET phase = ?, updated_at = ? WHERE id = ?")
      .run(phase, Date.now(), r.id);
    this.appendPhaseRow(r.id, fromAgentId, phase);
    this.emit(this.mustRow(r.id));
    return `phase is now ${phase}`;
  }

  /** Bridge/RPC: conclude with a summary (leader via tool; user via RPC). */
  conclude(id: string, summary: string, leaderId?: string): Collaboration {
    const r = this.mustRow(id);
    if (leaderId) this.requireLeader(r, leaderId);
    if (r.status === "done") return this.toCollab(r);
    if (r.status === "stopped") throw new RpcError("bad_request", "table is stopped");
    this.halt(id);
    const now = Date.now();
    this.db
      .query(
        "UPDATE collaborations SET status = 'done', summary = ?, updated_at = ?, ended_at = ? WHERE id = ?",
      )
      .run(summary, now, now, id);
    this.retireMembers(id, "completed");
    const msg = this.append(id, "summary", leaderId ?? r.leader_agent_id, null, summary);
    this.db.query("UPDATE collaboration_messages SET delivered = 1 WHERE id = ?").run(msg.id);
    const collab = this.emit(this.mustRow(id));
    // the summary goes back to wherever the table was started from
    const text = `The table "${r.title}" concluded. Summary:\n${summary}`;
    if (r.origin_task_id) {
      try {
        this.deps.instructTask(r.origin_task_id, text);
      } catch {
        // stopped/deleted origin task: the summary still lives in the transcript
      }
    } else if (r.origin_agent_id && this.agents.get(r.origin_agent_id)) {
      this.runtimes().sendFrom(r.origin_agent_id, text, {
        agentId: null,
        hops: 0,
        prompt: `<collaboration_result>\n${text}\n</collaboration_result>`,
      });
    }
    return collab;
  }

  /** RPC: user instruction — lands only on the leader's session (pendable while paused). */
  instruct(id: string, text: string): { messageId: string } {
    const r = this.mustRow(id);
    if (r.status === "done" || r.status === "stopped")
      throw new RpcError("bad_request", `table is ${r.status}`);
    const leader = this.memberRows(id).find((m) => m.role === "leader");
    if (!leader || !this.agents.get(leader.agent_id))
      throw new RpcError("bad_request", "the table leader is gone");
    const msg = this.append(id, "instruction", null, leader.agent_id, text);
    if (r.status === "active")
      this.deliver(id, msg, leader, null, 0, "The user instructs the table:");
    return { messageId: msg.id };
  }

  /** RPC: answer a pending `request` (a member's `to:"user"` question). */
  answerRequest(id: string, messageId: string, text: string): CollaborationMessage {
    this.requireActive(id);
    const row = this.db
      .query(
        "SELECT * FROM collaboration_messages WHERE id = ? AND collaboration_id = ? AND kind = 'request'",
      )
      .get(messageId, id) as MessageRow | null;
    if (!row) throw new RpcError("not_found", "no pending request with that id");
    if (row.answered_at !== null) throw new RpcError("bad_request", "request already answered");
    if (!row.from_agent_id) throw new RpcError("bad_request", "request has no author");
    this.db
      .query("UPDATE collaboration_messages SET answered_at = ? WHERE id = ?")
      .run(Date.now(), messageId);
    const member = this.memberRows(id).find((m) => m.agent_id === row.from_agent_id);
    const msg = this.append(id, "message", null, row.from_agent_id, text);
    if (member) this.deliver(id, msg, member, null, 0, "The user answered your question:");
    // a checkpoint table releases the pending phase when the leader's request is answered
    const r = this.mustRow(id);
    if (r.phase_pending && row.from_agent_id === r.leader_agent_id) {
      this.db
        .query(
          "UPDATE collaborations SET phase = ?, phase_pending = NULL, updated_at = ? WHERE id = ?",
        )
        .run(r.phase_pending, Date.now(), id);
      this.appendPhaseRow(id, r.leader_agent_id, r.phase_pending);
      this.emit(this.mustRow(id));
    }
    return rowToMessage({ ...row, answered_at: Date.now() });
  }

  /** Called for every turn.ended event. */
  onTurnEnded(
    turn: Turn,
    queueRow: {
      collaboration_id: string | null;
      hops: number;
      from_agent_id?: string | null;
    } | null,
  ): void {
    if (!queueRow?.collaboration_id) return;
    const r = this.row(queueRow.collaboration_id);
    if (!r || r.status !== "active") return;
    const tools = this.chat.itemsForTurn(turn.id).filter((i) => i.kind === "tool_call").length;
    if (tools)
      this.db
        .query("UPDATE collaborations SET action_count = action_count + ? WHERE id = ?")
        .run(tools, r.id);
    if (turn.status === "failed") {
      this.appendNote(r.id, `${this.name(turn.agentId)} failed: ${turn.error ?? "unknown error"}`);
      return;
    }
    if (turn.status !== "completed") return;
    const reply = this.chat.finalReply(turn.id);
    if (!reply) return;
    const to = queueRow.from_agent_id ?? null;
    const msg = this.append(r.id, "message", turn.agentId, to, reply);
    if (!to) return;
    const member = this.memberRows(r.id).find((m) => m.agent_id === to);
    const hops = queueRow.hops + 1;
    if (member && hops <= MAX_HOPS)
      this.deliver(r.id, msg, member, turn.agentId, hops, `${this.name(turn.agentId)} replied:`);
  }

  private halt(id: string): void {
    const queued = this.db
      .query("SELECT id FROM queue WHERE collaboration_id = ? AND status = 'queued'")
      .all(id) as { id: string }[];
    this.db
      .query("UPDATE queue SET status = 'removed' WHERE collaboration_id = ? AND status = 'queued'")
      .run(id);
    if (queued.length) {
      const marks = queued.map(() => "?").join(",");
      this.db
        .query(
          `UPDATE collaboration_messages SET delivered = 0, queue_id = NULL WHERE queue_id IN (${marks})`,
        )
        .run(...queued.map((q) => q.id));
    }
    this.runtimes().cancelCollaborationTurns(id);
  }

  /** Terminal states retire the member sessions: tasks done, private items/texts purged. */
  private retireMembers(id: string, outcome: "completed" | "stopped"): void {
    const now = Date.now();
    for (const m of this.memberRows(id, false)) {
      this.db
        .query(
          "UPDATE tasks SET situation = 'done', outcome = ?, prompt = '', ended_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(outcome, now, now, m.task_id);
      this.db.query("DELETE FROM items WHERE task_id = ?").run(m.task_id);
      this.db.query("UPDATE queue SET text = '', prompt = NULL WHERE task_id = ?").run(m.task_id);
    }
  }

  pause(id: string): Collaboration {
    const r = this.mustRow(id);
    if (r.status !== "active") return this.toCollab(r);
    this.halt(id);
    this.db
      .query("UPDATE collaborations SET status = 'paused', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    this.appendNote(id, "Table paused by the user.");
    return this.emit(this.mustRow(id));
  }

  private pendingFor(id: string): MessageRow[] {
    return this.db
      .query(
        "SELECT * FROM collaboration_messages WHERE collaboration_id = ? AND delivered = 0 AND to_agent_id IS NOT NULL ORDER BY seq ASC",
      )
      .all(id) as MessageRow[];
  }

  private redeliver(id: string, m: MessageRow): void {
    const member = this.memberRows(id).find((x) => x.agent_id === m.to_agent_id);
    if (!member)
      return void this.db
        .query("UPDATE collaboration_messages SET delivered = 1 WHERE id = ?")
        .run(m.id);
    const intro = m.kind === "instruction" ? "The user instructs the table:" : "Back to the table:";
    this.deliver(id, rowToMessage(m), member, m.from_agent_id, 0, intro);
  }

  resume(id: string): Collaboration {
    const r = this.mustRow(id);
    if (r.status === "done" || r.status === "stopped")
      throw new RpcError("bad_request", `table is ${r.status}`);
    if (r.status === "active") return this.toCollab(r);
    this.db
      .query("UPDATE collaborations SET status = 'active', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    this.appendNote(id, "Table resumed.");
    const pending = this.pendingFor(id);
    for (const m of pending) this.redeliver(id, m);
    if (!pending.length) {
      // a paused table with nothing in flight needs a nudge to start moving again
      const leader = this.memberRows(id).find((m) => m.role === "leader");
      if (leader) {
        const msg = this.append(
          id,
          "instruction",
          null,
          leader.agent_id,
          "The table resumed. Keep the discussion moving.",
        );
        this.deliver(id, msg, leader, null, 0, "The table resumed:");
      }
    }
    return this.emit(this.mustRow(id));
  }

  stop(id: string): Collaboration {
    const r = this.mustRow(id);
    if (r.status === "stopped") return this.toCollab(r);
    if (r.status === "done") throw new RpcError("bad_request", "table is done");
    this.halt(id);
    const now = Date.now();
    this.db
      .query(
        "UPDATE collaborations SET status = 'stopped', updated_at = ?, ended_at = ? WHERE id = ?",
      )
      .run(now, now, id);
    this.retireMembers(id, "stopped");
    this.appendNote(id, "Table stopped by the user.");
    return this.emit(this.mustRow(id));
  }

  /** Bridge check used by start_collaboration + tools that must run inside a table turn. */
  tableForAgentTask(taskId: string | null): MemberRow | null {
    if (!taskId) return null;
    return this.db
      .query(
        `SELECT m.* FROM collaboration_members m JOIN collaborations c ON c.id = m.collaboration_id
         WHERE m.task_id = ? AND c.status IN ('active', 'paused')`,
      )
      .get(taskId) as MemberRow | null;
  }

  onAgentDeleted(agentId: string): void {
    const rows = this.db
      .query(
        `SELECT c.id, c.status, c.leader_agent_id FROM collaborations c
         JOIN collaboration_members m ON m.collaboration_id = c.id
         WHERE m.agent_id = ? AND m.left_at IS NULL AND c.status = 'active'`,
      )
      .all(agentId) as { id: string; status: string; leader_agent_id: string }[];
    for (const r of rows) {
      if (r.leader_agent_id === agentId) {
        this.halt(r.id);
        this.db
          .query("UPDATE collaborations SET status = 'paused', updated_at = ? WHERE id = ?")
          .run(Date.now(), r.id);
        this.appendNote(r.id, "The table leader was deleted; the table is paused.");
      } else {
        this.db
          .query(
            "UPDATE collaboration_members SET left_at = ? WHERE collaboration_id = ? AND agent_id = ?",
          )
          .run(Date.now(), r.id, agentId);
        this.appendNote(r.id, `${this.name(agentId)} left the table.`);
      }
    }
  }

  /** Startup: re-enqueue undelivered messages of active tables; idle ones go paused. */
  recover(): void {
    const rows = this.db
      .query("SELECT * FROM collaborations WHERE status = 'active'")
      .all() as CollabRow[];
    for (const r of rows) {
      // deliveries killed mid-flight (queue started, turn interrupted) come back too
      this.db
        .query(
          `UPDATE collaboration_messages SET delivered = 0, queue_id = NULL
           WHERE collaboration_id = ? AND delivered = 1 AND queue_id IN (
             SELECT q.id FROM queue q JOIN turns t ON t.id = q.turn_id
             WHERE q.collaboration_id = ? AND q.status = 'started' AND t.status = 'interrupted')`,
        )
        .run(r.id, r.id);
      const pending = this.pendingFor(r.id);
      if (!pending.length) {
        this.db
          .query("UPDATE collaborations SET status = 'paused', updated_at = ? WHERE id = ?")
          .run(Date.now(), r.id);
        this.appendNote(r.id, "The Boto daemon restarted; the table is paused.");
        continue;
      }
      for (const m of pending) this.redeliver(r.id, m);
    }
  }
}

const TITLE_MAX = 80;
function taskTitle(problem: string): string {
  const line = problem
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  const t = line ?? "";
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}
