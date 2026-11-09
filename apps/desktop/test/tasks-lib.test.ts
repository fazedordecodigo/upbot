import { describe, expect, test } from "bun:test";
import type { Task, TaskDelivery } from "@boto/protocol";
import { addDelivery, taskLanes, upsertTask } from "../src/lib/tasks";

const task = (id: string, createdAt: number, over: Partial<Task> = {}): Task => ({
  id,
  agentId: "a",
  title: id,
  prompt: id,
  situation: "run",
  outcome: null,
  private: false,
  toolMode: "both",
  requireApproval: true,
  sessionId: null,
  routineId: null,
  templateId: null,
  createdAt,
  updatedAt: createdAt,
  endedAt: null,
  deliveryCount: 0,
  ...over,
});

describe("tasks lib", () => {
  test("upsertTask keeps newest first, replaces by id and drops done private tasks", () => {
    let list = upsertTask([], task("old", 1));
    list = upsertTask(list, task("new", 2));
    expect(list.map((t) => t.id)).toEqual(["new", "old"]);
    list = upsertTask(list, task("old", 1, { situation: "wait" }));
    expect(list.find((t) => t.id === "old")?.situation).toBe("wait");
    list = upsertTask(list, task("new", 2, { private: true, situation: "done" }));
    expect(list.map((t) => t.id)).toEqual(["old"]);
  });

  test("taskLanes splits running/paused from waiting", () => {
    const lanes = taskLanes([
      task("r", 3),
      task("w", 2, { situation: "wait" }),
      task("m", 1, { situation: "muted" }),
      task("d", 0, { situation: "done", outcome: "completed" }),
    ]);
    expect(lanes.running.map((t) => t.id)).toEqual(["r", "m"]);
    expect(lanes.waiting.map((t) => t.id)).toEqual(["w"]);
  });

  test("addDelivery prepends, dedupes and caps", () => {
    const d = (id: string): TaskDelivery => ({
      id,
      taskId: "t",
      kind: "file",
      name: id,
      path: null,
      url: null,
      mime: null,
      size: null,
      createdAt: 0,
    });
    expect(addDelivery([d("a"), d("b")], d("a"), 2).map((x) => x.id)).toEqual(["a", "b"]);
    expect(addDelivery([d("a"), d("b")], d("c"), 2).map((x) => x.id)).toEqual(["c", "a"]);
  });
});
