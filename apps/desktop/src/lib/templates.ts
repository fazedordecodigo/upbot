import { type Template, WHEN_SCHEDULES, type When } from "@boto/protocol";

const weekdays: Record<string, string> = {
  mon: "segunda",
  tue: "terça",
  wed: "quarta",
  thu: "quinta",
  fri: "sexta",
  sat: "sábado",
  sun: "domingo",
};

function timeLabel(time: string): string {
  const [hour, minute] = time.split(":");
  return `${Number(hour)}h${minute === "00" ? "" : minute}`;
}

export function templateScheduleLabel(schedule: string | null): string {
  const value = schedule?.trim().toLowerCase() ?? "";
  const daily = /^daily\s+(\d{1,2}:\d{2})$/.exec(value);
  if (daily?.[1]) return `todo dia às ${timeLabel(daily[1])}`;
  const weekly = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}:\d{2})$/.exec(value);
  if (weekly?.[1] && weekly[2]) return `${weekdays[weekly[1]]} às ${timeLabel(weekly[2])}`;
  const interval = /^every\s+(\d+)\s*(m|h|d)$/.exec(value);
  if (interval?.[1] && interval[2]) {
    const units: Record<string, string> = { m: "minuto", h: "hora", d: "dia" };
    const count = Number(interval[1]);
    return `a cada ${count} ${units[interval[2]]}${count === 1 ? "" : "s"}`;
  }
  return "a definir";
}

export function templateMeta(template: Template): string {
  if (template.kind === "routine") return `Rotina · ${templateScheduleLabel(template.schedule)}`;
  const details = [];
  if (template.toolMode === "browser") details.push("só navegador");
  if (template.toolMode === "terminal") details.push("só terminal");
  if (template.requireApproval) details.push("com aprovação");
  return ["Agora", ...details].join(" · ");
}

export function composerScheduleLabel(schedule: string): string {
  const label = templateScheduleLabel(schedule);
  if (/^weekly\s/.test(schedule.trim().toLowerCase()))
    return `${/^(sábado|domingo)/.test(label) ? "Todo" : "Toda"} ${label}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function templateWhen(template: Template): When | undefined {
  if (template.kind !== "routine") return undefined;
  if (template.schedule === WHEN_SCHEDULES.daily) return "daily";
  if (template.schedule === WHEN_SCHEDULES.weekly) return "weekly";
  return undefined;
}
