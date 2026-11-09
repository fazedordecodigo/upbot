import type {
  DesktopCursorEvent,
  DesktopFrameEvent,
  DesktopInputEvent,
  Machine,
} from "@boto/protocol";
import { useMemo, useSyncExternalStore } from "react";
import type { DaemonClient } from "../lib/daemon";
import { DesktopClient, frameDataUrl } from "../lib/desktop";
import { errorFields, logError } from "../lib/log";

type State = {
  machine: Machine | null;
  frame: DesktopFrameEvent | null;
  cursor: DesktopCursorEvent | null;
  owned: boolean;
  error: string | null;
};
const initial: State = { machine: null, frame: null, cursor: null, owned: false, error: null };
const stores = new WeakMap<DaemonClient, Map<string, ReturnType<typeof createMachine>>>();

function createMachine(client: DaemonClient, id: string) {
  const desktop = new DesktopClient(client);
  let state = initial;
  const listeners = new Set<() => void>();
  let offs: (() => void)[] = [];
  let generation = 0;
  let animation = 0;
  let queue: DesktopInputEvent[] = [];
  let move: Extract<DesktopInputEvent, { type: "mouse_move" }> | null = null;
  let sending = false;
  let operations = Promise.resolve();
  const update = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
  };
  const failure = (error: unknown) => {
    logError("desktop.action_failed", errorFields(error));
    update({ error: "Não foi possível acessar a máquina. Tente de novo." });
  };
  const clearInput = () => {
    cancelAnimationFrame(animation);
    animation = 0;
    queue = [];
    move = null;
  };
  const enqueue = <T>(fn: () => Promise<T>) => {
    const result = operations.then(fn);
    operations = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const subscribe = () => {
    const version = ++generation;
    void enqueue(async () => {
      const machine = await desktop.subscribe(id);
      if (version === generation && listeners.size)
        update({ machine: state.machine ?? machine, error: null });
    }).catch(failure);
  };
  const flush = async () => {
    animation = 0;
    if (move) {
      queue.push(move);
      move = null;
    }
    if (sending || !queue.length || !state.owned) return;
    sending = true;
    const version = generation;
    try {
      while (queue.length && state.owned && version === generation)
        await desktop.input(id, queue.splice(0, 64));
    } catch (error) {
      clearInput();
      failure(error);
    } finally {
      sending = false;
    }
  };
  const release = () =>
    enqueue(async () => {
      clearInput();
      if (!state.owned) return;
      const machine = await desktop.release(id);
      update({ machine, owned: false });
    });
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        state = initial;
        offs = [
          desktop.onFrame(id, (frame) => update({ frame })),
          desktop.onCursor(id, (cursor) => update({ cursor: { ...cursor } })),
          desktop.onMachine((machine) => {
            if (machine.id === id) {
              if (machine.controller !== "user") clearInput();
              update({ machine, owned: state.owned && machine.controller === "user" });
            }
          }),
          client.onReconnect(() => {
            clearInput();
            update({ owned: false, frame: null, cursor: null, machine: null });
            subscribe();
          }),
          client.onDisconnect(() => {
            clearInput();
            update({ owned: false, frame: null });
          }),
        ];
        subscribe();
      }
      return () => {
        listeners.delete(listener);
        void release().catch(failure);
        if (!listeners.size) {
          generation++;
          clearInput();
          for (const off of offs) off();
          offs = [];
          void enqueue(() => desktop.unsubscribe(id)).catch(failure);
        }
      };
    },
    takeover: () =>
      enqueue(async () => {
        const machine = await desktop.takeover(id);
        update({ machine, owned: true, error: null });
      }),
    release,
    input(event: DesktopInputEvent) {
      if (!state.owned || state.machine?.status !== "ready") return;
      if (event.type === "mouse_move") move = event;
      else {
        if (move) {
          queue.push(move);
          move = null;
        }
        queue.push(event);
      }
      if (!animation) animation = requestAnimationFrame(() => void flush());
    },
  };
}

const absent = {
  getSnapshot: () => initial,
  subscribe: () => () => {},
  takeover: async () => {},
  release: async () => {},
  input: (_event: DesktopInputEvent) => {},
};

export function useMachine(client: DaemonClient, machineId?: string | null) {
  const store = useMemo(() => {
    if (!machineId) return absent;
    let machines = stores.get(client);
    if (!machines) {
      machines = new Map();
      stores.set(client, machines);
    }
    let machine = machines.get(machineId);
    if (!machine) {
      machine = createMachine(client, machineId);
      machines.set(machineId, machine);
    }
    return machine;
  }, [client, machineId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    ...state,
    frameUrl: state.frame ? frameDataUrl(state.frame) : null,
    takeover: store.takeover,
    release: store.release,
    input: store.input,
  };
}

export type MachineSession = ReturnType<typeof useMachine>;
