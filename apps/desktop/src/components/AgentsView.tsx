import type { Agent, AgentStatusInfo } from "@boto/protocol";
import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { AgentOverview } from "../hooks/useOverview";
import { type AgentFilter, agentSituation, matchesFilter, workspaceOf } from "../lib/agent-surface";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { moveControlFocus } from "../lib/keyboard";
import { role } from "../lib/ui";
import { AgentDesk } from "./AgentDesk";
import { AgentPanel } from "./AgentPanel";
import { Icon } from "./icons";
import { SituationStatus } from "./SituationStatus";

const FILTERS: { id: AgentFilter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "working", label: "Trabalhando" },
  { id: "waiting", label: "Aguardando você" },
  { id: "idle", label: "Livres" },
  { id: "paused", label: "Fila pausada" },
];

export function AgentsView({
  client,
  agents,
  overview,
  statuses,
  onCreate,
  onOpen,
}: {
  client: DaemonClient;
  agents: Agent[];
  overview: Record<string, AgentOverview>;
  statuses: Record<string, AgentStatusInfo>;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [panelId, setPanelId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: placements, error: placementError } = useDaemonQuery(
    client,
    "placements.list",
    {},
    { events: { "placement.updated": true } },
  );
  const { data: hosts } = useDaemonQuery(
    client,
    "hosts.list",
    {},
    {
      events: { "hosts.changed": true },
    },
  );
  const situations = agents.map((agent) => ({
    agent,
    situation: agentSituation(overview[agent.id]),
  }));
  const counts = {
    working: situations.filter((item) => item.situation === "working").length,
    waiting: situations.filter((item) => item.situation === "waiting").length,
    idle: situations.filter((item) => item.situation === "idle").length,
    paused: situations.filter((item) => item.situation === "paused").length,
  };
  const shown = situations.filter((item) => matchesFilter(filter, item.situation));
  const panelAgent = agents.find((agent) => agent.id === panelId) ?? null;

  const toggleQueue = async (agentId: string, paused: boolean) => {
    setActionError(null);
    setBusyId(agentId);
    try {
      await client.request(paused ? "queue.resume" : "queue.pause", { agentId });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="view on agents-cockpit" aria-labelledby="agents-title">
      <div className="agents-inner">
        <div className="page-head">
          <div>
            <h1 id="agents-title">Agentes</h1>
            <p>
              Cada agente tem uma especialidade, uma instância e uma fila. A miniatura é ilustrada:
              o Boto não transmite a tela da máquina.
            </p>
          </div>
          <button type="button" className="btn rn-btn-primary" onClick={onCreate}>
            <Icon name="plus" />
            Novo agente
          </button>
        </div>
        <section className="ag-stats" aria-label="Resumo dos agentes">
          <div>
            <b>{counts.working}</b>
            <span>Trabalhando</span>
          </div>
          <div>
            <b>{counts.waiting}</b>
            <span>Aguardando você</span>
          </div>
          <div>
            <b>{counts.idle}</b>
            <span>Livres</span>
          </div>
          <div>
            <b>{counts.paused}</b>
            <span>Fila pausada</span>
          </div>
        </section>
        {placementError && (
          <p className="err" role="alert">
            Não foi possível carregar as máquinas: {placementError}
          </p>
        )}
        {actionError && (
          <p className="err" role="alert">
            {actionError}
          </p>
        )}
        <section aria-labelledby="ag-board-title">
          <div className="ag-toolbar">
            <h2 id="ag-board-title">Quadro</h2>
            <fieldset className="tabs-list ag-filter" onKeyDown={moveControlFocus}>
              <legend className="sr">Filtrar agentes pela situação</legend>
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={filter === item.id}
                  tabIndex={filter === item.id ? 0 : -1}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </fieldset>
          </div>
          {shown.length === 0 ? (
            <p className="lane-empty">Nenhum agente nesta situação.</p>
          ) : (
            <div className="ag-grid">
              {shown.map(({ agent }) => {
                const info = overview[agent.id];
                const workspace = workspaceOf(agent.id, placements, hosts, info?.status);
                const apps = info?.apps.map((app) => app.name) ?? [];
                return (
                  <article className="ag-card" key={agent.id}>
                    <header>
                      <h3>{agent.name}</h3>
                      <p>{role(agent)}</p>
                      <SituationStatus
                        status={info?.status ?? "idle"}
                        paused={info?.paused ?? false}
                        detail={statuses[agent.id]?.error}
                      />
                    </header>
                    <AgentDesk
                      variant="thumb"
                      mode="boto"
                      machine={workspace.machine}
                      statusLabel={info?.paused ? "Fila pausada" : role(agent)}
                      task={info?.task ?? null}
                      apps={apps}
                    />
                    <dl className="ag-facts">
                      <div>
                        <dt>Instâncias</dt>
                        <dd>{workspace.slots}</dd>
                      </div>
                      <div>
                        <dt>Fila</dt>
                        <dd>{info?.queued ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Máquina</dt>
                        <dd>{workspace.machine}</dd>
                      </div>
                    </dl>
                    <footer>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setPanelId(agent.id)}
                      >
                        Abrir painel
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busyId === agent.id}
                        onClick={() => void toggleQueue(agent.id, info?.paused ?? false)}
                      >
                        {info?.paused ? "Retomar fila" : "Pausar fila"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onOpen(agent.id)}
                      >
                        Ver área
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {panelAgent && (
        <AgentPanel
          client={client}
          agent={panelAgent}
          overview={overview[panelAgent.id]}
          placements={placements}
          hosts={hosts}
          machinesError={placementError}
          onClose={() => setPanelId(null)}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
