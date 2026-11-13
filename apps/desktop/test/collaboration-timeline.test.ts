import { describe, expect, test } from "bun:test";
import type { Approval, CollaborationMessage } from "@boto/protocol";
import { mergeTimeline } from "../src/lib/collaboration-timeline";

const msg = (over: Partial<CollaborationMessage> & { id: string; createdAt: number }) =>
  ({
    collaborationId: "c1",
    kind: "message",
    fromAgentId: "a1",
    toAgentId: "a2",
    text: "hi",
    answeredAt: null,
    ...over,
  }) as CollaborationMessage;

const ap = (over: Partial<Approval> & { id: string; createdAt: number }) =>
  ({
    agentId: "a2",
    turnId: "t1",
    kind: "tool",
    title: "Publicar página",
    detail: "d",
    tool: "page_publish",
    secretName: null,
    background: false,
    status: "pending",
    expiresAt: 0,
    ...over,
  }) as Approval;

describe("mergeTimeline", () => {
  test("merges messages and approvals sorted by createdAt, filtered to the table", () => {
    const items = mergeTimeline(
      [msg({ id: "m1", createdAt: 10 }), msg({ id: "m3", createdAt: 30 })],
      [
        ap({ id: "a1", createdAt: 20, collaborationId: "c1" }),
        ap({ id: "a2", createdAt: 25, collaborationId: "other" }),
      ],
      "c1",
    );
    expect(items.map((i) => i.key)).toEqual(["m1", "ap-a1", "m3"]);
    expect(items[1]?.kind).toBe("approval");
  });

  test("empty inputs produce an empty timeline", () => {
    expect(mergeTimeline([], [], "c1")).toEqual([]);
  });
});
