import type { Routine } from "@boto/protocol";

export function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "a definir";
  const date = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(value);
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(
    value,
  );
  return `${date} às ${time}`;
}

export function formatSchedule(
  routine: Pick<Routine, "schedule" | "runAt" | "webhook"> & Partial<Pick<Routine, "lastRunAt">>,
): string {
  if (routine.runAt != null)
    return routine.lastRunAt != null
      ? `Executada em ${formatDate(routine.lastRunAt)}`
      : `Em ${formatDate(routine.runAt)}`;
  const schedule = routine.schedule?.trim().toLowerCase();
  if (!schedule) return routine.webhook ? "Por webhook" : "a definir";
  const interval = /^every\s+(\d+)\s*(m|h|d)$/.exec(schedule);
  if (interval && Number(interval[1]) > 0) {
    const unit =
      interval[2] === "m"
        ? "min"
        : interval[2] === "h"
          ? "h"
          : Number(interval[1]) === 1
            ? "dia"
            : "dias";
    return `A cada ${Number(interval[1])} ${unit}`;
  }
  const daily = /^daily\s+((?:[01]?\d|2[0-3]):[0-5]\d)$/.exec(schedule);
  if (daily) return `Todo dia às ${daily[1]!.padStart(5, "0")}`;
  const weekly = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+((?:[01]?\d|2[0-3]):[0-5]\d)$/.exec(
    schedule,
  );
  if (weekly) {
    const days: Record<string, string> = {
      sun: "Todo domingo",
      mon: "Toda segunda",
      tue: "Toda terça",
      wed: "Toda quarta",
      thu: "Toda quinta",
      fri: "Toda sexta",
      sat: "Todo sábado",
    };
    return `${days[weekly[1] ?? ""]} às ${weekly[2]!.padStart(5, "0")}`;
  }
  return "a definir";
}

export function formatNextRun(
  routine: Pick<Routine, "enabled" | "nextRunAt" | "runAt" | "lastRunAt">,
): string {
  if (routine.runAt != null) return "";
  if (routine.enabled && routine.nextRunAt != null)
    return `Próxima: ${formatDate(routine.nextRunAt)}`;
  return "a definir";
}
