import type { Approval, ChatItem, Task, Turn } from "@boto/protocol";
import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorFields, logError } from "../lib/log";

const merge = <T extends { id: string }>(old: T[], incoming: T[]) => {
  const map = new Map(old.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
};
const empty = () => ({
  task: null as Task | null,
  items: [] as ChatItem[],
  turns: [] as Turn[],
  approvals: [] as Approval[],
  agentName: "",
  loading: true,
  error: false,
  hasMore: false,
  approvalTimes: {} as Record<string, number>,
});

export function useTask(client: DaemonClient, taskId?: string) {
  const [state, setState] = useState(() => ({ ...empty(), scope: taskId }));
  const actions = useRef({ reload: () => {}, older: () => {} });
  useEffect(() => {
    let alive = true;
    let version = 0;
    let items: ChatItem[] = [];
    let turns: Turn[] = [];
    let approvals: Approval[] = [];
    let paging = false;
    let eventTask: Task | null = null;
    let eventItems: ChatItem[] = [];
    let eventTurns: Turn[] = [];
    let eventApprovals: Approval[] = [];
    const belongs = (item: ChatItem) =>
      item.taskId === taskId || turns.some((turn) => turn.id === item.turnId);
    const publish = () => {
      if (alive)
        setState((s) => ({
          ...s,
          items: [...items].sort((a, b) => a.seq - b.seq),
          turns,
          approvals: approvals.filter((a) => turns.some((t) => t.id === a.turnId)),
        }));
    };
    setState({ ...empty(), scope: taskId });
    const load = async (older = false) => {
      if (!taskId || (older && paging)) return;
      const current = older ? version : ++version;
      if (!older) {
        eventItems = [];
        eventTurns = [];
        eventApprovals = [];
        eventTask = null;
      }
      paging = older;
      try {
        await client.connect();
        const [task, history, list, agents] = await Promise.all([
          client.request("tasks.get", { id: taskId }),
          client.request("tasks.history", {
            id: taskId,
            ...(older && items.length ? { before: Math.min(...items.map((i) => i.seq)) } : {}),
          }),
          client.request("approvals.list", {}),
          client.request("agents.list", {}),
        ]);
        if (!alive || current !== version) return;
        items = older ? merge(history.items, items) : merge(history.items, eventItems);
        turns = older ? merge(history.turns, turns) : merge(history.turns, eventTurns);
        approvals = merge(list, eventApprovals);
        setState((s) => ({
          ...s,
          task: eventTask ?? task,
          agentName: agents.find((a) => a.id === task.agentId)?.name ?? "Bot",
          hasMore: history.hasMore,
          loading: false,
          error: false,
        }));
        publish();
      } catch (error) {
        logError("task.load_failed", errorFields(error));
        if (alive && current === version) setState((s) => ({ ...s, loading: false, error: true }));
      } finally {
        paging = false;
      }
    };
    actions.current = { reload: () => void load(), older: () => void load(true) };
    if (!taskId) {
      setState({ ...empty(), scope: taskId, loading: false });
      return () => {
        alive = false;
      };
    }
    const upsert = (item: ChatItem) => {
      if (belongs(item)) {
        eventItems = merge(eventItems, [item]);
        items = merge(items, [item]);
        publish();
      }
    };
    const turn = (value: Turn) => {
      if (value.taskId === taskId) {
        eventTurns = merge(eventTurns, [value]);
        turns = merge(turns, [value]);
        publish();
      }
    };
    const offs = [
      client.onReconnect(() => void load()),
      client.on("task.updated", (task) => {
        if (task.id === taskId) {
          eventTask = task;
          setState((s) => ({ ...s, task }));
        }
      }),
      client.on("item.created", upsert),
      client.on("item.updated", upsert),
      client.on("item.delta", ({ itemId, text }) => {
        items = items.map((i) =>
          i.id === itemId && "text" in i ? { ...i, text: i.text + text } : i,
        );
        const changed = items.find((i) => i.id === itemId);
        if (changed) eventItems = merge(eventItems, [changed]);
        publish();
      }),
      client.on("turn.started", turn),
      client.on("turn.ended", turn),
      client.on("permission.resolved", ({ requestId, optionId }) => {
        items = items.map((i) =>
          i.kind === "permission" && i.requestId === requestId
            ? { ...i, resolution: { optionId }, updatedAt: Date.now() }
            : i,
        );
        const changed = items.find((i) => i.kind === "permission" && i.requestId === requestId);
        if (changed) eventItems = merge(eventItems, [changed]);
        publish();
      }),
      client.on("approval.updated", (approval) => {
        if (approval.status !== "pending")
          setState((s) => ({
            ...s,
            approvalTimes: { ...s.approvalTimes, [approval.id]: Date.now() },
          }));
        eventApprovals = merge(eventApprovals, [approval]);
        approvals = merge(approvals, [approval]);
        publish();
      }),
    ];
    void load();
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, [client, taskId]);
  return {
    ...(state.scope === taskId ? state : { ...empty(), loading: !!taskId }),
    reload: () => actions.current.reload(),
    loadOlder: () => actions.current.older(),
  };
}
