import type { Agent, AgentPlacement, RemoteHost } from "@boto/protocol";
import { useEffect, useRef, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { AgentOverview } from "../hooks/useOverview";
import { workspaceOf } from "../lib/agent-surface";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { role, ST } from "../lib/ui";
import { Icon } from "./icons";
import { SituationStatus } from "./SituationStatus";

function isAskMode(agent: Agent) {
  return (
    (agent.provider === "claude" && agent.config.mode === "plan") ||
    (agent.provider === "codex" && agent.config.mode === "read-only")
  );
}

export function AgentPanel({
  client,
  agent,
  overview,
  placements,
  hosts,
  machinesError = null,
  onClose,
  onOpen,
}: {
  client: DaemonClient;
  agent: Agent;
  overview: AgentOverview | undefined;
  placements: AgentPlacement[] | undefined;
  hosts: RemoteHost[] | undefined;
  machinesError?: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const {
    data: queue,
    reload: reloadQueue,
    error: queueError,
  } = useDaemonQuery(
    client,
    "queue.get",
    { agentId: agent.id },
    { events: { "queue.updated": (item) => item.agentId === agent.id } },
  );
  const { data: rules } = useDaemonQuery(
    client,
    "approvals.rules",
    {},
    {
      events: { "approvals.rulesChanged": true },
    },
  );
  const workspace = workspaceOf(agent.id, placements, hosts, overview?.status);
  const placement = workspace.placement;
  const host = placement?.hostId ? hosts?.find((item) => item.id === placement.hostId) : undefined;
  const agentRules = (rules ?? []).filter(
    (rule) => rule.agentId === agent.id || rule.agentId === null,
  );
  const wildcard =
    agentRules.find((rule) => rule.pattern === "*" && rule.agentId === agent.id) ??
    agentRules.find((rule) => rule.pattern === "*" && rule.agentId === null);
  const approval = isAskMode(agent)
    ? "Só sugere, sem executar."
    : wildcard?.action === "allow"
      ? "Regra geral permite agir sem perguntar."
      : wildcard?.action === "ask"
        ? "Pede aprovação antes de cada ação."
        : "Pede aprovação em ações sensíveis.";
  const running =
    overview?.status === "run" ||
    overview?.status === "wait" ||
    overview?.paused === true ||
    (queue?.items.length ?? 0) > 0;
  const statusLabel =
    overview?.paused && overview.status !== "run" && overview.status !== "wait"
      ? "Fila pausada"
      : ST[overview?.status ?? "idle"];

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previous?.focus();
  }, []);

  const toggleQueue = async () => {
    setError(null);
    setBusy(true);
    try {
      await client.request(queue?.paused ? "queue.resume" : "queue.pause", { agentId: agent.id });
      reloadQueue();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (queueId: string) => {
    setError(null);
    setBusy(true);
    try {
      await client.request("queue.remove", { queueId });
      reloadQueue();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const delegate = async () => {
    const task = text.trim();
    if (!task) {
      setError("Descreva a tarefa antes de delegar.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await client.request("chat.send", { agentId: agent.id, text: task });
      setText("");
      setNotice(running ? "A tarefa entrou na fila." : "Tarefa delegada.");
      reloadQueue();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="agent-panel" aria-labelledby="ap-title" onClose={onClose}>
      <div className="ap">
        <header className="ap-head">
          <div className="ap-head-main">
            <h2 id="ap-title">{agent.name}</h2>
            <p>{role(agent)}</p>
            <SituationStatus
              status={overview?.status ?? "idle"}
              paused={overview?.paused ?? false}
            />
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar painel do agente"
            title="Fechar painel do agente"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="ap-body">
          <section className="ap-section" aria-labelledby="ap-slots">
            <h3 id="ap-slots">Instâncias</h3>
            <p className="ap-slots">
              <b>{workspace.slots}</b>
              <span>Uma instância por agente. Ocupa quando há microVM ou sessão ativa.</span>
            </p>
          </section>
          <section className="ap-section" aria-labelledby="ap-machines">
            <h3 id="ap-machines">Computadores</h3>
            {machinesError ? (
              <p className="err">{machinesError}</p>
            ) : placements === undefined ? (
              <p className="lane-empty">Carregando máquinas…</p>
            ) : (
              <div className="ap-machine">
                <b>{workspace.machine}</b>
                <span>
                  {placement?.isolation === "firecracker" ? (
                    <>
                      {`MicroVM${host ? ` · ${host.name}` : ""} · `}
                      <span className="ap-machine-size">{`${placement.vcpus} vCPU · ${placement.memMib} MiB`}</span>
                    </>
                  ) : (
                    "Sem microVM. A sessão roda neste computador."
                  )}
                </span>
                <span>{statusLabel}</span>
              </div>
            )}
          </section>
          <section className="ap-section" aria-labelledby="ap-now">
            <h3 id="ap-now">Trabalhando agora</h3>
            <p>{overview?.status === "run" ? overview.task || "Tarefa em execução." : "Livre."}</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(agent.id)}>
              Ver área
            </button>
          </section>
          <section className="ap-section" aria-labelledby="ap-queue">
            <div className="section-head">
              <h3 id="ap-queue">Fila</h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy || !queue}
                onClick={() => void toggleQueue()}
              >
                {queue?.paused ? "Retomar fila" : "Pausar fila"}
              </button>
            </div>
            {queueError && <p className="err">{queueError}</p>}
            {queue && queue.items.length === 0 && <p className="lane-empty">Fila vazia.</p>}
            <ul className="ap-queue">
              {queue?.items.map((item) => (
                <li key={item.id}>
                  <span>{item.text}</span>
                  <button
                    type="button"
                    aria-label="Remover da fila"
                    title="Remover da fila"
                    disabled={busy}
                    onClick={() => void remove(item.id)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="ap-section" aria-labelledby="ap-add-title">
            <h3 id="ap-add-title">Delegar a este agente</h3>
            <label className="label" htmlFor="ap-add-input">
              Tarefa
            </label>
            <textarea
              className="textarea"
              id="ap-add-input"
              rows={3}
              value={text}
              placeholder="Descreva a tarefa e o resultado esperado"
              onChange={(event) => setText(event.target.value)}
            />
            <p className="field-help">
              {overview?.paused
                ? "A fila está pausada. A tarefa entra e espera você retomar."
                : running
                  ? "O agente está ocupado ou já tem fila. Esta tarefa entra na fila."
                  : "O agente começa assim que você delegar."}
            </p>
            {error && <p className="err">{error}</p>}
            {notice && <p className="field-help">{notice}</p>}
            <button
              type="button"
              className="btn rn-btn-primary"
              disabled={busy}
              onClick={() => void delegate()}
            >
              {running ? "Entrar na fila" : "Delegar agora"}
            </button>
          </section>
          <section className="ap-section" aria-labelledby="ap-done">
            <h3 id="ap-done">Entregas recentes</h3>
            {overview?.latestTurn &&
            (overview.latestTurn.status === "completed" ||
              overview.latestTurn.status === "failed") ? (
              <p>
                {overview.task || "Tarefa sem título"} · {overview.updated}
                {overview.latestTurn.status === "failed" ? " · falhou" : ""}
              </p>
            ) : (
              <p className="lane-empty">Nenhuma entrega concluída nesta visão.</p>
            )}
          </section>
          <section className="ap-section" aria-labelledby="ap-specs">
            <h3 id="ap-specs">Especificações</h3>
            <p>
              <b>Apps. </b>
              {overview && overview.apps.length > 0
                ? overview.apps.map((app) => app.name).join(", ")
                : "Nenhum app conectado."}
            </p>
            <p>
              <b>Aprovação. </b>
              {approval}
            </p>
          </section>
        </div>
      </div>
    </dialog>
  );
}
