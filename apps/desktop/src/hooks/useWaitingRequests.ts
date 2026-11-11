import type { Approval, PendingPermission, Task } from "@boto/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";

/** One pending permission or approval of a "wait" task on the Início lanes. */
export type WaitingRequest =
  | { kind: "permission"; task: Task; permission: PendingPermission }
  | { kind: "approval"; task: Task; approval: Approval };

const createdAt = (request: WaitingRequest) =>
  request.kind === "permission" ? request.permission.createdAt : request.approval.createdAt;

/**
 * Flattens the pending requests of each waiting task, refreshing on permission /
 * approval events and reconnects. Tasks stay newest-first; a task's own requests
 * come out most-recent first.
 */
export function useWaitingRequests(client: DaemonClient, tasks: Task[], enabled: boolean) {
  const [data, setData] = useState<WaitingRequest[]>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const taskKey = tasks.map((task) => task.id).join("\n");
  const reload = useCallback(() => {
    const current = ++generation.current;
    void Promise.all(
      tasksRef.current.map(async (task) => {
        const [permissions, approvals] = await Promise.all([
          client.request("permissions.list", { taskId: task.id }),
          client.request("approvals.list", { taskId: task.id }),
        ]);
        const requests: WaitingRequest[] = [
          ...permissions.map(
            (permission): WaitingRequest => ({ kind: "permission", task, permission }),
          ),
          ...approvals
            .filter((approval) => approval.status === "pending")
            .map((approval): WaitingRequest => ({ kind: "approval", task, approval })),
        ];
        return requests.sort((a, b) => createdAt(b) - createdAt(a));
      }),
    )
      .then((groups) => {
        if (current !== generation.current) return;
        setData(groups.flat());
        setLoaded(true);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (current === generation.current) setError(errorMessage(failure));
      });
  }, [client]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taskKey reloads when the waiting task set changes.
  useEffect(() => {
    if (!enabled) return;
    setData(undefined);
    setLoaded(false);
    setError(null);
    reload();
    const offs = [
      client.on("permission.requested", reload),
      client.on("permission.resolved", reload),
      client.on("approval.updated", reload),
      client.onReconnect(reload),
    ];
    return () => {
      generation.current++;
      for (const off of offs) off();
    };
  }, [client, enabled, reload, taskKey]);
  return { data, loaded, error, reload };
}
