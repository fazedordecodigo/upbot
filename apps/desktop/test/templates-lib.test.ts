import { expect, test } from "bun:test";
import type { Template } from "@boto/protocol";
import { templateMeta, templateScheduleLabel } from "../src/lib/templates";

const template: Template = {
  id: "custom",
  kind: "task",
  name: "Modelo",
  description: "",
  prompt: "Trabalhar",
  icon: "file-text",
  toolMode: "both",
  requireApproval: true,
  schedule: null,
  builtin: false,
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
};

test("template metadata comes from actual approval, tools and schedule settings", () => {
  expect(templateMeta(template)).toBe("Agora · com aprovação");
  expect(templateMeta({ ...template, requireApproval: false })).toBe("Agora");
  expect(templateMeta({ ...template, toolMode: "browser", requireApproval: false })).toBe(
    "Agora · só navegador",
  );
  expect(templateMeta({ ...template, toolMode: "terminal" })).toBe(
    "Agora · só terminal · com aprovação",
  );
  expect(templateMeta({ ...template, kind: "routine", schedule: "weekly mon 09:00" })).toBe(
    "Rotina · segunda às 9h",
  );
  expect(templateMeta({ ...template, kind: "routine", schedule: "daily 08:00" })).toBe(
    "Rotina · todo dia às 8h",
  );
});

test("schedule labels cover the real daemon grammar and unknown values honestly", () => {
  for (const [schedule, label] of [
    ["daily 08:30", "todo dia às 8h30"],
    ["daily 0:00", "todo dia às 0h"],
    [" WEEKLY   fri 17:45 ", "sexta às 17h45"],
    ["weekly tue 09:00", "terça às 9h"],
    ["weekly wed 09:00", "quarta às 9h"],
    ["weekly thu 09:00", "quinta às 9h"],
    ["weekly sat 09:00", "sábado às 9h"],
    ["weekly sun 09:00", "domingo às 9h"],
    ["every 1m", "a cada 1 minuto"],
    ["every 30m", "a cada 30 minutos"],
    ["every 1 h", "a cada 1 hora"],
    ["every 2h", "a cada 2 horas"],
    ["every 1d", "a cada 1 dia"],
    ["every 3d", "a cada 3 dias"],
    ["invalid", "a definir"],
    [null, "a definir"],
  ] as const)
    expect(templateScheduleLabel(schedule)).toBe(label);
});
