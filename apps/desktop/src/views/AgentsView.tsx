import type { AgentOverview } from "@boto/protocol";
import { type CSSProperties, useEffect, useState } from "react";
import { AgentPanel } from "../agents/AgentPanel";
import { AgentHeading, TaskRows } from "../agents/AgentParts";
import { CreateAgent } from "../agents/CreateAgent";
import { agentStatus } from "../agents/helpers";
import { MachineCard } from "../agents/MachineCard";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./AgentsView.css";

const filters = [
  ["all", "Todos"],
  ["run", "Trabalhando"],
  ["wait", "Aguardando você"],
  ["idle", "Livres"],
  ["paused", "Pausados"],
] as const;
type FilterKey = (typeof filters)[number][0];

function inFilter(item: AgentOverview, filter: FilterKey) {
  if (filter === "paused") return item.paused;
  if (filter === "idle") return item.situation === "idle" && !item.paused;
  return filter === "all" || item.situation === filter;
}

export function AgentsView() {
  const { client, agents } = useDaemon();
  const { params, navigate } = useRouter();
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
  const [filter, setFilter] = useState<FilterKey>("all");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (params.create === "1") setCreating(true);
  }, [params]);
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
  const agentRows = overview.data?.agents;
  const busyAgents = agentRows?.filter(
    (row) => row.situation === "run" || row.situation === "wait",
  ).length;
  const used = agentRows?.reduce((n, row) => n + row.instances.active, 0);
  const slots = agentRows?.reduce((n, row) => n + (row.instances.max ?? row.instances.capacity), 0);
  const stats: { value: number | undefined; of: number | undefined; label: string }[] = [
    { value: busyAgents, of: summary?.agents, label: "agentes em atividade" },
    { value: used, of: slots, label: "instâncias em uso" },
    { value: summary?.queued, of: undefined, label: "tarefas na fila" },
    { value: summary?.waiting, of: undefined, label: "pedidos esperando você" },
  ];
  return (
    <section className="view agents-view od-scroll" id="view-agents" aria-labelledby="agents-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="agents-title" tabIndex={-1}>
              Bots
            </h1>
            <p className="page-sub">
              O quadro de todos os bots do Boto. Cada bot tem uma especialidade, trabalha em
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
            Novo bot
          </button>
        </div>
        <section className="ag-stats" id="ag-stats" aria-label="Resumo dos bots">
          {stats.map(({ value, of, label }) => (
            <div className="od-stat ag-stat" key={label}>
              <span className="ag-stat-value" data-unknown={value === undefined}>
                {value === undefined ? (
                  "a definir"
                ) : (
                  <>
                    {value}
                    {of !== undefined && <span className="ag-stat-of"> de {of}</span>}
                  </>
                )}
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
              aria-label="Filtrar bots pela situação"
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
                        : overview.data.agents.filter((row) => inFilter(row, key)).length}
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
                  Não foi possível carregar os bots.
                </p>
                <button type="button" className="btn btn-outline" onClick={overview.reload}>
                  Tentar de novo
                </button>
              </div>
            ) : !overview.data ? (
              <p className="ag-empty" role="status">
                Carregando bots…
              </p>
            ) : !overview.data.agents.length ? (
              <div className="card ag-empty-card">
                <p>Nenhum bot ainda. Crie o primeiro para delegar tarefas.</p>
                <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>
                  Novo bot
                </button>
              </div>
            ) : !rows.some((row) => inFilter(row.item, filter)) ? (
              <p className="ag-empty">Nenhum bot nesta situação.</p>
            ) : (
              rows
                .filter((row) => inFilter(row.item, filter))
                .map(({ agent, item }) => {
                  const status = agentStatus(item);
                  const capacity = item.instances.max ?? item.instances.capacity;
                  const instanceText = `${item.instances.active} de ${item.instances.max ?? "a definir"} ${item.instances.max === 1 ? "instância" : "instâncias"}`;
                  const live = (machines.data ?? []).filter(
                    (machine) => item.machines.includes(machine.id) && machine.status !== "stopped",
                  );
                  const liveTasks = new Set(
                    live.flatMap((machine) => (machine.taskId ? [machine.taskId] : [])),
                  );
                  const uncovered = (ref: { taskId: string | null }) =>
                    !ref.taskId || !liveTasks.has(ref.taskId);
                  const running = item.running.filter(uncovered);
                  const waiting = item.waiting.filter(uncovered);
                  const taskTitle = (taskId: string | null) =>
                    [...item.waiting, ...item.running].find((ref) => ref.taskId === taskId)
                      ?.title ?? null;
                  return (
                    <article className="ag-card card" key={agent.id}>
                      <header>
                        <AgentHeading
                          agent={agent}
                          overview={item}
                          aside={<span className="ag-inst">{instanceText}</span>}
                        />
                      </header>
                      <div
                        className="progress"
                        data-tone={status.tone}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={capacity}
                        aria-valuenow={item.instances.active}
                        aria-valuetext={instanceText}
                      >
                        <span
                          style={
                            {
                              "--p": Math.min(1, item.instances.active / capacity),
                            } as CSSProperties
                          }
                        />
                      </div>
                      <div className="ag-live">
                        <h3 className="ag-sec-label">Áreas de trabalho ao vivo</h3>
                        {live.length > 0 && (
                          <div className="ag-machines">
                            {live.map((machine) => (
                              <MachineCard
                                key={machine.id}
                                machine={machine}
                                taskTitle={taskTitle(machine.taskId)}
                              />
                            ))}
                          </div>
                        )}
                        {running.length + waiting.length > 0 && (
                          <TaskRows overview={{ ...item, running, waiting }} />
                        )}
                        {live.length + running.length + waiting.length === 0 && (
                          <p className="ag-live-empty">
                            {item.paused
                              ? "Nenhuma máquina em uso. A fila está pausada."
                              : "Nenhuma máquina em uso. Pronto para a próxima tarefa."}
                          </p>
                        )}
                      </div>
                      <div className="ag-queue">
                        <div className="od-row">
                          <h3 className="ag-sec-label od-fill">Fila</h3>
                          <span className="ag-queue-count">
                            {item.queued === 0
                              ? "Vazia"
                              : `${item.queued} ${item.queued === 1 ? "tarefa" : "tarefas"}`}
                          </span>
                        </div>
                        {item.next && (
                          <p className="ag-next od-truncate">
                            <span className="ag-next-label">Próxima: </span>
                            {item.next.taskId ? (
                              <button
                                type="button"
                                className="ag-task-link"
                                onClick={() => navigate("task", { id: item.next?.taskId ?? "" })}
                              >
                                {item.next.title}
                              </button>
                            ) : (
                              item.next.title
                            )}
                          </p>
                        )}
                      </div>
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
                          <Icon name={item.paused ? "play" : "pause"} />
                          {item.paused ? "Retomar fila" : "Pausar fila"}
                        </button>
                      </footer>
                    </article>
                  );
                })
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
