import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useMachine } from "../../src/hooks/useMachine";
import { useTask } from "../../src/hooks/useTask";
import type { DaemonClient } from "../../src/lib/daemon";

const permission = (requestId: string, turnId: string) => ({
  requestId,
  turnId,
  agentId: "bot",
  title: requestId,
  options: [],
});
const turn = (id: string) => ({ id, taskId: "task", agentId: "bot" });
const approval = (id: string, turnId: string | null) => ({
  id,
  turnId,
  agentId: "bot",
  status: "pending",
});
const machine = {
  id: "machine",
  agentId: "bot",
  hostId: "host",
  name: "machine",
  status: "ready",
  width: 100,
  height: 100,
  controller: "agent",
  taskId: "task",
  thumbnailAt: null,
};
class Client {
  calls: string[] = [];
  listeners = new Map<string, Set<(data: unknown) => void>>();
  resolveHistory!: (value: unknown) => void;
  rejectHistory!: (reason: Error) => void;
  history = new Promise((resolve, reject) => {
    this.resolveHistory = resolve;
    this.rejectHistory = reject;
  });
  async connect() {}
  on(event: string, callback: (data: unknown) => void) {
    let callbacks = this.listeners.get(event);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(event, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  }
  emit(event: string, value: unknown) {
    for (const callback of this.listeners.get(event) ?? []) callback(value);
  }
  onReconnect() {
    return () => {};
  }
  onDisconnect() {
    return () => {};
  }
  async request(method: string) {
    this.calls.push(method);
    switch (method) {
      case "tasks.history":
        document.body.dataset.history = "requested";
        return this.history;
      case "tasks.get":
        return { id: "task", agentId: "bot" };
      case "agents.list":
        return [{ id: "bot", name: "Bot" }];
      case "approvals.list":
        return [];
      case "permissions.list":
        return [permission("own", "own-turn"), permission("foreign", "foreign-turn")];
      case "desktop.subscribe":
        return machine;
      case "desktop.takeover":
        return { ...machine, controller: "user" };
      case "desktop.release":
        if (new URLSearchParams(location.search).has("failRelease"))
          throw new Error("release failed");
        return machine;
      default:
        return { ok: true };
    }
  }
}
const fixture = new Client();
const client = fixture as unknown as DaemonClient;
Object.assign(window, { hookFixture: fixture });
function MachineProbe({ id }: { id: string }) {
  const state = useMachine(client, "machine");
  return (
    <section id={id}>
      <output>{String(state.owned)}</output>
      <button type="button" onClick={() => void state.takeover()}>
        Take over {id}
      </button>
    </section>
  );
}
function Harness() {
  const [first, showFirst] = useState(true);
  const [second, showSecond] = useState(false);
  const [taskId, setTaskId] = useState<string | undefined>("task");
  const state = useTask(client, taskId);
  return (
    <>
      <output id="permissions">
        {state.permissions
          .map((item) => item.requestId)
          .sort()
          .join(",")}
      </output>
      <output id="error">{String(state.error)}</output>
      <output id="approvals">
        {state.approvals
          .map((item) => item.id)
          .sort()
          .join(",")}
      </output>
      <button
        type="button"
        onClick={() => fixture.emit("approval.updated", approval("own", "own-turn"))}
      >
        Task approval
      </button>
      <button
        type="button"
        onClick={() => fixture.emit("approval.updated", approval("turnless", null))}
      >
        Turnless approval
      </button>
      <button
        type="button"
        onClick={() => fixture.emit("approval.updated", approval("foreign", "foreign-turn"))}
      >
        Foreign approval
      </button>
      <output id="loading">{String(state.loading)}</output>
      <button
        type="button"
        onClick={() => fixture.emit("permission.requested", permission("early", "early-turn"))}
      >
        Early permission
      </button>
      <button
        type="button"
        onClick={() =>
          fixture.emit("permission.requested", permission("foreign-event", "foreign-turn"))
        }
      >
        Foreign permission
      </button>
      <button
        type="button"
        onClick={() => fixture.emit("permission.requested", permission("future", "future-turn"))}
      >
        Future permission
      </button>
      <button type="button" onClick={() => fixture.emit("turn.started", turn("future-turn"))}>
        Future turn
      </button>
      <button
        type="button"
        onClick={() =>
          fixture.emit("permission.resolved", { requestId: "early", optionId: "deny" })
        }
      >
        Resolve early
      </button>
      <button
        type="button"
        onClick={() =>
          fixture.resolveHistory({
            items: [],
            turns: [turn("own-turn"), turn("early-turn")],
            hasMore: false,
          })
        }
      >
        Load history
      </button>
      <button type="button" onClick={() => fixture.rejectHistory(new Error("history failed"))}>
        Fail history
      </button>
      <button type="button" onClick={() => setTaskId(undefined)}>
        Clear task
      </button>
      <button type="button" onClick={() => showSecond(true)}>
        Add second
      </button>
      <button type="button" onClick={() => showFirst(false)}>
        Hide first
      </button>
      <button type="button" onClick={() => showSecond(false)}>
        Hide second
      </button>
      {first && <MachineProbe id="first" />}
      {second && <MachineProbe id="second" />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
