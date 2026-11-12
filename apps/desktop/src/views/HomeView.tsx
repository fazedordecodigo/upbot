import type { Approval, TaskDelivery } from "@boto/protocol";
import { type ReactNode, useEffect, useState } from "react";
import { MachineCard } from "../agents/MachineCard";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useHomeTasks } from "../hooks/useHomeTasks";
import { useWaitingRequests, type WaitingRequest } from "../hooks/useWaitingRequests";
import { decideApproval } from "../lib/approval-decisions";
import { approvalArguments } from "../lib/approval-description";
import { dayGreeting } from "../lib/greeting";
import { addDelivery, taskLanes } from "../lib/tasks";
import { fmtTime } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./HomeView.css";

function State({
  loaded,
  error,
  reload,
  empty,
}: {
  loaded: boolean;
  error: string | null;
  reload: () => void;
  empty?: string | undefined;
}) {
  if (error)
    return (
      <div role="alert" className="home-muted">
        Não consegui carregar os dados.{" "}
        <button type="button" className="btn btn-outline" onClick={reload}>
          Tentar de novo
        </button>
      </div>
    );
  if (!loaded) return <p className="home-muted">Carregando…</p>;
  return empty ? <p className="home-muted">{empty}</p> : null;
}
function relative(at: number, now: number) {
  const minutes = Math.round((at - now) / 60000);
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto", style: "short" });
  return Math.abs(minutes) < 60
    ? formatter.format(minutes, "minute")
    : Math.abs(minutes) < 1440
      ? formatter.format(Math.round(minutes / 60), "hour")
      : formatter.format(Math.round(minutes / 1440), "day");
}
function delivered(at: number, now: number) {
  const t = fmtTime(at, now);
  return t === "ontem"
    ? "Concluída ontem"
    : t.includes(":")
      ? `Concluída às ${t}`
      : `Concluída em ${t}`;
}
function deliveryIcon(delivery: TaskDelivery): IconName {
  if (delivery.kind === "file") return "file-text";
  if (delivery.kind === "message") return "send";
  return delivery.url && /\/pull\/|\/merge_requests\//.test(delivery.url)
    ? "git-pull-request"
    : "globe";
}
const PERMISSION_HINT: Record<string, string> = {
  execute: "Rodar comandos no terminal da máquina.",
  read: "Ler arquivos da máquina.",
  edit: "Criar e alterar arquivos no editor da máquina.",
  delete: "Apagar arquivos da máquina.",
  move: "Mover ou renomear arquivos da máquina.",
  search: "Buscar conteúdo na máquina.",
  fetch: "Navegar na web.",
  think: "Raciocinar sobre a tarefa.",
  switch_mode: "Mudar o modo da sessão.",
};

/** A short version of the approval's arguments (or its raw detail when not JSON). */
function approvalDetail(approval: Approval): string | null {
  const detail = approval.detail.trim();
  if (!detail) return null;
  try {
    JSON.parse(detail);
  } catch {
    return detail.replace(/\s+/g, " ");
  }
  return approvalArguments(detail);
}

function WaitingCard({ request, now }: { request: WaitingRequest; now: number }) {
  const { client } = useDaemon();
  const { navigate } = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const task = request.task;
  const run = async (operation: () => Promise<string | undefined>) => {
    setBusy(true);
    try {
      const message = await operation();
      if (message) toast(message);
    } catch {
      toast("Não foi possível concluir a ação. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };
  const head =
    request.kind === "permission"
      ? { icon: "key" as IconName, label: "Pede permissão" }
      : { icon: "circle-alert" as IconName, label: "Pede aprovação" };
  const title = request.kind === "permission" ? request.permission.title : request.approval.title;
  const created =
    request.kind === "permission" ? request.permission.createdAt : request.approval.createdAt;
  const detail =
    request.kind === "permission"
      ? request.permission.toolKind
        ? PERMISSION_HINT[request.permission.toolKind]
        : undefined
      : approvalDetail(request.approval);
  let action: ReactNode = null;
  if (request.kind === "permission") {
    const option = request.permission.options.find((entry) => entry.kind === "allow_once");
    if (option)
      action = (
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await client.request("permissions.respond", {
                requestId: request.permission.requestId,
                optionId: option.optionId,
              });
              return "Permitido nesta sessão.";
            })
          }
        >
          <Icon name="check" />
          Permitir nesta sessão
        </button>
      );
  } else if (request.approval.kind === "tool") {
    action = (
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={busy}
        onClick={() =>
          void run(async () => (await decideApproval(client, request.approval, "approve")).message)
        }
      >
        <Icon name="check" />
        Aprovar
      </button>
    );
  }
  return (
    <article className="wait-item">
      <p className="status" data-tone="wait">
        <Icon name={head.icon} />
        {head.label}
      </p>
      <strong className="od-truncate">{title}</strong>
      <p className="home-muted wait-detail od-clamp-2">
        {task.title}
        {detail ? `. ${detail}` : ""}
      </p>
      <div className="wait-actions">
        {action}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigate("task", { id: task.id })}
        >
          Ver detalhes
        </button>
        <time dateTime={new Date(created).toISOString()}>{relative(created, now)}</time>
      </div>
    </article>
  );
}

