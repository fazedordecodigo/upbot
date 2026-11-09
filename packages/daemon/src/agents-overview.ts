import type {
  AgentOverview,
  AgentSituation,
  AgentsOverviewResult,
  AgentTaskRef,
} from "@boto/protocol";
import type { AgentStore } from "./agents";
import type { ApprovalService, AskPolicy } from "./approvals";
import type { QueueStore } from "./chat-store";
import { errorFields } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import { instanceCapacity } from "./runtime/scheduler";

/** Built-in bridge tools that act outside Boto ("publicar"). */
const EXTERNAL_BRIDGE_TOOLS = new Set(["page_publish"]);

/**
 * Agent.requireApproval: the agent stops and asks before external actions — every app tool that
 * is not a read, and built-in tools that publish. It only adds asks.
 */
export function agentApprovalPolicy(agents: AgentStore): AskPolicy {
  return (q) => {
    if (!agents.get(q.agentId)?.requireApproval) return false;
    if (q.isAppTool) return q.permission !== "read";
    return EXTERNAL_BRIDGE_TOOLS.has(q.tool);
  };
}

const TITLE_MAX = 120;

function titleOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

const TRIGGERS = new Set([
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.status",
  "turn.started",
  "turn.ended",
  "queue.updated",
  "approval.updated",
  "permission.requested",
  "permission.resolved",
]);

export const OVERVIEW_DEBOUNCE_MS = 150;

/** Per-agent cockpit: situation, instances, running/waiting work, queue size and machines. */
export class AgentsOverviewService {
  private machineSources: ((agentId: string) => string[])[] = [];
  private taskResolver: ((queueId: string) => { taskId: string; title: string } | null) | null =
    null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private agents: AgentStore,
    private queue: QueueStore,
    private runtimes: () => RuntimeManager,
    private approvals: () => ApprovalService | null,
    private broadcast: (event: string, data: unknown) => void,
  ) {}

  /** Machines (computer-in-the-cloud ids) assigned to an agent, e.g. from the desktop service. */
  addMachineSource(source: (agentId: string) => string[]): void {
    this.machineSources.push(source);
  }

  /** Maps a queue item to its task (tasks service). */
  setTaskResolver(resolver: (queueId: string) => { taskId: string; title: string } | null): void {
    this.taskResolver = resolver;
  }

  overview(): AgentsOverviewResult {
    const runtimes = this.runtimes();
    const statuses = runtimes.statuses();
    const pending = (this.approvals()?.list() ?? []).filter(
      (a) => a.status === "pending" && (!a.turnId || !this.queue.isPrivateTurn(a.turnId)),
    );
    const agents = this.agents.list().map((agent): AgentOverview => {
      const mine = pending.filter((a) => a.agentId === agent.id);
      const approvalTurns = new Set(mine.map((a) => a.turnId).filter(Boolean));
      const running: AgentTaskRef[] = [];
      const waiting: AgentTaskRef[] = [];
      for (const t of runtimes.activeTurns(agent.id)) {
        if (this.queue.isPrivateTurn(t.id)) continue;
        const ref = this.refForTurn(t.id, t.startedAt);
        (t.awaiting || approvalTurns.has(t.id) ? waiting : running).push(ref);
      }
      const status = statuses[agent.id] ?? { status: "idle", error: null };
      const unattributed = mine.some((a) => !a.turnId);
      let situation: AgentSituation = "idle";
      if (waiting.length || unattributed || status.status === "awaiting_permission")
        situation = "wait";
      else if (running.length || status.status === "running" || status.status === "starting")
        situation = "run";
      else if (status.status === "error") situation = "error";
      return {
        agentId: agent.id,
        situation,
        error: situation === "error" ? status.error : null,
        paused: this.agents.queuePaused(agent.id),
        instances: {
          active: running.length + waiting.length,
          max: agent.maxInstances,
          capacity: instanceCapacity(agent.maxInstances),
        },
        running,
        waiting,
        queued: this.queue.queued(agent.id).length,
        machines: this.machinesFor(agent.id),
      };
    });
    return {
      agents,
      summary: {
        agents: agents.length,
        running: agents.reduce((n, a) => n + a.running.length, 0),
        waiting: agents.reduce((n, a) => n + a.waiting.length, 0),
        queued: agents.reduce((n, a) => n + a.queued, 0),
      },
    };
  }

  private refForTurn(turnId: string, startedAt: number): AgentTaskRef {
    const row = this.queue.byTurn(turnId);
    const task = row ? this.resolveTask(row.id) : null;
    return {
      id: row?.id ?? turnId,
      taskId: task?.taskId ?? null,
      turnId,
      title: task?.title ?? titleOf(row?.text ?? ""),
      since: startedAt,
    };
  }

  private resolveTask(queueId: string): { taskId: string; title: string } | null {
    try {
      return this.taskResolver?.(queueId) ?? null;
    } catch (e) {
      console.error(`[botod] overview task resolver failed: ${errorFields(e)}`);
      return null;
    }
  }

  private machinesFor(agentId: string): string[] {
    const ids = new Set<string>();
    for (const source of this.machineSources) {
      try {
        for (const id of source(agentId)) ids.add(id);
      } catch (e) {
        console.error(`[botod] overview machine source failed: ${errorFields(e)}`);
      }
    }
    return [...ids];
  }

  /** Debounced agents.overviewChanged after any event that changes the cockpit. */
  onEvent(event: string): void {
    if (!TRIGGERS.has(event) && !event.startsWith("task.") && !event.startsWith("desktop.machine"))
      return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.broadcast("agents.overviewChanged", this.overview());
      } catch (e) {
        console.error(`[botod] overview broadcast failed: ${errorFields(e)}`);
      }
    }, OVERVIEW_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
