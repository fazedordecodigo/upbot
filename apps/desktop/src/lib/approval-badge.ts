import type { Approval } from "@boto/protocol";
import type { DaemonClient } from "./daemon";
import { errorFields, logWarn } from "./log";

export class ApprovalBadge {
  private approvals = new Map<string, Approval>();
  private off: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private count = -1;
  private writes = Promise.resolve();
  private revision = 0;

  constructor(
    private client: Pick<DaemonClient, "request" | "on" | "onReconnect">,
    private setCount: (count: number) => Promise<void>,
    private now = Date.now,
    private schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
    private unschedule = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  ) {}

  private publish(count: number) {
    if (this.count === count) return;
    this.count = count;
    this.writes = this.writes
      .then(() => this.setCount(count))
      .catch((e) => logWarn("approval_badge.update_failed", errorFields(e)));
  }

  private refresh() {
    if (this.timer !== undefined) this.unschedule(this.timer);
    let next = Number.POSITIVE_INFINITY;
    for (const [id, approval] of this.approvals) {
      if (approval.status !== "pending" || approval.expiresAt <= this.now())
        this.approvals.delete(id);
      else next = Math.min(next, approval.expiresAt);
    }
    this.publish(this.approvals.size);
    if (Number.isFinite(next))
      this.timer = this.schedule(() => this.refresh(), Math.min(2147483647, next - this.now()));
  }

  private async sync() {
    const revision = ++this.revision;
    const updates = new Map<string, Approval>();
    const off = this.client.on("approval.updated", (approval) =>
      updates.set(approval.id, approval),
    );
    try {
      const approvals = await this.client.request("approvals.list", {});
      if (this.stopped || revision !== this.revision) return;
      this.approvals = new Map(approvals.map((approval) => [approval.id, approval]));
      for (const [id, approval] of updates) this.approvals.set(id, approval);
      this.refresh();
    } catch (e) {
      logWarn("approval_badge.sync_failed", errorFields(e));
    } finally {
      off();
    }
  }

  async start() {
    this.publish(0);
    this.off.push(
      this.client.on("approval.updated", (approval) => {
        this.approvals.set(approval.id, approval);
        this.refresh();
      }),
      this.client.onReconnect(() => void this.sync()),
    );
    await this.sync();
  }

  stop() {
    this.stopped = true;
    for (const off of this.off) off();
    if (this.timer !== undefined) this.unschedule(this.timer);
    this.approvals.clear();
    this.publish(0);
  }
}