export function HomeView() {
  const { client, agents, connected } = useDaemon();
  const { navigate } = useRouter();
  const [now, setNow] = useState(Date.now);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [titleError, setTitleError] = useState<string | null>(null);
  const [titleRevision, retryTitles] = useState(0);
  const profile = useDaemonQuery(
    client,
    "profile.get",
    {},
    { enabled: connected, events: { "profile.changed": true } },
  );
  const tasks = useHomeTasks(client, connected);
  const deliveries = useDaemonQuery(
    client,
    "tasks.deliveries",
    { limit: 6 },
    { enabled: connected, events: { "task.deleted": true } },
  );
  const machines = useDaemonQuery(
    client,
    "desktop.machines",
    {},
    { enabled: connected, events: { "desktop.machine": true } },
  );
  const { setData: setDeliveries } = deliveries;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const offs = [
      client.on("task.delivery", (delivery) =>
        setDeliveries((previous) => addDelivery(previous ?? [], delivery, 6)),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, setDeliveries]);
  const items = tasks.data?.items ?? [];
  const missingKey = [
    ...new Set([
      ...(deliveries.data ?? []).map((delivery) => delivery.taskId),
      ...(machines.data ?? []).flatMap((machine) => (machine.taskId ? [machine.taskId] : [])),
    ]),
  ]
    .filter((id) => !items.some((task) => task.id === id) && !titles[id])
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: titleRevision explicitly retries failed title requests.
  useEffect(() => {
    let active = true;
    if (!missingKey) return;
    setTitleError(null);
    void Promise.all(
      missingKey
        .split("\n")
        .map(async (id) => [id, (await client.request("tasks.get", { id })).title] as const),
    )
      .then((entries) => {
        if (active) setTitles((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
      })
      .catch(() => {
        if (active) setTitleError("Não consegui carregar o título da tarefa.");
      });
    return () => {
      active = false;
    };
  }, [client, missingKey, titleRevision]);
  const title = (id: string) =>
    items.find((task) => task.id === id)?.title ?? titles[id] ?? "Carregando…";
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "a definir";
  const lanes = taskLanes(items);
  const waiting = useWaitingRequests(client, lanes.waiting, connected);
  const requests = waiting.data ?? [];
  const covered = new Set(requests.map((request) => request.task.id));
  const uncovered = waiting.loaded ? lanes.waiting.filter((task) => !covered.has(task.id)) : [];
  const waitingCount = requests.length + uncovered.length;
  const hour = new Date(now).getHours();
  const greeting = dayGreeting(hour);
  const status = {
    run: ["loader", "Em execução"],
    muted: ["circle-pause", "Pausada"],
    wait: ["circle-alert", "Aguardando você"],
  } satisfies Record<string, [IconName, string]>;
  const activeMachines = (machines.data ?? []).filter((machine) => machine.status !== "stopped");
  const installedApps = [...new Set(activeMachines.flatMap((machine) => machine.apps))].sort(
    (a, b) => a.localeCompare(b),
  );
  return (
    <section className="view home od-scroll" id="view-home" aria-labelledby="home-title">
      <div className="home-inner">
        <div className="home-head">
          <div className="od-field od-fill">
            <p className="hero-greeting" id="greeting">
              {greeting}
              {profile.data?.name.trim() ? `, ${profile.data.name.trim()}` : ""}.
            </p>
            <h1 className="home-title" id="home-title" tabIndex={-1}>
              O trabalho do Boto hoje
            </h1>
          </div>
          <button
            type="button"
            className="btn btn-primary home-new"
            data-action="new-task"
            onClick={() => navigate("new")}
          >
            <Icon name="plus" />
            Nova tarefa
          </button>
        </div>
        {profile.error && <State {...profile} />}
        <div className="lanes" aria-live="polite">
          <section className="lane" aria-labelledby="lane-running-title">
            <div className="section-head od-row">
              <h2 className="section-title" id="lane-running-title">
                Em andamento
              </h2>
              {tasks.loaded && lanes.running.length > 0 && (
                <span className="badge badge-secondary" id="lane-running-count">
                  {lanes.running.length}
                </span>
              )}
            </div>
            <div id="lane-running" aria-busy={!tasks.loaded && !tasks.error}>
              <State {...tasks} />
              {tasks.loaded && !tasks.error && !lanes.running.length && (
                <p className="home-empty">
                  Nenhuma tarefa em andamento. Clique em Nova tarefa e o Boto começa na hora.
                </p>
              )}
              <ul className="home-list" aria-label="Em andamento">
                {lanes.running.map((task) => {
                  const [icon, text] =
                    task.situation === "done" ? status.muted : status[task.situation];
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className="lane-item"
                        onClick={() => navigate("task", { id: task.id })}
                      >
                        <span className="status" data-tone={task.situation}>
                          <Icon name={icon} />
                          {text}
                        </span>
                        <strong className="od-truncate">{task.title}</strong>
                        <span className="home-meta">
                          <span className="od-truncate">{agentName(task.agentId)}</span>
                          <span>·</span>
                          <time dateTime={new Date(task.createdAt).toISOString()}>
                            {relative(task.createdAt, now)}
                          </time>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
          <section className="lane" aria-labelledby="lane-waiting-title">
            <div className="section-head od-row">
              <h2 className="section-title" id="lane-waiting-title">
                Aguardando você
              </h2>
              {waitingCount > 0 && (
                <span className="badge badge-secondary" id="lane-waiting-count">
                  {waitingCount}
                </span>
              )}
            </div>
            <div
              id="lane-waiting"
              aria-busy={(!tasks.loaded && !tasks.error) || (!waiting.loaded && !waiting.error)}
            >
              <State {...tasks} />
              <State {...waiting} />
              {tasks.loaded && !tasks.error && waiting.loaded && !waitingCount && (
                <p className="home-empty">Nada aguardando você.</p>
              )}
              <ul className="home-list" aria-label="Aguardando você">
                {requests.map((request) => (
                  <li
                    key={
                      request.kind === "permission"
                        ? request.permission.requestId
                        : request.approval.id
                    }
                  >
                    <WaitingCard request={request} now={now} />
                  </li>
                ))}
                {uncovered.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="lane-item"
                      onClick={() => navigate("task", { id: task.id })}
                    >
                      <span className="status" data-tone="wait">
                        <Icon name="circle-alert" />
                        Aguardando você
                      </span>
                      <strong className="od-truncate">{task.title}</strong>
                      <span className="home-meta">
                        <span className="od-truncate">{agentName(task.agentId)}</span>
                        <span>·</span>
                        <time dateTime={new Date(task.createdAt).toISOString()}>
                          {relative(task.createdAt, now)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
        <section aria-labelledby="deliveries-title">
          <div className="section-head od-row">
            <h2 className="section-title" id="deliveries-title">
              Entregas recentes
            </h2>
          </div>
          <div id="deliveries" aria-busy={!deliveries.loaded && !deliveries.error}>
            <State
              {...deliveries}
              empty={!deliveries.data?.length ? "Nenhuma entrega ainda." : undefined}
            />
            <ul className="deliveries-grid" aria-label="Entregas recentes">
              {deliveries.data?.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="delivery-item"
                    onClick={() => navigate("task", { id: delivery.taskId })}
                  >
                    <span className="home-tile">
                      <Icon name={deliveryIcon(delivery)} />
                    </span>
                    <strong className="od-clamp-2">{delivery.name}</strong>
                    <span className="od-truncate home-muted">{title(delivery.taskId)}</span>
                    <time dateTime={new Date(delivery.createdAt).toISOString()}>
                      {delivered(delivery.createdAt, now)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        {titleError && (
          <State loaded error={titleError} reload={() => retryTitles((previous) => previous + 1)} />
        )}
        <aside
          className="card pc-card"
          id="pc-card"
          aria-labelledby="pc-card-title"
          aria-busy={!machines.loaded && !machines.error}
        >
          <div className="pc-head">
            <span className="home-tile">
              <Icon name="monitor" />
            </span>
            <div className="od-field od-fill">
              <h2 className="card-title" id="pc-card-title">
                Áreas de trabalho dos agentes
              </h2>
              <p className="card-description">
                Cada instância trabalha numa máquina virtual Linux própria e isolada.
              </p>
            </div>
            {(machines.data?.length ?? 0) > 0 && (
              <span className="pc-usage">
                <span
                  className="pc-dot"
                  data-tone={activeMachines.length ? "run" : "muted"}
                  aria-hidden="true"
                />
                {activeMachines.length} de {machines.data?.length} em uso
              </span>
            )}
          </div>
          <State
            {...machines}
            empty={!activeMachines.length ? "Nenhuma área de trabalho ativa agora." : undefined}
          />
          <ul className="pc-grid" aria-label="Áreas de trabalho ativas">
            {activeMachines.map((machine) => (
              <li key={machine.id}>
                <MachineCard
                  machine={machine}
                  taskTitle={machine.taskId ? title(machine.taskId) : null}
                />
              </li>
            ))}
          </ul>
          {installedApps.length > 0 && (
            <div className="pc-apps">
              <span className="pc-apps-label">Instalado nas máquinas</span>
              <span className="pc-apps-list">
                {installedApps.map((app) => (
                  <span className="pc-app" key={app}>
                    {app}
                  </span>
                ))}
              </span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
