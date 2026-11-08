import type { Agent, AgentStatusInfo, Channel } from "@boto/protocol";
import type { RefObject } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { AgentOverview } from "../hooks/useOverview";
import { agentSituation } from "../lib/agent-surface";
import type { DaemonClient } from "../lib/daemon";
import { mod } from "../lib/platform";
import { fmtTime, statusIcon, statusTone, type UiStatus } from "../lib/ui";
import { BotoSimboloCurrentcolorIcon } from "./ds/icons";
import { Icon } from "./icons";

export function Sidebar({
  client,
  ready,
  agents,
  channels,
  overview,
  statuses,
  selectedId,
  agentNameOverride,
  channelId,
  current,
  profileName,
  drawer,
  sideRef,
  onClose,
  onNewTask,
  onSearch,
  onHome,
  onAgents,
  onScheduled,
  onTemplates,
  onMarketplace,
  onSettings,
  onAgent,
  onChannel,
}: {
  client: DaemonClient;
  ready: boolean;
  agents: Agent[];
  channels: Channel[];
  overview: Record<string, AgentOverview>;
  statuses: Record<string, AgentStatusInfo>;
  selectedId: string | null;
  agentNameOverride?: { agentId: string; name: string } | null;
  channelId: string | null;
  current: string;
  profileName: string;
  drawer: boolean;
  sideRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onNewTask: () => void;
  onSearch: () => void;
  onHome: () => void;
  onAgents: () => void;
  onScheduled: () => void;
  onTemplates: () => void;
  onMarketplace: () => void;
  onSettings: () => void;
  onAgent: (id: string) => void;
  onChannel: (id: string) => void;
}) {
  const { data: routines } = useDaemonQuery(
    client,
    "routines.list",
    {},
    {
      enabled: ready,
      events: { "routine.updated": true, "routine.deleted": true },
    },
  );
  const name = profileName.trim() || "Você";
  const activeCount = agents.filter((agent) => {
    const situation = agentSituation(overview[agent.id]);
    return situation === "working" || situation === "waiting";
  }).length;
  const routineCount = routines?.length ?? 0;
  const groups = [
    {
      id: "working",
      label: "Em execução",
      status: "run" as UiStatus,
      items: agents.filter((agent) => agentSituation(overview[agent.id]) === "working"),
    },
    {
      id: "waiting",
      label: "Aguardando você",
      status: "wait" as UiStatus,
      items: agents.filter((agent) => agentSituation(overview[agent.id]) === "waiting"),
    },
    {
      id: "paused",
      label: "Pausadas",
      status: "idle" as UiStatus,
      items: agents.filter((agent) => agentSituation(overview[agent.id]) === "paused"),
    },
    {
      id: "failed",
      label: "Com erro",
      status: "err" as UiStatus,
      items: agents.filter(
        (agent) =>
          agentSituation(overview[agent.id]) === "idle" &&
          (overview[agent.id]?.latestTurn?.status === "failed" ||
            overview[agent.id]?.status === "err"),
      ),
    },
    {
      id: "recent",
      label: "Concluídas",
      status: "ok" as UiStatus,
      items: agents
        .filter((agent) => {
          const item = overview[agent.id];
          return (
            agentSituation(item) === "idle" &&
            item?.status !== "err" &&
            item?.latestTurn?.status === "completed" &&
            Boolean(item.task)
          );
        })
        .sort(
          (a, b) =>
            (overview[b.id]?.latestTurn?.endedAt ?? 0) - (overview[a.id]?.latestTurn?.endedAt ?? 0),
        )
        .slice(0, 8),
    },
  ];
  const named = (agent: Agent) =>
    agentNameOverride?.agentId === agent.id
      ? agentNameOverride.name.trim() || "Sem nome"
      : agent.name;

  return (
    <aside
      ref={sideRef}
      id="bot-drawer"
      className="side"
      aria-label="Barra lateral"
      {...(drawer ? { role: "dialog" as const, "aria-modal": true } : {})}
    >
      {drawer && (
        <button
          type="button"
          className="icon-btn side-close"
          aria-label="Fechar barra lateral"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      )}
      <div className="side-titlebar" data-tauri-drag-region />
      <div className="side-top">
        <button
          type="button"
          className="side-brand"
          aria-label="Boto, ir para o início"
          onClick={onHome}
        >
          <BotoSimboloCurrentcolorIcon />
          <span>Boto</span>
        </button>
      </div>
      <nav className="side-actions" aria-label="Navegação principal">
        <button type="button" className="side-btn new" onClick={onNewTask}>
          <Icon name="plus" />
          <span>Nova tarefa</span>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "home" ? "page" : undefined}
          onClick={onHome}
        >
          <Icon name="home" />
          <span>Início</span>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "agents" ? "page" : undefined}
          onClick={onAgents}
        >
          <Icon name="agents" />
          <span>Agentes</span>
          {activeCount > 0 && (
            <span className="side-count">
              <span className="sr">{activeCount} em atividade</span>
              <span aria-hidden="true">{activeCount}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "scheduled" ? "page" : undefined}
          onClick={onScheduled}
        >
          <Icon name="repeat" />
          <span>Rotinas</span>
          {routineCount > 0 && (
            <span className="side-count">
              <span className="sr">{routineCount} rotinas</span>
              <span aria-hidden="true">{routineCount}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "templates" ? "page" : undefined}
          onClick={onTemplates}
        >
          <Icon name="doc" />
          <span>Modelos</span>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "marketplace" ? "page" : undefined}
          onClick={onMarketplace}
        >
          <Icon name="store" />
          <span>Marketplace</span>
        </button>
        <button type="button" className="side-btn" onClick={onSearch}>
          <Icon name="search" />
          <span>Buscar</span>
          <kbd>{mod}K</kbd>
        </button>
      </nav>
      <div className="side-scroll side-history">
        {groups.every((group) => group.items.length === 0) && channels.length === 0 && (
          <p className="side-empty">Nenhuma tarefa ainda.</p>
        )}
        {groups.map((group) =>
          group.items.length === 0 ? null : (
            <section key={group.id} aria-label={group.label}>
              <h2 className="side-label">
                <span
                  className="rn-status"
                  data-tone={group.id === "paused" ? "muted" : statusTone(group.status)}
                >
                  <Icon name={statusIcon(group.status, group.id === "paused")} />
                  {group.label}
                </span>
              </h2>
              <ul className="side-bots">
                {group.items.map((agent) => {
                  const item = overview[agent.id];
                  const summary = item?.task || named(agent);
                  const when = fmtTime(item?.latestTurn?.endedAt ?? item?.latestTurn?.startedAt);
                  const error = statuses[agent.id]?.error || item?.latestTurn?.error;
                  return (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className="side-bot"
                        aria-current={
                          (current === "chat" || current === "agent-settings") &&
                          selectedId === agent.id
                            ? "true"
                            : undefined
                        }
                        onClick={() => onAgent(agent.id)}
                      >
                        <b>{summary}</b>
                        <small title={error || named(agent)}>
                          {error ? `${named(agent)} · ${error}` : named(agent)}
                          {when !== "—" ? ` · ${when}` : ""}
                        </small>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
        )}
        {channels.length > 0 && (
          <section aria-label="Conversas">
            <h2 className="side-label">Conversas</h2>
            <ul className="side-bots">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    className="side-bot"
                    aria-current={
                      current === "channel" && channelId === channel.id ? "true" : undefined
                    }
                    onClick={() => onChannel(channel.id)}
                  >
                    <b># {channel.name}</b>
                    <small>
                      {channel.status === "active"
                        ? "Conversa ativa"
                        : channel.status === "archived"
                          ? "Conversa arquivada"
                          : "Conversa parada"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="side-foot">
        <span className="side-avatar" aria-hidden="true">
          {name.slice(0, 1).toLocaleUpperCase("pt-BR")}
        </span>
        <div className="side-who">
          <b title={name}>{name}</b>
          <span>Pessoal</span>
        </div>
        <button
          type="button"
          className="side-settings"
          aria-label="Configurações"
          aria-current={current === "settings" ? "page" : undefined}
          onClick={onSettings}
        >
          <Icon name="gear" />
        </button>
      </footer>
    </aside>
  );
}
