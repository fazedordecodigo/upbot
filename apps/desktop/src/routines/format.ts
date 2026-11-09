import type { Routine } from "@boto/protocol";

export function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "a definir";
  const date = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(value);
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(
    value,
  );
  return `${date} às ${time}`;
}

export function formatSchedule(routine: Pick<Routine, "schedule" | "runAt" | "webhook">): string {
  if (routine.runAt != null) return `Em ${formatDate(routine.runAt)}`;
  const schedule = routine.schedule;
  if (!schedule) return routine.webhook ? "Por webhook" : "a definir";
  const interval = /^every ([1-9]\d*)(m|h|d)$/.exec(schedule);
  if (interval) {
    const unit =
      interval[2] === "m"
        ? "min"
        : interval[2] === "h"
          ? "h"
          : Number(interval[1]) === 1
            ? "dia"
            : "dias";
    return `A cada ${interval[1]} ${unit}`;
  }
  const daily = /^daily ((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(schedule);
  if (daily) return `Todo dia às ${daily[1]}`;
  const weekly = /^weekly (sun|mon|tue|wed|thu|fri|sat) ((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
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
    return `${days[weekly[1] ?? ""]} às ${weekly[2]}`;
  }
  return "a definir";
}

export function formatNextRun(
  routine: Pick<Routine, "enabled" | "nextRunAt" | "runAt" | "lastRunAt">,
): string {
  if (routine.runAt != null && !routine.enabled && routine.lastRunAt != null)
    return `Executada em ${formatDate(routine.lastRunAt)}`;
  if (routine.enabled && routine.nextRunAt != null)
    return `Próxima: ${formatDate(routine.nextRunAt)}`;
  return "a definir";
}
