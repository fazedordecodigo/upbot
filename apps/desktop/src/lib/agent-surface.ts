import type { AgentPlacement, RemoteHost } from "@boto/protocol";
import type { UiStatus } from "./ui";

export type AgentSituation = "working" | "waiting" | "idle" | "paused";
export type AgentFilter = "all" | AgentSituation;

export function agentSituation(
  input: { status: UiStatus; paused: boolean } | undefined,
): AgentSituation {
  if (!input) return "idle";
  if (input.status === "wait") return "waiting";
  if (input.status === "run") return "working";
  if (input.paused) return "paused";
  return "idle";
}

export function matchesFilter(filter: AgentFilter, situation: AgentSituation) {
  return filter === "all" || filter === situation;
}

export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return "Bom dia.";
  if (hour < 18) return "Boa tarde.";
  return "Boa noite.";
}

/** 0/1: uma instância ocupada só com microVM Firecracker ou sessão ativa. */
export function workspaceOf(
  agentId: string,
  placements: AgentPlacement[] | undefined,
  hosts: RemoteHost[] | undefined,
  status: UiStatus | undefined,
) {
  const placement = placements?.find((item) => item.agentId === agentId);
  const host = placement?.hostId ? hosts?.find((item) => item.id === placement.hostId) : undefined;
  const occupied = placement?.isolation === "firecracker" || status === "run";
  let machine = "…";
  if (placements) {
    if (host?.name) machine = host.name;
    else if (placement?.isolation === "firecracker") machine = "microvm";
    else machine = "neste-computador";
  }
  let slots = "—";
  if (placements) slots = occupied ? "1/1" : "0/1";
  else if (status === "run") slots = "1/1";
  return { placement, machine, occupied, slots };
}
