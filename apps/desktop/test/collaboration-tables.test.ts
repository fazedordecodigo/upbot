import { expect, test } from "bun:test";
import type { Approval, Collaboration, CollaborationMessage } from "@boto/protocol";
import {
  filterTables,
  openTableCount,
  tablePendencies,
  tablePending,
} from "../src/lib/collaboration-tables";
import type { DaemonClient } from "../src/lib/daemon";

const collab = (over: Partial<Collaboration> = {}): Collaboration => ({
  id: "c1",
  title: "Mesa",
  problem: "problema",
  leaderId: "a1",
  members: [
    { agentId: "a1", role: "leader" },
    { agentId: "a2", role: "member" },
  ],
  status: "active",
  phase: "investigar",
  topology: "mesh",
  askExternal: false,
  checkpointPhases: false,
  useMemory: false,
  phasePending: null,
  stats: { members: 2, messages: 0, actions: 0, elapsedMs: 0 },
  summary: null,
  createdAt: 0,
  updatedAt: 0,
  endedAt: null,
  ...over,
});

const request = (over: Partial<CollaborationMessage> = {}): CollaborationMessage => ({
  id: "m1",
  collaborationId: "c1",
  seq: 1,
  kind: "request",
  fromAgentId: "a2",
  toAgentId: null,
  text: "posso seguir?",
  answeredAt: null,
  createdAt: 0,
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  agentId: "a2",
  turnId: "t1",
  collaborationId: "c1",
  kind: "tool",
  title: "Run page_publish",
  detail: "",
  tool: "page_publish",
  secretName: null,
  background: false,
  status: "pending",
  createdAt: 0,
  expiresAt: 1,
  ...over,
});

function client(
  handlers: Record<string, (params: unknown) => unknown>,
  calls: string[] = [],
): Pick<DaemonClient, "request"> {
  return {
    request: (async (method: string, params: unknown) => {
      calls.push(method);
      const h = handlers[method];
      if (!h) throw new Error(`Unexpected ${method}`);
      return h(params);
    }) as DaemonClient["request"],
  };
}

test("a pendency is a pending approval on the table or an unanswered request", () => {
  const c = collab();
  expect(tablePending(c, [], [])).toBeNull();
  // approvals on other tables and decided approvals do not count
  expect(tablePending(c, [approval({ collaborationId: "other" })], [])).toBeNull();
  expect(tablePending(c, [approval({ status: "approved" })], [])).toBeNull();
  // an unanswered request is a pendency; the approval wins when both exist
  const pend = tablePending(c, [], [request()]);
  expect(pend?.kind).toBe("request");
  expect(tablePending(c, [], [request({ answeredAt: 1 })])).toBeNull();
  const both = tablePending(c, [approval()], [request()]);
  expect(both?.kind).toBe("approval");
});

test("tablePendencies joins approvals and history per live table only", async () => {
  const calls: string[] = [];
  const histories: Record<string, CollaborationMessage[]> = {
    live1: [request({ collaborationId: "live1" })],
    live2: [],
  };
  const stub = client(
    {
      "approvals.list": () => [approval({ collaborationId: "live2" })],
      "collaborations.history": (p) => ({
        collaboration: null,
        messages: histories[(p as { id: string }).id] ?? [],
      }),
    },
    calls,
  );
  const collabs = [
    collab({ id: "live1" }),
    collab({ id: "live2", status: "paused" }),
    collab({ id: "done1", status: "done" }),
    collab({ id: "stop1", status: "stopped" }),
  ];
  const map = await tablePendencies(stub, collabs);
  expect(map.get("live1")?.kind).toBe("request");
  expect(map.get("live2")?.kind).toBe("approval");
  expect(map.has("done1")).toBe(false);
  expect(map.has("stop1")).toBe(false);
  // history is fetched for live tables only — done and stopped cost nothing
  const historyCalls = calls.filter((m) => m === "collaborations.history").length;
  expect(historyCalls).toBe(2);
});

test("the four filters derive the right sets", () => {
  const live = collab({ id: "live" });
  const waiting = collab({ id: "waiting" });
  const done = collab({ id: "done", status: "done" });
  const stopped = collab({ id: "stopped", status: "stopped" });
  const all = [live, waiting, done, stopped];
  const pending = new Map([["waiting", { kind: "approval", approval: approval() } as const]]);
  expect(filterTables(all, "todas", pending).map((c) => c.id)).toEqual([
    "live",
    "waiting",
    "done",
    "stopped",
  ]);
  expect(filterTables(all, "aguardando", pending).map((c) => c.id)).toEqual(["waiting"]);
  expect(filterTables(all, "discussao", pending).map((c) => c.id)).toEqual(["live"]);
  expect(filterTables(all, "resolvidas", pending).map((c) => c.id)).toEqual(["done"]);
});

test("the sidebar badge counts tables still in play", () => {
  const all = [
    collab({ id: "a" }),
    collab({ id: "b", status: "paused" }),
    collab({ id: "c", status: "done" }),
    collab({ id: "d", status: "stopped" }),
  ];
  expect(openTableCount(all)).toBe(2);
});
