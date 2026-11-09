import { useEffect, useState } from "react";
import { AgentPanel } from "../agents/AgentPanel";
import { AgentHeading, MachineThumb, TaskRows } from "../agents/AgentParts";
import { CreateAgent } from "../agents/CreateAgent";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { PROVIDER_NAMES } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./AgentsView.css";

const filters = [
  ["all", "Todos"],
  ["run", "Trabalhando"],
  ["wait", "Aguardando você"],
  ["idle", "Livres"],
  ["error", "Com erro"],
] as const;

export function AgentsView() {
  const { client, agents } = useDaemon();
  const toast = useToast();
  const overview = useDaemonQuery(client, "agents.overview", {});
  const { setData } = overview;
  const summary = overview.error ? undefined : overview.data?.summary;
  useEffect(() => client.on("agents.overviewChanged", setData), [client, setData]);
  const machines = useDaemonQuery(
    client,
    "desktop.machines",
    {},
    { events: { "desktop.machine": true } },
  );
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>();
  const rows = agents.flatMap((agent) => {
    const item = overview.data?.agents.find((row) => row.agentId === agent.id);
    return item ? [{ agent, item }] : [];
  });
  const active = rows.find((row) => row.agent.id === selected);
  async function toggle(agentId: string, paused: boolean) {
    try {
      await client.request(paused ? "queue.resume" : "queue.pause", { agentId });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <section className="view agents-view od-scroll" id="view-agents" aria-labelledby="agents-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="agents-title" tabIndex={-1}>
              Bots
            </h1>
            <p className="page-sub">
              O quadro de todos os agentes do Boto. Cada agente tem uma especialidade, trabalha em
              instâncias próprias no computador na nuvem e puxa a próxima tarefa da fila quando uma
              instância fica livre.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            data-action="new-agent"
            id="new-agent"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
            Novo agente
          </button>
        </div>
        <section className="ag-stats" id="ag-stats" aria-label="Resumo dos agentes">
          {(
            [
              ["agents", "Agentes"],
              ["running", "Em execução"],
              ["waiting", "Aguardando você"],
              ["queued", "Na fila"],
            ] as const
          ).map(([key, label]) => (
            <div className="od-stat ag-stat" key={key}>
              <span className="ag-stat-value" data-unknown={summary?.[key] === undefined}>
                {summary?.[key] ?? "a definir"}
              </span>
              <span className="ag-stat-label">{label}</span>
            </div>
          ))}
        </section>
        <section aria-labelledby="ag-board-title">
          <div className="ag-toolbar">
            <h2 className="section-title" id="ag-board-title">
              Quadro
            </h2>
            <div
              className="tabs-list ag-filter"
              role="radiogroup"
              aria-label="Filtrar agentes pela situação"
              id="ag-filter"
            >
              {filters.map(([key, label], index) => (
                // biome-ignore lint/a11y/useSemanticElements: roving radio buttons match the prototype.
                <button
                  type="button"
                  key={key}
                  className="tabs-trigger"
                  role="radio"
                  aria-checked={filter === key}
                  tabIndex={filter === key ? 0 : -1}
                  onClick={() => setFilter(key)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? filters.length - 1
                          : event.key === "ArrowRight"
                            ? (index + 1) % filters.length
                            : event.key === "ArrowLeft"
                              ? (index + filters.length - 1) % filters.length
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    const target = filters[next];
                    if (!target) return;
                    setFilter(target[0]);
                    (
                      event.currentTarget.parentElement?.children[next] as HTMLElement | undefined
                    )?.focus();
                  }}
                >
                  {label}
                  {summary && overview.data && (
                    <span className="ag-filter-count">
                      {key === "all"
                        ? summary.agents
                        : overview.data.agents.filter((row) => row.situation === key).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div id="ag-grid" className="ag-grid">
            {overview.error ? (
              <div>
                <p className="ag-empty" role="alert">
                  Não foi possível carregar os agentes.
                </p>
                <button type="button" className="btn btn-outline" onClick={overview.reload}>
                  Tentar de novo
                </button>
              </div>
            ) : !overview.data ? (
              <p className="ag-empty" role="status">
                Carregando agentes…
              </p>
            ) : !overview.data.agents.length ? (
              <div className="card ag-empty-card">
                <p>Nenhum agente ainda. Crie o primeiro para delegar tarefas.</p>
                <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>
                  Novo agente
                </button>
              </div>
            ) : !rows.some((row) => filter === "all" || row.item.situation === filter) ? (
              <p className="ag-empty">Nenhum agente nesta situação.</p>
            ) : (
              rows
                .filter((row) => filter === "all" || row.item.situation === filter)
                .map(({ agent, item }) => (
                  <article className="ag-card card" key={agent.id}>
                    <header>
                      <AgentHeading agent={agent} overview={item} />
                    </header>
                    <dl className="ag-facts">
                      <div>
                        <dt>Instâncias</dt>
                        <dd>
                          {item.instances.active} de {item.instances.max ?? "a definir"}
                        </dd>
                      </div>
                      <div>
                        <dt>Fila</dt>
                        <dd>{item.queued}</dd>
                      </div>
                      <div>
                        <dt>Provedor</dt>
                        <dd>{PROVIDER_NAMES[agent.provider]}</dd>
                      </div>
                    </dl>
                    <TaskRows overview={item} />
                    {item.machines.length > 0 && (
                      <div className="ag-machines">
                        {item.machines.map((id) => {
                          const machine = machines.data?.find((m) => m.id === id);
                          return machine ? <MachineThumb key={id} machine={machine} /> : null;
                        })}
                      </div>
                    )}
                    <footer className="ag-card-foot">
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setSelected(agent.id)}
                      >
                        Abrir painel
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void toggle(agent.id, item.paused)}
                      >
                        {item.paused ? "Retomar fila" : "Pausar fila"}
                      </button>
                    </footer>
                  </article>
                ))
            )}
          </div>
        </section>
      </div>
      {creating && (
        <CreateAgent
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setSelected(agent.id);
            overview.reload();
          }}
        />
      )}
      {active && (
        <AgentPanel
          key={active.agent.id}
          agent={active.agent}
          overview={active.item}
          machines={
            machines.data?.filter((machine) => active.item.machines.includes(machine.id)) ?? []
          }
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
