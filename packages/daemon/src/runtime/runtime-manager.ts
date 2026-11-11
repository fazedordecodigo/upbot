import type {
  Agent,
  AgentStatusInfo,
  ConfigOption,
  MemoryUsage,
  PendingPermission,
  QueueState,
} from "@boto/protocol";
import type { AgentStore } from "../agents";
import type { ChatStore, QueueSource, QueueStore } from "../chat-store";
import type { McpServerSpec, RemoteLaunch } from "../providers/types";
import type { TaskRuntimeHooks } from "../task-policy";
import { AgentRuntime, type Broadcast, RpcError, type RuntimeOptions } from "./agent-runtime";
import { AgentScheduler, instanceCapacity } from "./scheduler";

const STATUS_PRIORITY: AgentStatusInfo["status"][] = [
  "awaiting_permission",
  "running",
  "starting",
  "error",
  "idle",
];

export class RuntimeManager {
  private runtimes = new Map<string, AgentRuntime>();
  /** Task lookups for task-scoped sessions (set by the daemon once TaskService exists). */
  tasks: TaskRuntimeHooks | null = null;
  private scheduler: AgentScheduler<AgentRuntime>;

  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private broadcast: Broadcast,
    private mcpServers: (agentId: string) => McpServerSpec[] = () => [],
    private sessionContext: (agentId: string, turnId: string, fresh: boolean) => string = () => "",
    private remoteFor: (agentId: string) => RemoteLaunch | null = () => null,
    private sharedDirs: () => string[] = () => [],
    private memoryUsage: (turnId: string) => MemoryUsage = () => ({ count: 0, kinds: [] }),
    private apiKeyFor: (provider: string) => string | null = () => null,
  ) {
    this.scheduler = new AgentScheduler<AgentRuntime>({
      primary: (agentId) => this.runtimeFor(agentId),
      spawn: (agentId) => this.createRuntime(agentId, true),
      capacity: (agentId) => instanceCapacity(this.agents.get(agentId)?.maxInstances),
      paused: (agentId) => this.agents.queuePaused(agentId),
      hasQueued: (agentId) => this.queue.peek(agentId) !== null,
    });
  }

  private createRuntime(agentId: string, ephemeral: boolean): AgentRuntime {
    const agent = this.agents.get(agentId);
    if (!agent) throw new RpcError("not_found", "agent not found");
    const opts: RuntimeOptions = {
      ephemeral,
      onStatus: () => this.statusChanged(agentId),
      mayStart: () => this.scheduler.mayStart(agentId, this.runtimes.get(agentId)),
      onTurnFinished: () => this.reschedule(agentId),
    };
    return new AgentRuntime(
      agent,
      this.agents,
      this.chat,
      this.queue,
      this.broadcast,
      this.mcpServers,
      this.sessionContext,
      this.remoteFor,
      this.sharedDirs,
      () => this.tasks,
      this.memoryUsage,
      this.apiKeyFor,
      opts,
    );
  }

  private runtimeFor(agentId: string): AgentRuntime {
    let rt = this.runtimes.get(agentId);
    if (!rt) {
      rt = this.createRuntime(agentId, false);
      this.runtimes.set(agentId, rt);
    }
    return rt;
  }

  /** The primary runtime plus every extra instance of the agent. */
  private pool(agentId: string): AgentRuntime[] {
    const primary = this.runtimes.get(agentId);
    const extras = this.scheduler.extras(agentId);
    return primary ? [primary, ...extras] : extras;
  }

  private all(): AgentRuntime[] {
    return [...this.runtimes.values(), ...this.scheduler.allExtras()];
  }

  private aggregateStatus(agentId: string): AgentStatusInfo {
    const pool = this.pool(agentId);
    for (const status of STATUS_PRIORITY) {
      const rt = pool.find((r) => r.status === status);
      if (rt)
        return {
          status,
          error: this.chat.isPrivateTask(rt.currentTaskId()) ? null : rt.statusError,
        };
    }
    return { status: "idle", error: null };
  }

  private statusChanged(agentId: string): void {
    this.broadcast("agent.status", { agentId, ...this.aggregateStatus(agentId) });
    this.reschedule(agentId);
  }

  private reschedule(agentId: string): void {
    queueMicrotask(() => {
      if (this.agents.get(agentId)) this.scheduler.schedule(agentId);
    });
  }

  /** Starts queued work on free instances (e.g. after maxInstances grew). */
  schedule(agentId: string): void {
    this.scheduler.schedule(agentId);
  }

  /** Running turns across every instance of the agent. */
  activeTurns(agentId: string): { id: string; startedAt: number; awaiting: boolean }[] {
    return this.pool(agentId).flatMap((rt) => {
      const t = rt.activeTurn();
      return t ? [t] : [];
    });
  }

  activeInstances(agentId: string): number {
    return this.activeTurns(agentId).length;
  }

  send(agentId: string, text: string): { queueId: string } {
    const r = this.runtimeFor(agentId).send(text);
    this.scheduler.schedule(agentId);
    return r;
  }

  sendFrom(agentId: string, text: string, from: QueueSource): { queueId: string } {
    const r = this.runtimeFor(agentId).send(text, from);
    this.scheduler.schedule(agentId);
    return r;
  }

  usage(agentId: string) {
    return this.runtimeFor(agentId).usage();
  }

  /** Persists the runtime's pending streamed text so reads see every emitted chunk. */
  flushStreamText(agentId: string, beforeSeq?: number): void {
    for (const rt of this.pool(agentId)) rt.flushStreamText(beforeSeq);
  }

  compact(agentId: string): Promise<void> {
    return this.runtimeFor(agentId).compact("manual");
  }

  newSession(agentId: string): Promise<void> {
    return this.runtimeFor(agentId).newSession();
  }

  cancelChannelTurns(channelId: string): void {
    for (const rt of this.all()) {
      if (rt.currentChannelId() === channelId) rt.cancel();
    }
  }

  /**
   * The agent's running turn. Null when several instances run at once: bridge calls carry only
   * the agent, so they cannot be attributed to one turn (approvals then skip task grants).
   */
  currentTurn(agentId: string): { id: string; background: boolean; taskId: string | null } | null {
    const turns = this.pool(agentId).flatMap((rt) => {
      const t = rt.currentTurn();
      return t ? [t] : [];
    });
    return turns.length === 1 ? turns[0]! : null;
  }

  /** Task owning the agent's current provider session (null = plain chat or no runtime). */
  currentTaskId(agentId: string): string | null {
    return this.runtimes.get(agentId)?.currentTaskId() ?? null;
  }

  /** Cancels the agent's running turn when it belongs to the task; the queue keeps going. */
  cancelTask(agentId: string, taskId: string): void {
    for (const rt of this.pool(agentId)) {
      if (rt.currentTurn()?.taskId === taskId) rt.cancel({ pauseQueue: false });
    }
  }

  /** Drops the task's queued entries (stop); returns how many were removed. */
  removeTaskQueue(agentId: string, taskId: string): number {
    const removed = this.queue.removeForTask(taskId);
    if (removed > 0 && this.agents.get(agentId))
      this.broadcast("queue.updated", this.getQueue(agentId));
    return removed;
  }

  /** Starts the next queued entry when the agent is idle (e.g. a task was resumed). */
  drain(agentId: string): void {
    if (this.agents.queuePaused(agentId)) return;
    this.runtimeFor(agentId).drain();
  }

  currentHops(agentId: string): number {
    return Math.max(0, ...this.pool(agentId).map((rt) => rt.currentHops()));
  }

  bridgeActivity(agentId: string): void {
    for (const rt of this.pool(agentId)) rt.bridgeActivity();
  }

  getQueue(agentId: string): QueueState {
    if (!this.agents.get(agentId)) throw new RpcError("not_found", "agent not found");
    const rt = this.runtimes.get(agentId);
    if (rt) return rt.getQueue();
    return {
      agentId,
      paused: this.agents.queuePaused(agentId),
      items: this.queue.queued(agentId),
    };
  }

  removeQueued(queueId: string): void {
    for (const rt of this.runtimes.values()) {
      if (rt.getQueue().items.some((i) => i.id === queueId)) {
        rt.removeQueued(queueId);
        return;
      }
    }
    const item = this.queue.row(queueId);
    if (!item || !this.queue.remove(queueId)) {
      throw new RpcError("not_found", "queue item not found or already started");
    }
    this.broadcast("queue.updated", this.getQueue(item.agent_id));
  }

  pauseQueue(agentId: string): QueueState {
    return this.runtimeFor(agentId).pauseQueue();
  }

  resumeQueue(agentId: string): QueueState {
    const s = this.runtimeFor(agentId).resumeQueue();
    this.scheduler.schedule(agentId);
    return s;
  }

  async configOptions(agentId: string): Promise<ConfigOption[]> {
    return this.runtimeFor(agentId).configOptionsList();
  }

  async setConfig(
    agentId: string,
    configId: string,
    value: string | null,
  ): Promise<ConfigOption[]> {
    return this.runtimeFor(agentId).setConfig(configId, value);
  }

  /** Resume draining for every agent that still has queued items (startup). */
  resumeAllQueues(): void {
    for (const agentId of this.queue.agentsWithQueued()) {
      if (this.agents.queuePaused(agentId)) continue;
      try {
        this.runtimeFor(agentId).drain();
        this.scheduler.schedule(agentId);
      } catch (e) {
        console.error(`[botod] drain failed for ${agentId}:`, (e as Error).message);
      }
    }
  }

  cancel(agentId: string): void {
    const pool = this.pool(agentId);
    if (!pool.length) {
      if (!this.agents.get(agentId)) throw new RpcError("not_found", "agent not found");
      return;
    }
    for (const rt of pool) rt.cancel();
  }

  respondPermission(requestId: string, optionId: string | null): void {
    for (const rt of this.all()) {
      if (rt.listPending().some((p) => p.requestId === requestId)) {
        rt.respondPermission(requestId, optionId);
        return;
      }
    }
    throw new RpcError("not_found", "permission request not found or already resolved");
  }

  pendingPermissions(): PendingPermission[] {
    return this.all().flatMap((rt) => rt.listPending());
  }

  statuses(): Record<string, AgentStatusInfo> {
    const out: Record<string, AgentStatusInfo> = {};
    for (const agent of this.agents.list()) {
      out[agent.id] = this.aggregateStatus(agent.id);
    }
    return out;
  }

  /** Agent update: refresh the runtime's cached agent; kill session if provider changed. */
  async agentUpdated(agent: Agent, providerChanged: boolean): Promise<void> {
    for (const extra of this.scheduler.extras(agent.id)) extra.updateAgent(agent);
    if (providerChanged)
      await Promise.allSettled(this.scheduler.take(agent.id).map((r) => r.dispose()));
    const rt = this.runtimes.get(agent.id);
    if (rt) {
      rt.updateAgent(agent);
      if (providerChanged) await rt.dispose(true);
    }
    this.scheduler.schedule(agent.id);
  }

  /** Drops the provider session (e.g. placement changed); the queue resumes on a new one. */
  async restartSession(agentId: string): Promise<void> {
    this.chat.clearAgentSession(agentId);
    await Promise.allSettled(this.scheduler.take(agentId).map((r) => r.dispose()));
    await this.runtimes.get(agentId)?.dispose(true);
    this.scheduler.schedule(agentId);
  }

  async agentDeleted(agentId: string): Promise<void> {
    const pool = this.pool(agentId);
    this.runtimes.delete(agentId);
    this.scheduler.take(agentId);
    await Promise.allSettled(pool.map((rt) => rt.dispose()));
  }

  async closeAll(): Promise<void> {
    const all = this.all().map((rt) => rt.dispose());
    this.scheduler.takeAll();
    await Promise.allSettled(all);
    this.runtimes.clear();
  }
}
