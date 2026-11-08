import type { Agent, AgentStatusInfo } from "@boto/protocol";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { AgentOverview } from "../hooks/useOverview";
import { agentSituation, greeting, workspaceOf } from "../lib/agent-surface";
import type { DaemonClient } from "../lib/daemon";
import { role } from "../lib/ui";
import { AgentDesk } from "./AgentDesk";
import { Icon } from "./icons";
import { SituationStatus } from "./SituationStatus";

function Lane({
  title,
  agents,
  overview,
  statuses,
  empty,
  onOpen,
}: {
  title: string;
  agents: Agent[];
  overview: Record<string, AgentOverview>;
  statuses: Record<string, AgentStatusInfo>;
  empty: string;
  onOpen: (id: string) => void;
}) {
  const headingId = `lane-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section className="lane" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>{title}</h2>
        <span className="rn-badge">{agents.length}</span>
      </div>
      {agents.length === 0 ? (
        <p className="lane-empty">{empty}</p>
      ) : (
        <div className="lane-list">
          {agents.map((agent) => {
            const item = overview[agent.id];
            return (
              <button
                key={agent.id}
                type="button"
                className="lane-item"
                onClick={() => onOpen(agent.id)}
              >
                <span className="lane-copy">
                  <b className="od-truncate">{item?.task || agent.name}</b>
                  <small className="od-truncate">
                    {agent.name}
                    {item?.updated && item.updated !== "—" ? ` · ${item.updated}` : ""}
                  </small>
                </span>
                <SituationStatus
                  status={item?.status ?? "idle"}
                  paused={item?.paused ?? false}
                  detail={statuses[agent.id]?.error}
                />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function HomeView({
  client,
  profileName,
  agents,
  overview,
  statuses,
  onNewTask,
  onOpen,
}: {
  client: DaemonClient;
  profileName: string;
  agents: Agent[];
  overview: Record<string, AgentOverview>;
  statuses: Record<string, AgentStatusInfo>;
  onNewTask: () => void;
  onOpen: (id: string) => void;
}) {
  const { data: placements, error: placementError } = useDaemonQuery(
    client,
    "placements.list",
    {},
    {
      events: { "placement.updated": true },
    },
  );
  const { data: hosts } = useDaemonQuery(
    client,
    "hosts.list",
    {},
    {
      events: { "hosts.changed": true },
    },
  );
  const name = profileName.trim();
  const hello = name ? `${greeting().replace(/\.$/, "")}, ${name}.` : greeting();
  const working = agents.filter((agent) => agentSituation(overview[agent.id]) === "working");
  const waiting = agents.filter((agent) => agentSituation(overview[agent.id]) === "waiting");
  const recent = agents
    .filter((agent) => {
      const item = overview[agent.id];
      return (
        agentSituation(item) === "idle" &&
        item?.latestTurn?.status === "completed" &&
        Boolean(item.task)
      );
    })
    .sort(
      (a, b) =>
        (overview[b.id]?.latestTurn?.endedAt ?? 0) - (overview[a.id]?.latestTurn?.endedAt ?? 0),
    )
    .slice(0, 6);

  return (
    <section className="view on home-view">
      <div className="home-inner">
        <div className="home-head">
          <div>
            <p className="hero-greeting">{hello}</p>
            <h1 className="home-title">O trabalho do Boto hoje</h1>
          </div>
          <button type="button" className="btn rn-btn-primary" onClick={onNewTask}>
            <Icon name="plus" />
            Nova tarefa
          </button>
        </div>
        <div className="lanes">
          <Lane
            title="Em andamento"
            agents={working}
            overview={overview}
            statuses={statuses}
            empty="Nada em andamento."
            onOpen={onOpen}
          />
          <Lane
            title="Aguardando você"
            agents={waiting}
            overview={overview}
            statuses={statuses}
            empty="Nada esperando a sua decisão."
            onOpen={onOpen}
          />
        </div>
        <section aria-labelledby="deliveries-title">
          <div className="section-head">
            <h2 id="deliveries-title">Entregas recentes</h2>
          </div>
          {recent.length === 0 ? (
            <p className="lane-empty">Nenhuma entrega recente.</p>
          ) : (
            <div className="lane-list">
              {recent.map((agent) => {
                const item = overview[agent.id];
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className="lane-item"
                    onClick={() => onOpen(agent.id)}
                  >
                    <span className="lane-copy">
                      <b className="od-truncate">{item?.task || agent.name}</b>
                      <small className="od-truncate">
                        {agent.name}
                        {item?.updated && item.updated !== "—" ? ` · ${item.updated}` : ""}
                      </small>
                    </span>
                    <SituationStatus status={item?.status ?? "ok"} />
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <aside className="card pc-card" aria-labelledby="pc-card-title">
          <div className="section-head">
            <h2 id="pc-card-title">Áreas de trabalho dos agentes</h2>
          </div>
          <p className="pc-card-help">
            Miniaturas ilustradas no Rio Negro, com o estado real de cada agente. Não é a tela da
            máquina.
          </p>
          {placementError && <p className="err">Não foi possível carregar as máquinas.</p>}
          {agents.length === 0 ? (
            <p className="lane-empty">Nenhum agente ainda.</p>
          ) : (
            <div className="pc-thumbs">
              {agents.map((agent) => {
                const item = overview[agent.id];
                const workspace = workspaceOf(agent.id, placements, hosts, item?.status);
                const apps = item?.apps.map((app) => app.name) ?? [];
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className="pc-thumb"
                    onClick={() => onOpen(agent.id)}
                  >
                    <AgentDesk
                      variant="thumb"
                      mode="boto"
                      machine={workspace.machine}
                      statusLabel={item?.paused ? "Fila pausada" : (item?.task ?? role(agent))}
                      task={item?.task ?? null}
                      apps={apps}
                    />
                    <span className="pc-thumb-meta">
                      <b className="od-truncate">{agent.name}</b>
                      <SituationStatus
                        status={item?.status ?? "idle"}
                        paused={item?.paused ?? false}
                        detail={statuses[agent.id]?.error}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
