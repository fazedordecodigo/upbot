import type { Agent, AgentStatusInfo, ProviderId, Turn } from "@boto/protocol";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  devin: "Devin",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
  aider: "Aider",
  "openai-compatible": "Compatível com OpenAI",
};

export function statusProvider(provider: ProviderId) {
  return PROVIDER_NAMES[provider];
}

export const ST = {
  run: "Em execução",
  wait: "Aguardando você",
  ok: "Concluído",
  idle: "Disponível",
  queue: "Na fila",
  err: "Com erro",
} as const;

export type UiStatus = keyof typeof ST;

/** Tons do DESIGN (§7). `wait` só para aprovação ou permissão; `queue` e `err` caem em `muted`. */
export type StatusTone = "run" | "wait" | "muted" | "done";

const STATUS_TONE: Record<UiStatus, StatusTone> = {
  run: "run",
  wait: "wait",
  queue: "muted",
  err: "muted",
  ok: "done",
  idle: "done",
};

export function statusTone(status: UiStatus): StatusTone {
  return STATUS_TONE[status];
}

export function mono(name: string) {
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1, 2)}`;
}

export function role(agent: Pick<Agent, "instructions" | "provider">) {
  const first = agent.instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 80) : `Bot ${agent.provider}`;
}

export function fmtTime(ms: number | null | undefined, now = Date.now()) {
  if (ms == null) return "—";
  const date = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today))
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, yesterday)) return "ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function status(
  live: AgentStatusInfo["status"] | undefined,
  queued: number,
  latestTurn: Turn | null,
  pendingApprovals = 0,
): UiStatus {
  if (live === "awaiting_permission" || pendingApprovals > 0) return "wait";
  if (live === "starting" || live === "running") return "run";
  if (live === "error") return "err";
  if (queued > 0) return "queue";
  if (latestTurn?.status === "completed") return "ok";
  if (latestTurn?.status === "failed") return "err";
  return "idle";
}
