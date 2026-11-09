import type { Task, TaskSituation } from "@boto/protocol";
import { useEffect } from "react";
import type { DaemonClient } from "../lib/daemon";
import { upsertTask } from "../lib/tasks";
import { useDaemonQuery } from "./useDaemonQuery";

export function useHomeTasks(client: DaemonClient, enabled: boolean) {
  const run = useDaemonQuery(
    client,
    "tasks.list",
    { situation: "run", limit: 200, includePrivate: true },
    { enabled },
  );
  const muted = useDaemonQuery(
    client,
    "tasks.list",
    { situation: "muted", limit: 200, includePrivate: true },
    { enabled },
  );
  const wait = useDaemonQuery(
    client,
    "tasks.list",
    { situation: "wait", limit: 200, includePrivate: true },
    { enabled },
  );
  const { setData: setRun } = run;
  const { setData: setMuted } = muted;
  const { setData: setWait } = wait;
  useEffect(() => {
    const update = (task: Task) => {
      const apply = (situation: TaskSituation) => (previous: typeof run.data) => ({
        items: upsertTask(previous?.items ?? [], task).filter(
          (item) => item.situation === situation,
        ),
        nextCursor: previous?.nextCursor ?? null,
      });
      setRun(apply("run"));
      setMuted(apply("muted"));
      setWait(apply("wait"));
    };
    const offs = [client.on("task.created", update), client.on("task.updated", update)];
    return () => {
      for (const off of offs) off();
    };
  }, [client, setRun, setMuted, setWait]);
  return {
    data: {
      items: [
        ...(run.data?.items ?? []),
        ...(muted.data?.items ?? []),
        ...(wait.data?.items ?? []),
      ].reduce<Task[]>((items, task) => upsertTask(items, task), []),
    },
    loaded: run.loaded && muted.loaded && wait.loaded,
    error: run.error ?? muted.error ?? wait.error,
    reload: () => {
      run.reload();
      muted.reload();
      wait.reload();
    },
  };
}
