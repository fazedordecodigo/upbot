import type { AgentOverview } from "@boto/protocol";

export function relativeTime(since: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - since) / 60000));
  return minutes < 1
    ? "agora"
    : minutes < 60
      ? `há ${minutes} min`
      : minutes < 1440
        ? `há ${Math.floor(minutes / 60)} h`
        : `há ${Math.floor(minutes / 1440)} dias`;
}

export function agentStatus(agent: AgentOverview) {
  if (agent.situation === "run")
    return { text: "Trabalhando", icon: "loader", tone: "run" } as const;
  if (agent.situation === "wait")
    return { text: "Aguardando você", icon: "circle-alert", tone: "wait" } as const;
  if (agent.situation === "error")
    return { text: "Com erro", icon: "circle-alert", tone: "muted" } as const;
  if (agent.paused) return { text: "Fila pausada", icon: "circle-pause", tone: "muted" } as const;
  return { text: "Livre", icon: "circle-check", tone: "done" } as const;
}
