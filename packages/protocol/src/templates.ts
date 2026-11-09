import { z } from "zod";

export const ToolMode = z.enum(["both", "browser", "terminal"]);
export type ToolMode = z.infer<typeof ToolMode>;
export const TemplateKind = z.enum(["task", "routine"]);
export const When = z.enum(["now", "in1h", "tomorrow", "daily", "weekly"]);
export type When = z.infer<typeof When>;
export const WHEN_SCHEDULES = { daily: "daily 08:00", weekly: "weekly mon 09:00" } as const;

export function whenToRoutine(
  when: When,
  now = Date.now(),
): { runAt: number | null; schedule: string | null } | null {
  if (when === "now") return null;
  if (when === "in1h") return { runAt: now + 3_600_000, schedule: null };
  if (when === "tomorrow") {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    date.setHours(8, 0, 0, 0);
    return { runAt: date.getTime(), schedule: null };
  }
  return { runAt: null, schedule: WHEN_SCHEDULES[when] };
}

const TemplateFields = {
  kind: TemplateKind,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000),
  prompt: z.string().trim().min(1).max(20_000),
  icon: z.string().trim().min(1).max(80),
  toolMode: ToolMode,
  requireApproval: z.boolean(),
  schedule: z.string().trim().min(1).max(64).nullable(),
};
export const Template = z.object({
  id: z.string(),
  ...TemplateFields,
  builtin: z.boolean(),
  hidden: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Template = z.infer<typeof Template>;
const id = z.object({ id: z.string() }).strict();
const fields = z.object(TemplateFields);
export const templateMethods = {
  "templates.list": {
    params: z.object({ includeHidden: z.boolean().optional() }).strict(),
    result: z.array(Template),
  },
  "templates.create": {
    params: fields.partial().required({ kind: true, name: true, prompt: true }).strict(),
    result: Template,
  },
  "templates.update": {
    params: fields.partial().extend({ id: z.string() }).strict(),
    result: Template,
  },
  "templates.delete": { params: id, result: z.object({ ok: z.literal(true) }) },
  "templates.restore": { params: id, result: Template },
  "templates.use": {
    params: id,
    result: z.object({
      templateId: z.string(),
      prompt: z.string(),
      toolMode: ToolMode,
      requireApproval: z.boolean(),
      when: When.nullable(),
      schedule: z.string().nullable(),
    }),
  },
};
