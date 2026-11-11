import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AgentStore } from "../src/agents";
import { ChatStore, QueueStore } from "../src/chat-store";
import { migrations } from "../src/db/migrations";
import { RpcError } from "../src/runtime/agent-runtime";
import type { RuntimeManager } from "../src/runtime/runtime-manager";
import { TaskService } from "../src/tasks";

function setup() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of migrations) db.exec(sql);
  const events: { event: string; data: unknown }[] = [];
  const calls = { removed: 0, cancelled: 0 };
  const runtimes = {
    removeTaskQueue: () => {
      calls.removed++;
      return 0;
    },
    cancelTask: () => {
      calls.cancelled++;
    },
  } as unknown as RuntimeManager;
  const tasks = new TaskService(
    db,
    new AgentStore(db, ":memory:"),
    new ChatStore(db),
    new QueueStore(db),
    () => runtimes,
    (event, data) => events.push({ event, data }),
    { pendingApprovals: () => [], routines: () => [], defaults: () => ({}) },
  );
  return { db, tasks, events, calls };
}

const count = (db: Database, table: string, where = "") =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;

function seed(db: Database) {
  db.query(
    "INSERT INTO agents (id, name, provider, workspace_path, created_at, updated_at) VALUES ('a1', 'A', 'devin', '/tmp', 0, 0)",
  ).run();
  // a finished task with every related row; items/queue rows predating the
  // task_id column point at its turn with task_id NULL (turn1 vs i2/q2)
  db.query(
    "INSERT INTO tasks (id, agent_id, title, prompt, situation, created_at, updated_at) VALUES ('t1', 'a1', 'old', 'p', 'done', 0, 0)",
  ).run();
  db.query(
    "INSERT INTO turns (id, agent_id, status, started_at, task_id) VALUES ('turn1', 'a1', 'completed', 0, 't1')",
  ).run();
  db.query(
    "INSERT INTO items (id, agent_id, turn_id, kind, data_json, created_at, updated_at, task_id) VALUES ('i1', 'a1', 'turn1', 'user_message', '{}', 0, 0, 't1')",
  ).run();
  db.query(
    "INSERT INTO items (id, agent_id, turn_id, kind, data_json, created_at, updated_at, task_id) VALUES ('i2', 'a1', 'turn1', 'agent_message', '{}', 0, 0, NULL)",
  ).run();
  db.query(
    "INSERT INTO queue (id, agent_id, text, status, turn_id, created_at, task_id) VALUES ('q1', 'a1', 'x', 'started', 'turn1', 0, 't1')",
  ).run();
  db.query(
    "INSERT INTO queue (id, agent_id, text, status, turn_id, created_at, task_id) VALUES ('q2', 'a1', 'x', 'done', 'turn1', 0, NULL)",
  ).run();
  db.query(
    "INSERT INTO turn_memory_usage (turn_id, memory_id, kind, text) VALUES ('turn1', 'm1', 'agent', 'x')",
  ).run();
  db.query(
    "INSERT INTO task_deliveries (id, task_id, kind, name, created_at) VALUES ('d1', 't1', 'message', 'm', 0)",
  ).run();
  db.query(
    "INSERT INTO agent_sessions (agent_id, provider, session_id, created_at, updated_at, task_id) VALUES ('a1', 'devin', 's1', 0, 0, 't1')",
  ).run();
  // a plain-chat turn the delete must not touch
  db.query(
    "INSERT INTO turns (id, agent_id, status, started_at, task_id) VALUES ('chat', 'a1', 'completed', 0, NULL)",
  ).run();
  db.query(
    "INSERT INTO items (id, agent_id, turn_id, kind, data_json, created_at, updated_at, task_id) VALUES ('i3', 'a1', 'chat', 'user_message', '{}', 0, 0, NULL)",
  ).run();
  // a second task, still live
  db.query(
    "INSERT INTO tasks (id, agent_id, title, prompt, situation, created_at, updated_at) VALUES ('t2', 'a1', 'live', 'p', 'run', 0, 0)",
  ).run();
  db.query(
    "INSERT INTO turns (id, agent_id, status, started_at, task_id) VALUES ('turn2', 'a1', 'running', 0, 't2')",
  ).run();
  db.query(
    "INSERT INTO queue (id, agent_id, text, status, task_id, created_at) VALUES ('q3', 'a1', 'x', 'queued', 't2', 0)",
  ).run();
}

test("tasks.delete removes a finished task and every row referencing it", () => {
  const { db, tasks, events, calls } = setup();
  seed(db);
  tasks.delete("t1");
  expect(events).toEqual([{ event: "task.deleted", data: { id: "t1" } }]);
  expect(calls).toEqual({ removed: 0, cancelled: 0 });
  for (const table of [
    "tasks",
    "turns",
    "items",
    "queue",
    "turn_memory_usage",
    "task_deliveries",
    "agent_sessions",
  ]) {
    const taskFilter =
      table === "tasks"
        ? "WHERE id = 't1'"
        : table === "turns"
          ? "WHERE task_id = 't1'"
          : table === "turn_memory_usage"
            ? "WHERE turn_id = 'turn1'"
            : table === "agent_sessions"
              ? "WHERE task_id = 't1'"
              : table === "items" || table === "queue"
                ? "WHERE task_id = 't1' OR turn_id = 'turn1'"
                : "WHERE task_id = 't1'";
    expect(count(db, table, taskFilter)).toBe(0);
  }
  // the plain chat turn and its item stay
  expect(count(db, "turns")).toBe(2);
  expect(count(db, "items")).toBe(1);
  expect(count(db, "queue")).toBe(1);
});

test("tasks.delete stops a live task before removing it", () => {
  const { db, tasks, calls } = setup();
  seed(db);
  tasks.delete("t2");
  expect(calls).toEqual({ removed: 1, cancelled: 1 });
  expect(count(db, "tasks", "WHERE id = 't2'")).toBe(0);
  expect(count(db, "turns", "WHERE task_id = 't2'")).toBe(0);
  expect(count(db, "queue", "WHERE task_id = 't2'")).toBe(0);
  expect(count(db, "turns")).toBe(2);
});

test("tasks.delete rejects a missing task", () => {
  const { tasks } = setup();
  try {
    tasks.delete("missing");
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe("not_found");
  }
});
