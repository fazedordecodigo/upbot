import type { Approval, Collaboration, CollaborationMessage } from "@boto/protocol";
import type { DaemonClient } from "./daemon";

// Derivations for the "Mesas" grid: which tables are still in play, which ones
// are waiting on the user (a pending approval or an unanswered request) and
// which bucket each filter shows. Pure data in, data out — the grid fetches
// `collaborations.list`, `approvals.list` and each live table's history and
// feeds them here.

export type TableFilter = "todas" | "aguardando" | "discussao" | "resolvidas";

export type TablePending =
  | { kind: "approval"; approval: Approval }
  | { kind: "request"; request: CollaborationMessage };

/** A table still in play: active or paused — what the sidebar nests and counts. */
export function isLiveTable(c: Collaboration): boolean {
  return c.status === "active" || c.status === "paused";
}

/**
 * What the table is waiting on the user for: a pending approval raised by a
 * member (joined by `collaborationId`) wins over the oldest unanswered request.
 */
export function tablePending(
  c: Collaboration,
  approvals: Approval[],
  history: CollaborationMessage[],
): TablePending | null {
  const approval = approvals.find((a) => a.collaborationId === c.id && a.status === "pending");
  if (approval) return { kind: "approval", approval };
  const request = history.find((m) => m.kind === "request" && m.answeredAt === null);
  return request ? { kind: "request", request } : null;
}

/**
 * Pendency per live table: `approvals.list` joined by `collaborationId` plus
 * each live table's transcript for unanswered requests. Done and stopped
 * tables cannot hold a pendency, so their history is never fetched.
 */
export async function tablePendencies(
  client: Pick<DaemonClient, "request">,
  collabs: Collaboration[],
): Promise<Map<string, TablePending>> {
  const live = collabs.filter(isLiveTable);
  const [approvals, histories] = await Promise.all([
    client.request("approvals.list", {}),
    Promise.all(live.map((c) => client.request("collaborations.history", { id: c.id }))),
  ]);
  const map = new Map<string, TablePending>();
  live.forEach((c, i) => {
    const pending = tablePending(c, approvals, histories[i]?.messages ?? []);
    if (pending) map.set(c.id, pending);
  });
  return map;
}

/** The bucket each filter shows; "stopped" only exists under "Todas". */
export function filterTables(
  collabs: Collaboration[],
  filter: TableFilter,
  pending: Map<string, TablePending>,
): Collaboration[] {
  switch (filter) {
    case "aguardando":
      return collabs.filter((c) => isLiveTable(c) && pending.has(c.id));
    case "discussao":
      return collabs.filter((c) => isLiveTable(c) && !pending.has(c.id));
    case "resolvidas":
      return collabs.filter((c) => c.status === "done");
    default:
      return collabs;
  }
}

/** Sidebar badge: tables still in play (not done, not stopped). */
export function openTableCount(collabs: Collaboration[]): number {
  return collabs.filter(isLiveTable).length;
}
