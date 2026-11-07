import { expect, test } from "bun:test";
import type { Approval } from "@boto/protocol";
import { ApprovalBadge } from "../src/lib/approval-badge";
import type { DaemonClient } from "../src/lib/daemon";

const approval = (id: string, overrides: Partial<Approval> = {}): Approval => ({
  id,
  agentId: "bot",
  turnId: "turn",
  kind: "tool",
  title: "Review",
  tool: "read",
  detail: "{}",
  appId: null,
  appName: null,
  permission: null,
  status: "pending",
  secretName: null,
  background: false,
  createdAt: 0,
  expiresAt: 100,
  ...overrides,
});

function setup(initial: Approval[] = []) {
  let list = initial;
  let now = 1;
  let reconnect = () => {};
  let fail = false;
  let resolveList: ((value: Approval[]) => void) | undefined;
  let defer = false;
  const listeners = new Set<(approval: Approval) => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const counts: number[] = [];
  const client = {
    request: async () => {
      if (fail) throw new Error("private error");
      if (defer)
        return new Promise<Approval[]>((resolve) => {
          resolveList = resolve;
        });
      return list;
    },
    on: (_event: string, fn: (approval: Approval) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onReconnect: (fn: () => void) => {
      reconnect = fn;
      return () => {
        reconnect = () => {};
      };
    },
  } as unknown as DaemonClient;
  const badge = new ApprovalBadge(
    client,
    async (count) => {
      counts.push(count);
    },
    () => now,
    ((fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    }) as unknown as typeof setTimeout,
    ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout,
  );
  return {
    badge,
    counts,
    listeners,
    emit: (item: Approval) => {
      for (const fn of listeners) fn(item);
    },
    sync: (items: Approval[]) => {
      list = items;
      reconnect();
    },
    expire: () => {
      now = 100;
      for (const fn of [...timers.values()]) fn();
    },
    fail: () => {
      fail = true;
      reconnect();
    },
    defer: () => {
      defer = true;
      reconnect();
    },
    resolve: (items: Approval[]) => resolveList?.(items),
  };
}

const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

test("counts only live pending approvals, deduplicates updates, and clears decisions and expiry", async () => {
  const f = setup([
    approval("one"),
    approval("one"),
    approval("two"),
    approval("done", { status: "denied" }),
    approval("old", { expiresAt: 0 }),
  ]);
  await f.badge.start();
  await flush();
  expect(f.counts).toEqual([0, 2]);
  f.emit(approval("one"));
  f.emit(approval("two", { status: "approved" }));
  await flush();
  expect(f.counts).toEqual([0, 2, 1]);
  f.expire();
  await flush();
  expect(f.counts).toEqual([0, 2, 1, 0]);
  f.badge.stop();
  expect(f.listeners.size).toBe(0);
});

test("empty startup clears, reconnect replaces stale state, stop clears and ignores late responses", async () => {
  const f = setup();
  await f.badge.start();
  f.sync([approval("new")]);
  await flush();
  f.sync([]);
  await flush();
  expect(f.counts).toEqual([0, 1, 0]);
  f.emit(approval("live"));
  f.defer();
  f.badge.stop();
  f.resolve([approval("late")]);
  await flush();
  expect(f.counts).toEqual([0, 1, 0, 1, 0]);
  expect(f.listeners.size).toBe(0);
});

test("events arriving during list requests override stale snapshots", async () => {
  const f = setup([approval("one")]);
  await f.badge.start();
  f.defer();
  f.emit(approval("one", { status: "denied" }));
  f.resolve([approval("one")]);
  await flush();
  expect(f.counts).toEqual([0, 1, 0]);
  f.badge.stop();
});

test("failed resync preserves known state and later events still update it", async () => {
  const f = setup([approval("one")]);
  await f.badge.start();
  f.fail();
  await flush();
  expect(f.counts).toEqual([0, 1]);
  f.emit(approval("one", { status: "denied" }));
  await flush();
  expect(f.counts).toEqual([0, 1, 0]);
  f.badge.stop();
});

test("native errors do not block subsequent count writes", async () => {
  const f = setup();
  const counts: number[] = [];
  const client = {
    request: async () => [approval("one")],
    on: () => () => {},
    onReconnect: () => () => {},
  } as unknown as DaemonClient;
  const badge = new ApprovalBadge(
    client,
    async (count) => {
      counts.push(count);
      if (count === 0) throw new Error("private native failure");
    },
    () => 1,
  );
  await badge.start();
  await flush();
  expect(counts).toEqual([0, 1]);
  badge.stop();
  f.badge.stop();
  await flush();
});
