import { z } from "zod";

/** Upper bound for parallel instances of one agent. */
export const AGENT_MAX_INSTANCES = 10;

export const AgentRole = z.string().trim().max(140);
export const AgentMaxInstances = z.number().int().min(1).max(AGENT_MAX_INSTANCES);

/** Cockpit fields of an agent: role ("O que ele faz"), approval policy and capacity. */
export const AgentCockpitFields = {
  role: z.string().max(140),
  requireApproval: z.boolean(),
  /** null = not set by the user ("a definir"); the scheduler then runs one instance. */
  maxInstances: AgentMaxInstances.nullable(),
};

export const AgentCockpitParams = {
  role: AgentRole.optional(),
  requireApproval: z.boolean().optional(),
  maxInstances: AgentMaxInstances.nullable().optional(),
};

export const AgentSituation = z.enum(["run", "wait", "idle", "error"]);
export type AgentSituation = z.infer<typeof AgentSituation>;

/** A unit of work held by an agent: a started turn or a queued request. */
export const AgentTaskRef = z.object({
  /** Queue item id (stable identity of the request). */
  id: z.string(),
  /** Task id when the request belongs to a task, else null. */
  taskId: z.string().nullable(),
  /** Running turn, null while still queued. */
  turnId: z.string().nullable(),
  title: z.string(),
  /** startedAt for running/waiting work. */
  since: z.number(),
});
export type AgentTaskRef = z.infer<typeof AgentTaskRef>;

export const AgentOverview = z.object({
  agentId: z.string(),
  situation: AgentSituation,
  /** Last runtime error when situation is "error". */
  error: z.string().nullable(),
  paused: z.boolean(),
  instances: z.object({
    active: z.number().int().min(0),
    /** Agent.maxInstances (null = "a definir"). */
    max: z.number().int().nullable(),
    /** Effective parallel limit the scheduler applies (max ?? 1). */
    capacity: z.number().int().min(1),
  }),
  running: z.array(AgentTaskRef),
  /** Started work blocked on the user (permission or approval). */
  waiting: z.array(AgentTaskRef),
  queued: z.number().int().min(0),
  machines: z.array(z.string()),
});
export type AgentOverview = z.infer<typeof AgentOverview>;

export const AgentsOverviewSummary = z.object({
  agents: z.number().int().min(0),
  running: z.number().int().min(0),
  waiting: z.number().int().min(0),
  queued: z.number().int().min(0),
});
export type AgentsOverviewSummary = z.infer<typeof AgentsOverviewSummary>;

export const AgentsOverviewParams = z.object({}).strict();
export const AgentsOverviewResult = z.object({
  agents: z.array(AgentOverview),
  summary: AgentsOverviewSummary,
});
export type AgentsOverviewResult = z.infer<typeof AgentsOverviewResult>;

export const agentsCockpitMethods = {
  "agents.overview": { params: AgentsOverviewParams, result: AgentsOverviewResult },
} as const;

export type AgentsCockpitEventMap = {
  "agents.overviewChanged": AgentsOverviewResult;
};
