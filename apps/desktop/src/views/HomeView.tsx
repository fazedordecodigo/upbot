import type {
  Approval,
  ChatItem,
  Machine,
  PendingPermission,
  Task,
  TaskDelivery,
} from "@boto/protocol";
import { useEffect, useState } from "react";
import { MachineThumb } from "../agents/AgentParts";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useHomeTasks } from "../hooks/useHomeTasks";
import { dayGreeting } from "../lib/greeting";
import { addDelivery, taskLanes } from "../lib/tasks";
import { fmtTime } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon, type IconName } from "../ui/icons";
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
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
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
function MachineCard({ machine, taskTitle }: { machine: Machine; taskTitle: string | null }) {
  const { client, connected } = useDaemon();
  const { navigate } = useRouter();
  const taskId = machine.taskId;
  const permissions = useDaemonQuery(
    client,
    "permissions.list",
    { taskId: taskId ?? "" },
    {
      enabled: connected && !!taskId,
      events: { "permission.requested": true, "permission.resolved": true },
    },
  );
  const approvals = useDaemonQuery(
    client,
    "approvals.list",
    { taskId: taskId ?? "" },
    { enabled: connected && !!taskId, events: { "approval.updated": true } },
  );
  const history = useDaemonQuery(
    client,
    "tasks.history",
    { id: taskId ?? "", limit: 500 },
    {
      enabled: connected && !!taskId,
      events: {
        "item.created": (item) => item.kind === "plan" && item.taskId === taskId,
        "item.updated": (item) => item.kind === "plan" && item.taskId === taskId,
      },
    },
  );
  const plan = history.data?.items.findLast(
    (item): item is Extract<ChatItem, { kind: "plan" }> => item.kind === "plan",
  );
  const step = plan?.entries.findIndex((entry) => entry.status !== "completed") ?? -1;
  const approval = approvals.data?.find((entry) => entry.status === "pending");
  const permission = permissions.data?.[0];
  let tone: "run" | "wait" | "muted" | "done" = "muted";
  let icon: IconName = "circle-pause";
  let text = "Desligada";
  let tip: string | undefined;
  if (machine.status === "error") {
    icon = "circle-alert";
    text = "Com erro";
  } else if (approval) {
    tone = "wait";
    icon = "circle-alert";
    text = "Pede aprovação";
    tip = approval.title;
  } else if (permission) {
    tone = "wait";
    icon = "circle-alert";
    text = "Pede permissão";
    tip = permission.title;
  } else if (machine.controller === "user") {
    icon = "user-check";
    text = "Você está no controle";
  } else if (machine.status === "starting") {
    icon = "loader";
    text = "Ligando…";
  } else if (machine.status === "stopped") {
    tone = "done";
    text = "Desligada";
  } else if (!taskId) {
    tone = "done";
    icon = "circle-check";
    text = "Livre";
  } else {
    tone = "run";
    icon = "loader";
    text = plan && step >= 0 ? `Etapa ${step + 1} de ${plan.entries.length}` : "Em execução";
  }
  const body = (
    <>
      <MachineThumb machine={machine} caption={false} />
      <span className="pc-name">
        <span className="pc-dot" data-tone={tone} aria-hidden="true" />
        <span className="od-truncate">{machine.name}</span>
      </span>
      <span className="pc-task od-truncate">{taskTitle ?? "Sem tarefa em andamento"}</span>
      <span className="status" data-tone={tone} title={tip}>
        <Icon name={icon} />
        {text}
      </span>
    </>
  );
  return taskId ? (
    <button type="button" className="pc-machine" onClick={() => navigate("task", { id: taskId })}>
      {body}
    </button>
  ) : (
    <div className="pc-machine">{body}</div>
  );
}
function WaitingContext({
  task,
  approvals,
  permissions,
}: {
  task: Task;
  approvals: Approval[];
  permissions: PendingPermission[];
}) {
  const { client, connected } = useDaemon();
  const pendingApprovals = approvals.filter(
    (entry) => entry.status === "pending" && entry.agentId === task.agentId,
  );
  const pendingPermissions = permissions.filter((entry) => entry.agentId === task.agentId);
  const history = useDaemonQuery(
    client,
    "tasks.history",
    { id: task.id, limit: 500 },
    {
      enabled: connected && (pendingApprovals.length > 0 || pendingPermissions.length > 0),
      events: {
        "task.updated": (entry) => entry.id === task.id,
        "permission.requested": true,
        "approval.updated": true,
      },
    },
  );
  const belongs = (entry: { turnId?: string | null; agentId: string }) =>
    "turnId" in entry
      ? !!entry.turnId &&
        history.data?.turns.some((turn) => turn.id === entry.turnId && turn.taskId === task.id)
      : entry.agentId === task.agentId;
  const approval = pendingApprovals.find(belongs);
  const permission = pendingPermissions.find(belongs);
  return (
    <>
      {history.error && (
        <span role="alert" className="home-muted">
          {history.error}
        </span>
      )}
      {(approval || permission) && (
        <span className="od-truncate home-muted">
          {approval
            ? `Aprovação pendente: ${approval.title}`
            : `Permissão pendente: ${permission?.title}`}
        </span>
      )}
    </>
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
  const permissions = useDaemonQuery(
    client,
    "permissions.list",
    {},
    { enabled: connected, events: { "permission.requested": true, "permission.resolved": true } },
  );
  const approvals = useDaemonQuery(
    client,
    "approvals.list",
    {},
    { enabled: connected, events: { "approval.updated": true } },
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
          {(
            [
              ["running", "Em andamento", lanes.running, "Nada em andamento agora."],
              ["waiting", "Aguardando você", lanes.waiting, "Nada aguardando você."],
            ] as const
          ).map(([lane, label, list, empty]) => (
            <section className="lane" key={lane} aria-labelledby={`lane-${lane}-title`}>
              <div className="section-head od-row">
                <h2 className="section-title" id={`lane-${lane}-title`}>
                  {label}
                </h2>
                <span className="badge badge-secondary" id={`lane-${lane}-count`}>
                  {tasks.loaded ? list.length : ""}
                </span>
              </div>
              <div id={`lane-${lane}`} aria-busy={!tasks.loaded && !tasks.error}>
                <State {...tasks} empty={!list.length ? empty : undefined} />
                <ul className="home-list" aria-label={label}>
                  {list.map((task) => {
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
                          {task.situation === "wait" && (
                            <WaitingContext
                              task={task}
                              approvals={approvals.data ?? []}
                              permissions={permissions.data ?? []}
                            />
                          )}
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
                {lane === "waiting" && (
                  <>
                    {permissions.error && <State {...permissions} />}
                    {approvals.error && <State {...approvals} />}
                  </>
                )}
              </div>
            </section>
          ))}
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
