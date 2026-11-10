import type { Task, TaskSituation } from "@boto/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { upsertTask } from "../lib/tasks";

export function useHomeTasks(client: DaemonClient, enabled: boolean) {
  const [data, setData] = useState<{ items: Task[] }>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const current = ++generation.current;
    const loadLane = async (situation: TaskSituation) => {
      const items: Task[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.request("tasks.list", {
          situation,
          limit: 200,
          includePrivate: true,
          ...(cursor ? { cursor } : {}),
        });
        if (current !== generation.current) return [];
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    };
    void Promise.all([loadLane("run"), loadLane("muted"), loadLane("wait")])
      .then((lanes) => {
        if (current !== generation.current) return;
        setData({
          items: lanes.flat().reduce<Task[]>((items, task) => upsertTask(items, task), []),
        });
        setLoaded(true);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (current === generation.current) setError(errorMessage(failure));
      });
  }, [client]);
  useEffect(() => {
    if (!enabled) return;
    setData(undefined);
    setLoaded(false);
    setError(null);
    reload();
    const offs = [
      client.on("task.created", reload),
      client.on("task.updated", reload),
      client.onReconnect(reload),
    ];
    return () => {
      generation.current++;
      for (const off of offs) off();
    };
  }, [client, enabled, reload]);
  return { data, loaded, error, reload };
}
