import { z } from "zod";

// Collaborations ("mesas"): a lead bot gathers other bots to talk pair-to-pair and
// solve one problem. Every addressed message is recorded in the table transcript
// (visible to all); the leader drives phases, invites/removes members and concludes
// with a summary that goes back to the originating task or chat.

export const CollaborationStatus = z.enum(["active", "paused", "done", "stopped"]);
export type CollaborationStatus = z.infer<typeof CollaborationStatus>;

export const CollaborationPhase = z.enum([
  "entender",
  "investigar",
  "corrigir",
  "verificar",
  "avisar",
]);
export type CollaborationPhase = z.infer<typeof CollaborationPhase>;

export const CollaborationMessageKind = z.enum([
  "message",
  "instruction",
  "request",
  "system",
  "phase",
  "summary",
]);
export type CollaborationMessageKind = z.infer<typeof CollaborationMessageKind>;

export const CollaborationMember = z.object({
  agentId: z.string(),
  role: z.enum(["leader", "member"]),
});
export type CollaborationMember = z.infer<typeof CollaborationMember>;

export const Collaboration = z.object({
  id: z.string(),
  title: z.string(),
  problem: z.string(),
  leaderId: z.string(),
  members: z.array(CollaborationMember),
  status: CollaborationStatus,
  phase: CollaborationPhase,
  stats: z.object({
    members: z.number(),
    messages: z.number(),
    actions: z.number(),
    elapsedMs: z.number(),
  }),
  summary: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type Collaboration = z.infer<typeof Collaboration>;

export const CollaborationMessage = z.object({
  id: z.string(),
  collaborationId: z.string(),
  seq: z.number(),
  kind: CollaborationMessageKind,
  /** null = the user (or the system for system/phase rows). */
  fromAgentId: z.string().nullable(),
  /** null = the user. */
  toAgentId: z.string().nullable(),
  text: z.string(),
  answeredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type CollaborationMessage = z.infer<typeof CollaborationMessage>;

const CollaborationIdParams = z.object({ id: z.string() }).strict();

export const CollaborationsCreateParams = z
  .object({
    problem: z.string().trim().min(1).max(20_000),
    title: z.string().trim().min(1).max(80).optional(),
    memberIds: z.array(z.string()).min(1).max(8),
    leaderId: z.string(),
  })
  .strict();

export const CollaborationsHistoryParams = z
  .object({ id: z.string(), limit: z.number().int().min(1).max(1000).optional() })
  .strict();
export const CollaborationsHistoryResult = z.object({
  collaboration: Collaboration,
  messages: z.array(CollaborationMessage),
});

export const CollaborationsInstructParams = z
  .object({ id: z.string(), text: z.string().trim().min(1).max(100_000) })
  .strict();

export const CollaborationsAnswerParams = z
  .object({
    id: z.string(),
    messageId: z.string(),
    text: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const CollaborationsConcludeParams = z
  .object({ id: z.string(), summary: z.string().trim().min(1).max(100_000) })
  .strict();

export const collaborationMethods = {
  "collaborations.list": { params: z.object({}).strict(), result: z.array(Collaboration) },
  "collaborations.get": { params: CollaborationIdParams, result: Collaboration },
  "collaborations.history": {
    params: CollaborationsHistoryParams,
    result: CollaborationsHistoryResult,
  },
  "collaborations.create": { params: CollaborationsCreateParams, result: Collaboration },
  "collaborations.instruct": {
    params: CollaborationsInstructParams,
    result: z.object({ messageId: z.string() }),
  },
  "collaborations.answer": {
    params: CollaborationsAnswerParams,
    result: CollaborationMessage,
  },
  "collaborations.pause": { params: CollaborationIdParams, result: Collaboration },
  "collaborations.resume": { params: CollaborationIdParams, result: Collaboration },
  "collaborations.stop": { params: CollaborationIdParams, result: Collaboration },
  "collaborations.conclude": { params: CollaborationsConcludeParams, result: Collaboration },
} as const;

export type CollaborationEventMap = {
  "collaboration.created": Collaboration;
  "collaboration.updated": Collaboration;
  "collaboration.message": CollaborationMessage;
};
