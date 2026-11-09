import { z } from "zod";
import { ToolMode } from "./templates";

// ---- Tasks: a first-class unit of work over an agent session ----

/** run = working, wait = a permission/approval is pending, muted = paused by the user. */
export const TaskSituation = z.enum(["run", "wait", "muted", "done"]);
export type TaskSituation = z.infer<typeof TaskSituation>;
export const TaskOutcome = z.enum(["completed", "stopped", "failed"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;
/** Where the agent may work: both, browser only or terminal (code, scripts, files) only. */
export const TaskToolMode = ToolMode;
export type TaskToolMode = z.infer<typeof TaskToolMode>;

export const Task = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  prompt: z.string(),
  situation: TaskSituation,
  outcome: TaskOutcome.nullable(),
  private: z.boolean(),
  toolMode: TaskToolMode,
  requireApproval: z.boolean(),
  /** Provider session id once the task's session started. */
  sessionId: z.string().nullable(),
  routineId: z.string().nullable(),
  templateId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
  deliveryCount: z.number().int(),
});
export type Task = z.infer<typeof Task>;

export const TaskDelivery = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["file", "link", "message"]),
  name: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  mime: z.string().nullable(),
  size: z.number().int().nullable(),
  createdAt: z.number(),
});
export type TaskDelivery = z.infer<typeof TaskDelivery>;

/** Per-task defaults stored in settings.task_defaults (profile settings). */
export const TaskDefaults = z.object({
  private: z.boolean().optional(),
  toolMode: TaskToolMode.optional(),
  requireApproval: z.boolean().optional(),
});
export type TaskDefaults = z.infer<typeof TaskDefaults>;

const TaskId = z.object({ id: z.string() }).strict();
const TaskText = z.string().trim().min(1).max(100_000);

export const TasksCreateParams = z
  .object({
    agentId: z.string().optional(),
    text: TaskText,
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          mime: z.string().max(255),
          dataBase64: z.string().max(36_000_000),
        }),
      )
      .max(10)
      .optional(),
    private: z.boolean().optional(),
    toolMode: TaskToolMode.optional(),
    requireApproval: z.boolean().optional(),
    templateId: z.string().max(200).optional(),
  })
  .strict();
export const TasksListParams = z
  .object({
    situation: TaskSituation.optional(),
    agentId: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
    /** Live views only: adds private tasks that are not done. Never lists done private tasks. */
    includePrivate: z.boolean().optional(),
  })
  .strict();
export const TasksListResult = z.object({
  items: z.array(Task),
  nextCursor: z.string().nullable(),
});
export const TasksGetParams = TaskId;
export const TasksHistoryParams = z
  .object({
    id: z.string(),
    before: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const TasksInstructParams = z.object({ id: z.string(), text: TaskText }).strict();
export const TasksInstructResult = z.object({ queueId: z.string(), task: Task });
export const TasksIdParams = TaskId;
export const TasksRenameParams = z
  .object({ id: z.string(), title: z.string().trim().min(1).max(200) })
  .strict();
export const TasksSearchParams = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const TasksDeliveriesParams = z
  .object({ limit: z.number().int().min(1).max(200).optional(), taskId: z.string().optional() })
  .strict();
