import { expect, test } from "bun:test";
import { formatDate, formatNextRun, formatSchedule } from "../src/routines/format";

test("schedule copy follows daemon grammar without inventing unknown schedules", () => {
  const format = (schedule: string | null, webhook = false) =>
    formatSchedule({ schedule, webhook, runAt: null });
  expect(format("daily 08:00")).toBe("Todo dia às 08:00");
  for (const [day, name] of Object.entries({
    mon: "Toda segunda",
    tue: "Toda terça",
    wed: "Toda quarta",
    thu: "Toda quinta",
    fri: "Toda sexta",
    sat: "Todo sábado",
    sun: "Todo domingo",
  }))
    expect(format(`weekly ${day} 09:00`)).toBe(`${name} às 09:00`);
  expect(format("every 30m")).toBe("A cada 30 min");
  expect(format("every 2h")).toBe("A cada 2 h");
  expect(format("every 1d")).toBe("A cada 1 dia");
  expect(format("every 2d")).toBe("A cada 2 dias");
  expect(format(null, true)).toBe("Por webhook");
  for (const value of [null, "", "sometimes", "daily 25:00", "every 0m", "weekly xyz 08:00"])
    expect(format(value)).toBe("a definir");
  const date = new Date(2026, 10, 9, 8).getTime();
  expect(formatSchedule({ schedule: null, webhook: false, runAt: date })).toBe(
    "Em 9 de nov. às 08:00",
  );
  expect(formatDate(Number.NaN)).toBe("a definir");
  expect(
    formatSchedule({ schedule: null, webhook: false, runAt: date, lastRunAt: date + 60000 }),
  ).toBe("Executada em 9 de nov. às 08:01");
});

test("next run copy distinguishes executed one-shots, enabled schedules and unknown dates", () => {
  const date = new Date(2026, 10, 9, 8).getTime();
  const routine = { enabled: true, nextRunAt: date, runAt: null, lastRunAt: null };
  expect(formatNextRun(routine)).toBe(`Próxima: ${formatDate(date)}`);
  expect(formatNextRun({ ...routine, enabled: false })).toBe("a definir");
  expect(formatNextRun({ ...routine, nextRunAt: null })).toBe("a definir");
  expect(formatNextRun({ ...routine, runAt: date })).toBe("");
  expect(formatNextRun({ ...routine, enabled: false, runAt: date, lastRunAt: date })).toBe("");
});
