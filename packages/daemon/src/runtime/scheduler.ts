import { errorFields } from "./agent-runtime";

/** Parallel limit when the user has not set Agent.maxInstances ("a definir"). */
export const DEFAULT_INSTANCES = 1;

export function instanceCapacity(maxInstances: number | null | undefined): number {
  return maxInstances ?? DEFAULT_INSTANCES;
}

/** The part of an AgentRuntime the scheduler drives. */
export type SchedulableRuntime = {
  activeTurn(): { id: string } | null;
  canPull(): boolean;
  drain(): void;
  dispose(): Promise<void>;
};

type SchedulerDeps<R extends SchedulableRuntime> = {
  /** The agent's long-lived runtime (chat, config, compaction); creates it on demand. */
  primary(agentId: string): R;
  /** An extra, ephemeral instance of the agent. */
  spawn(agentId: string): R;
  capacity(agentId: string): number;
  paused(agentId: string): boolean;
  hasQueued(agentId: string): boolean;
};

/**
 * Per-agent capacity and pull policy: an agent runs up to `capacity` turns at once, one per
 * instance. The primary runtime pulls first; extra instances are spawned while queued work and
 * free capacity remain, pull the next queued item when their turn ends, and are disposed once
 * idle with nothing left to pull.
 */
export class AgentScheduler<R extends SchedulableRuntime> {
  private extrasByAgent = new Map<string, R[]>();
  private scheduling = new Set<string>();

  constructor(private deps: SchedulerDeps<R>) {}

  extras(agentId: string): R[] {
    return this.extrasByAgent.get(agentId) ?? [];
  }

  allExtras(): R[] {
    return [...this.extrasByAgent.values()].flat();
  }

  /** Instances currently running a turn (primary included when given). */
  active(agentId: string, primary: R | undefined): number {
    const pool = primary ? [primary, ...this.extras(agentId)] : this.extras(agentId);
    return pool.filter((r) => r.activeTurn() !== null).length;
  }

  mayStart(agentId: string, primary: R | undefined): boolean {
    return this.active(agentId, primary) < this.deps.capacity(agentId);
  }

  /** Fills free instances with queued work and reaps idle extras. */
  schedule(agentId: string): void {
    if (this.scheduling.has(agentId)) return;
    this.scheduling.add(agentId);
    try {
      if (!this.deps.paused(agentId) && this.deps.hasQueued(agentId)) this.fill(agentId);
      this.reap(agentId);
    } catch (e) {
      console.error(`[botod] schedule failed: agent=${agentId} ${errorFields(e)}`);
    } finally {
      this.scheduling.delete(agentId);
    }
  }

  private fill(agentId: string): void {
    const capacity = this.deps.capacity(agentId);
    const primary = this.deps.primary(agentId);
    for (let guard = 0; guard <= capacity; guard++) {
      if (!this.deps.hasQueued(agentId) || this.deps.paused(agentId)) return;
      const pool = [primary, ...this.extras(agentId)];
      if (pool.filter((r) => r.activeTurn() !== null).length >= capacity) return;
      let rt = pool.find((r) => r.canPull());
      if (!rt) {
        if (primary.activeTurn() === null) return; // primary is busy otherwise (starting/compacting)
        if (pool.length >= capacity) return;
        rt = this.deps.spawn(agentId);
        this.extrasByAgent.set(agentId, [...this.extras(agentId), rt]);
      }
      rt.drain();
      if (rt.activeTurn() === null) return;
    }
  }

  private reap(agentId: string): void {
    const extras = this.extras(agentId);
    if (!extras.length) return;
    const nothingToPull = this.deps.paused(agentId) || !this.deps.hasQueued(agentId);
    const capacity = this.deps.capacity(agentId);
    const keep: R[] = [];
    let poolSize = 1 + extras.length;
    for (const rt of extras) {
      if (rt.canPull() && (nothingToPull || poolSize > capacity)) {
        poolSize--;
        void rt.dispose();
      } else keep.push(rt);
    }
    if (keep.length) this.extrasByAgent.set(agentId, keep);
    else this.extrasByAgent.delete(agentId);
  }

  /** Removes every extra instance of an agent and returns them for disposal. */
  take(agentId: string): R[] {
    const extras = this.extras(agentId);
    this.extrasByAgent.delete(agentId);
    return extras;
  }

  takeAll(): R[] {
    const all = this.allExtras();
    this.extrasByAgent.clear();
    return all;
  }
}
