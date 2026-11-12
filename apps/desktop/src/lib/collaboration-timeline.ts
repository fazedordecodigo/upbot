import type { Approval, CollaborationMessage } from "@boto/protocol";

// Derivation for the detail rail: one timeline that interleaves the table's
// transcript with the approvals its members raised (joined by
// `collaborationId`), so a pendency sits in the conversation where it happened.
export type TimelineItem =
  | { kind: "message"; key: string; at: number; message: CollaborationMessage }
  | { kind: "approval"; key: string; at: number; approval: Approval };

export function mergeTimeline(
  messages: CollaborationMessage[],
  approvals: Approval[],
  collaborationId: string,
): TimelineItem[] {
  const items: TimelineItem[] = messages.map((message) => ({
    kind: "message",
    key: message.id,
    at: message.createdAt,
    message,
  }));
  for (const approval of approvals) {
    if (approval.collaborationId !== collaborationId) continue;
    items.push({ kind: "approval", key: `ap-${approval.id}`, at: approval.createdAt, approval });
  }
  return items.sort((a, b) => a.at - b.at);
}
