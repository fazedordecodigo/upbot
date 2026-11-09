import type { Approval, ChatItem, PendingPermission, Task, Turn } from "@boto/protocol";
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
  permissions: [] as PendingPermission[],
  permissionsReady: false,
  agentName: "",
  loading: true,
  error: false,
  hasMore: false,
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
    const eventPermissions = new Map<string, PendingPermission | null>();
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
        eventPermissions.clear();
        setState((s) => ({ ...s, permissionsReady: false }));
      }
      paging = older;
      try {
        await client.connect();
        const [task, history, list, agents, permissions] = await Promise.all([
          client.request("tasks.get", { id: taskId }),
          client.request("tasks.history", {
            id: taskId,
            ...(older && items.length ? { before: Math.min(...items.map((i) => i.seq)) } : {}),
          }),
          client.request("approvals.list", {}),
          client.request("agents.list", {}),
          client.request("permissions.list", {}),
        ]);
        if (!alive || current !== version) return;
        items = older ? merge(history.items, items) : merge(history.items, eventItems);
        turns = older ? merge(history.turns, turns) : merge(history.turns, eventTurns);
        approvals = merge(list, eventApprovals);
        const pending = new Map(
          permissions.map((permission) => [permission.requestId, permission]),
        );
        for (const [id, permission] of eventPermissions) {
          if (permission) pending.set(id, permission);
          else pending.delete(id);
        }
        setState((s) => ({
          ...s,
          task: eventTask ?? task,
          agentName: agents.find((a) => a.id === task.agentId)?.name ?? "Bot",
          hasMore: history.hasMore,
          loading: false,
          error: false,
          permissions: [...pending.values()],
          permissionsReady: true,
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
      client.onDisconnect(() => {
        version++;
        setState((s) => ({ ...s, permissionsReady: false }));
      }),
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
      client.on("permission.requested", (permission) => {
        eventPermissions.set(permission.requestId, permission);
        setState((s) => ({
          ...s,
          permissions: [
            ...s.permissions.filter((p) => p.requestId !== permission.requestId),
            permission,
          ],
        }));
      }),
      client.on("permission.resolved", ({ requestId, optionId }) => {
        eventPermissions.set(requestId, null);
        setState((s) => ({
          ...s,
          permissions: s.permissions.filter((p) => p.requestId !== requestId),
        }));
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
