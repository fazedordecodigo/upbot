import type { Task, TaskDelivery } from "@boto/protocol";

// Pure helpers for screens backed by tasks.* RPC and task.* events.

/** Applies a task.created / task.updated payload to a newest-first list. */
export function upsertTask(list: readonly Task[], task: Task): Task[] {
  const rest = list.filter((t) => t.id !== task.id);
  // done private tasks never stay on screen (they are not kept in history)
  if (task.private && task.situation === "done") return rest;
  return [...rest, task].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** Início lanes: "Em andamento" (run + muted) and "Aguardando você" (wait). */
export function taskLanes(list: readonly Task[]): { running: Task[]; waiting: Task[] } {
  return {
    running: list.filter((t) => t.situation === "run" || t.situation === "muted"),
    waiting: list.filter((t) => t.situation === "wait"),
  };
}

/** Applies a task.delivery payload to a newest-first list capped at `limit`. */
export function addDelivery(
  list: readonly TaskDelivery[],
  delivery: TaskDelivery,
  limit = 20,
): TaskDelivery[] {
  return [delivery, ...list.filter((d) => d.id !== delivery.id)].slice(0, limit);
}
