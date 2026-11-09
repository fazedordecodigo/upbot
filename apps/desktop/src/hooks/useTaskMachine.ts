import type { Machine } from "@boto/protocol";
import { useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { DesktopClient } from "../lib/desktop";
import { errorFields, logError } from "../lib/log";

export function useTaskMachine(client: DaemonClient, agentId?: string, taskId?: string) {
  const [state, setState] = useState<{ agentId: string | undefined; machines: Machine[] }>({
    agentId: undefined,
    machines: [],
  });
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const desktop = new DesktopClient(client);
    let events = new Map<string, Machine>();
    const load = async () => {
      const version = ++generation;
      events = new Map();
      try {
        const list = await desktop.machines();
        if (!alive || version !== generation) return;
        const machines = new Map(list.map((m) => [m.id, m]));
        for (const [id, machine] of events) machines.set(id, machine);
        setState({ agentId, machines: [...machines.values()] });
      } catch (error) {
        logError("task.machines_failed", errorFields(error));
      }
    };
    setState({ agentId, machines: [] });
    if (!agentId) return;
    const offs = [
      client.onReconnect(() => void load()),
      client.on("placement.updated", () => void load()),
      desktop.onMachine((machine) => {
        events.set(machine.id, machine);
        setState((s) => ({
          agentId,
          machines: [...s.machines.filter((m) => m.id !== machine.id), machine],
        }));
      }),
    ];
    void load();
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, [client, agentId]);
  const machines =
    state.agentId === agentId ? state.machines.filter((m) => m.agentId === agentId) : [];
  return machines.find((m) => m.taskId === taskId) ?? machines[0] ?? null;
}
