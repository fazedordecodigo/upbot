import type { ChatItem } from "@boto/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { VmDialog } from "../dialogs/VmDialog";
import { useMachine } from "../hooks/useMachine";
import { useTask } from "../hooks/useTask";
import { useTaskMachine } from "../hooks/useTaskMachine";
import {
  describeApproval,
  fullApprovalArguments,
  requiresFullReview,
} from "../lib/approval-description";
import { errorFields, logError } from "../lib/log";
import { attachment, attachmentError } from "../lib/new-task";
import { readStorage, writeStorage } from "../lib/storage";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { LiveDesk } from "../task/LiveDesk";
import { SecretApproval } from "../task/SecretApproval";
import { Icon, type IconName } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
import { useToast } from "../ui/Toast";
import "./TaskView.css";

const time = (n: number) =>
  new Date(n).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const labels = {
  allow_once: "Permitir nesta sessão",
  allow_always: "Permitir em todas as sessões",
  reject_once: "Não permitir",
  reject_always: "Não permitir",
};
const decisions = {
  allow_once: "Permitido nesta sessão",
  allow_always: "Permitido em todas as sessões",
  reject_once: "Não permitido",
  reject_always: "Não permitido",
};
const clampSplit = (value: number) => Math.round(Math.max(30, Math.min(70, value)));

const TOOL_META: Record<string, { label: string; icon: IconName }> = {
  execute: { label: "Terminal", icon: "terminal" },
  read: { label: "Leitura", icon: "file-text" },
  edit: { label: "Editor", icon: "file-code" },
  delete: { label: "Exclusão", icon: "trash" },
  move: { label: "Arquivos", icon: "folder" },
  search: { label: "Busca", icon: "search" },
  fetch: { label: "Navegador", icon: "globe" },
  think: { label: "Raciocínio", icon: "cpu" },
  switch_mode: { label: "Modo", icon: "settings" },
};
const toolMeta = (kind: string | null) =>
  (kind ? TOOL_META[kind] : undefined) ?? {
    label: "Ferramenta",
    icon: "app-window" as IconName,
  };

function ToolDetail({ text }: { text: string | null }) {
  if (!text?.trim()) return null;
  const trimmed = text.trim();
  const first = trimmed.split("\n", 1)[0]?.trim() ?? "";
  if (trimmed === first && trimmed.length <= 160) {
    return <p className="task-note">{trimmed}</p>;
  }
  return (
    <details className="task-detail">
      <summary>{first || "Detalhes"}</summary>
      <pre className="task-args">{trimmed}</pre>
    </details>
  );
}

function Memory({ item }: { item: Extract<ChatItem, { kind: "agent_message" }> }) {
  const { client } = useDaemon();
  const { navigate } = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<string[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!item.memoryUsage?.count) return null;
  const names = item.memoryUsage.kinds.map(
    (kind) => ({ profile: "Perfil", agent: "Bot", skill: "Skill" })[kind],
  );
  const kinds = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
  return (
    <div className="task-memory">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        onClick={async () => {
          setOpen(!open);
          if (texts || !item.turnId) return;
          try {
            const usage = await client.request("memories.usage", { turnId: item.turnId });
            if (alive.current) setTexts(usage.items.map((i) => i.text));
          } catch (error) {
            logError("task.memory_failed", errorFields(error));
            if (alive.current) toast("Não foi possível carregar a memória.");
          }
        }}
      >
        {`Usou ${item.memoryUsage.count} ${item.memoryUsage.count === 1 ? "item" : "itens"} da memória · ${kinds}`}
      </button>
      {open && (
        <div>
          {texts ? (
            <ul>
              {texts.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p>Carregando memória…</p>
          )}
          <button
            type="button"
            className="btn btn-link"
            onClick={() => navigate("settings", { tab: "memory" })}
          >
            Editar memória
          </button>
        </div>
      )}
    </div>
  );
}

export function TaskView() {
  const { params } = useRouter();
  return <TaskSurface key={params.id ?? "empty"} />;
}

function TaskSurface() {
  const { client } = useDaemon();
  const { params, navigate } = useRouter();
  const data = useTask(client, params.id);
  const { task } = data;
  const toast = useToast();
  const [live, setLive] = useState(true);
  const [pane, setPane] = useState("activity");
  const [split, setSplit] = useState(() => {
    const value = Number(readStorage("boto.task-split"));
    return Number.isFinite(value) && value >= 30 && value <= 70 ? value : 42;
  });
  const [vmOpen, setVmOpen] = useState(false);
  const machine = useTaskMachine(client, task?.agentId, task?.id);
  const session = useMachine(client, machine?.id);
  const takeoverLabel = session.owned ? "Devolver ao Boto" : "Assumir o controle";
  const takeoverReason = !machine
    ? "Este bot não tem uma área de trabalho"
    : session.machine?.status !== "ready"
      ? "A máquina ainda não está pronta"
      : task?.outcome === "stopped"
        ? "Esta tarefa foi encerrada"
        : undefined;
  useEffect(() => {
    writeStorage("boto.task-split", String(split));
  }, [split]);
  useEffect(() => {
    if (data.deleted) navigate("home");
  }, [data.deleted, navigate]);
  useEffect(() => {
    if (session.error) toast(session.error);
  }, [session.error, toast]);
  const confirm = useConfirm();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileIds = useRef(new WeakMap<File, string>());
  const body = useRef<HTMLDivElement>(null);
  const current = useRef(params.id);
  current.current = params.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset task-local controls when routing to another task.
  useEffect(() => {
    setText("");
    setFiles([]);
    setBusy(false);
    bottom.current = true;
  }, [params.id]);
  useEffect(() => {
    if (data.items.length && bottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [data.items]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grow the composer to fit the text on every change.
  useEffect(() => {
    const el = input.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [text]);
  const act = async (operation: () => Promise<unknown>, success?: () => void, rethrow = false) => {
    const id = params.id;
    setBusy(true);
    try {
      await operation();
      if (current.current === id) success?.();
    } catch (error) {
      logError("task.action_failed", errorFields(error));
      if (current.current === id) toast("Não foi possível concluir a ação. Tente de novo.");
      if (rethrow) throw error;
    } finally {
      if (current.current === id) setBusy(false);
    }
  };
  const send = () => {
    if (!task || !text.trim() || busy || task.outcome === "stopped") return;
    const pending = files;
    void act(
      async () =>
        client.request("tasks.instruct", {
          id: task.id,
          text: text.trim(),
          ...(pending.length ? { attachments: await Promise.all(pending.map(attachment)) } : {}),
        }),
      () => {
        setText("");
        setFiles([]);
        bottom.current = true;
      },
    );
  };
  const tone = task?.situation ?? "muted";
  const icon: IconName =
    task?.outcome === "failed"
      ? "circle-alert"
      : tone === "run"
        ? "loader"
        : tone === "wait"
          ? "circle-alert"
          : tone === "muted"
            ? "circle-pause"
            : "circle-check";
  const status =
    task?.outcome === "stopped"
      ? "Encerrada"
      : task?.outcome === "failed"
        ? "Falhou"
        : { run: "Em execução", wait: "Aguardando você", muted: "Pausada", done: "Concluída" }[
            tone
          ];
  const rows = [
    ...data.items.map((item) => ({ id: item.id, createdAt: item.createdAt, item })),
    ...data.approvals.map((approval) => ({
      id: approval.id,
      createdAt: approval.createdAt,
      approval,
    })),
  ].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <section className="view task" id="view-task" aria-labelledby="task-title">
      <header className="task-head">
        <button
          type="button"
          className="btn btn-ghost btn-sm task-back"
          onClick={() => navigate("home")}
        >
          <Icon name="arrow-left" />
          <span className="ctl-label">Início</span>
        </button>
        <div className="od-field od-fill task-heading">
          <h1 className="task-title od-truncate" id="task-title" tabIndex={-1}>
            {task?.title ?? "Tarefa"}
          </h1>
          <div className="task-meta od-cluster" id="task-meta">
            {task && (
              <>
                <span>{data.agentName}</span>
                <span className="status" data-tone={tone}>
                  <Icon name={icon} />
                  {status}
                </span>
                <time dateTime={new Date(task.createdAt).toISOString()}>
                  Iniciada às {time(task.createdAt)}
                </time>
              </>
            )}
          </div>
        </div>
        <div className="task-controls od-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm ctl-live"
            id="ctl-live"
            aria-pressed={live}
            aria-controls="pc-pane"
            aria-label="Área de trabalho ao vivo"
            data-tip="Área de trabalho ao vivo"
            onClick={() => {
              setLive(!live);
              if (live) setPane("activity");
            }}
          >
            <Icon name="monitor" />
            <span className="ctl-label">Área de trabalho ao vivo</span>
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            id="ctl-pause"
            aria-label={tone === "muted" ? "Retomar" : "Pausar"}
            data-tip={tone === "muted" ? "Retomar" : "Pausar"}
            disabled={!task || tone === "done" || busy}
            onClick={() =>
              task &&
              void act(() =>
                client.request(tone === "muted" ? "tasks.resume" : "tasks.pause", { id: task.id }),
              )
            }
          >
            <Icon name={tone === "muted" ? "play" : "pause"} />
            <span className="ctl-label">{tone === "muted" ? "Retomar" : "Pausar"}</span>
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            id="ctl-takeover"
            disabled={!!takeoverReason || busy}
            title={takeoverReason ?? takeoverLabel}
            aria-label={takeoverLabel}
            data-tip={takeoverReason ?? takeoverLabel}
            onClick={() => void act(session.owned ? session.release : session.takeover)}
          >
            <Icon name="mouse-pointer" />
            <span className="ctl-label">{takeoverLabel}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm ctl-stop"
            id="ctl-stop"
            aria-label="Encerrar"
            data-tip="Encerrar"
            disabled={!task || tone === "done" || busy}
            onClick={() =>
              task &&
              void confirm({
                title: "Encerrar esta tarefa?",
                description:
                  "O Boto para na etapa atual e não continua depois. O que já foi feito fica em Arquivos.",
                action: "Encerrar tarefa",
                cancel: "Continuar a tarefa",
                onConfirm: () =>
                  act(() => client.request("tasks.stop", { id: task.id }), undefined, true),
              })
            }
          >
            <Icon name="power" />
            <span className="ctl-label">Encerrar</span>
          </button>
        </div>
      </header>
      <div className="task-tabs">
        <div className="tabs-list" role="tablist" aria-label="Painéis da tarefa" id="pane-tabs">
          {["activity", "computer"].map((value) => (
            <button
              type="button"
              className="tabs-trigger"
              role="tab"
              key={value}
              id={`pane-tab-${value}`}
              data-pane={value}
              aria-controls={value === "activity" ? "tl-pane" : "pc-pane"}
              aria-selected={pane === value}
              tabIndex={pane === value ? 0 : -1}
              onClick={() => {
                setPane(value);
                if (value === "computer") setLive(true);
              }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "activity"
                    : event.key === "End"
                      ? "computer"
                      : value === "activity"
                        ? "computer"
                        : "activity";
                setPane(next);
                setLive(true);
                document.getElementById(`pane-tab-${next}`)?.focus();
              }}
            >
              <Icon name={value === "activity" ? "list-checks" : "monitor"} />
              {value === "activity" ? "Atividade" : "Área de trabalho"}
            </button>
          ))}
        </div>
      </div>
      <div
        className="task-body"
        id="task-body"
        data-pane={pane}
        data-live={live}
        ref={body}
        style={{ "--task-split": `${split}%` } as CSSProperties}
      >
        <section className="tl" id="tl-pane" aria-label="Atividade">
          <div
            className="tl-scroll od-scroll"
            id="tl-scroll"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current;
              if (el) bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            <div
              className="tl-inner"
              id="timeline"
              role="log"
              aria-live="polite"
              aria-label="Atividade do Boto"
            >
              {!params.id ? (
                <div className="task-empty">
                  <h2>Nenhuma tarefa aberta</h2>
                  <button type="button" className="btn btn-primary" onClick={() => navigate("new")}>
                    Nova tarefa
                  </button>
                </div>
              ) : data.loading ? (
                <p>Carregando tarefa…</p>
              ) : data.error ? (
                <div className="task-empty">
                  <p>Não foi possível carregar a tarefa.</p>
                  <button type="button" className="btn btn-outline" onClick={data.reload}>
                    Tentar de novo
                  </button>
                </div>
              ) : (
                <>
                  {data.hasMore && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        bottom.current = false;
                        data.loadOlder();
                      }}
                    >
                      Carregar anteriores
                    </button>
                  )}
                  {!rows.length && (
                    <p className="task-note">A atividade desta tarefa aparece aqui.</p>
                  )}
                  {rows.map((row) => {
                    if ("approval" in row) {
                      const a = row.approval;
                      const decidedAt = a.resolvedAt ?? a.interruptedAt;
                      const described =
                        a.kind === "tool" ? describeApproval(a, data.agentName) : null;
                      // the daemon titles takeover requests in English for the agent; the
                      // card speaks to the user and hands the machine over right here
                      const handover = a.kind === "takeover";
                      return (
                        <article
                          className="task-card"
                          data-pending={a.status === "pending"}
                          key={a.id}
                        >
                          <p className="task-label">
                            <Icon name={handover ? "mouse-pointer" : "shield-check"} />
                            {handover ? "Controle do computador" : "Aprovação"} ·{" "}
                            <time dateTime={new Date(a.createdAt).toISOString()}>
                              {time(a.createdAt)}
                            </time>
                          </p>
                          <h3>
                            {handover
                              ? `${data.agentName} precisa que você assuma o controle.`
                              : (described?.description ?? a.title)}
                          </h3>
                          {described ? (
                            <>
                              {described.context && <p>{described.context}</p>}
                              {a.status === "pending" && requiresFullReview(a) ? (
                                <pre className="task-args">{fullApprovalArguments(a.detail)}</pre>
                              ) : (
                                described.arguments && (
                                  <p className="task-note">{described.arguments}</p>
                                )
                              )}
                            </>
                          ) : (
                            a.detail && <p>{a.detail}</p>
                          )}
                          {a.status === "pending" ? (
                            <div className="task-actions">
                              {a.kind === "secret" ? (
                                <SecretApproval
                                  client={client}
                                  id={a.id}
                                  disabled={busy}
                                  onBusyChange={setBusy}
                                />
                              ) : handover && machine && !takeoverReason ? (
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(session.owned ? session.release : session.takeover)
                                  }
                                >
                                  {takeoverLabel}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-primary"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(() =>
                                      client.request("approvals.respond", {
                                        id: a.id,
                                        decision: "approve",
                                      }),
                                    )
                                  }
                                >
                                  {handover ? "Marcar como concluída" : "Aprovar"}
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-outline"
                                disabled={busy}
                                onClick={() =>
                                  void act(() =>
                                    client.request("approvals.respond", {
                                      id: a.id,
                                      decision: "deny",
                                    }),
                                  )
                                }
                              >
                                Recusar
                              </button>
                            </div>
                          ) : (
                            <p className="task-note">
                              <Icon
                                name={
                                  a.status === "approved" || a.status === "done"
                                    ? "circle-check"
                                    : "circle-slash"
                                }
                              />{" "}
                              {
                                {
                                  approved: "Aprovada",
                                  denied: "Recusada",
                                  expired: "Expirada",
                                  done: "Concluída",
                                  interrupted: "Interrompida",
                                }[a.status]
                              }{" "}
                              · {decidedAt ? time(decidedAt) : "Horário da decisão indisponível"}
                            </p>
                          )}
                        </article>
                      );
                    }
                    const i = row.item;
                    switch (i.kind) {
                      case "user_message": {
                        const actor =
                          i.from?.name ??
                          i.gateway?.userName ??
                          i.team?.memberName ??
                          i.routine?.name;
                        return (
                          <article className="task-user" key={i.id}>
                            <p className="task-label">
                              {actor ? `${actor} pediu` : "Você pediu"} ·{" "}
                              <time dateTime={new Date(i.createdAt).toISOString()}>
                                {time(i.createdAt)}
                              </time>
                            </p>
                            <p className="task-user-text">{i.text}</p>
                            {i.attachments && i.attachments.length > 0 && (
                              <div className="task-user-files">
                                {i.attachments.map((file) => (
                                  <span className="task-chip" key={file.path}>
                                    <Icon name="file-text" />
                                    <span className="od-truncate">{file.name}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </article>
                        );
                      }
                      case "agent_message":
                        return (
                          <article className="task-message md" key={i.id}>
                            <Markdown text={i.text} />
                            <Memory item={i} />
                          </article>
                        );
                      case "agent_thought":
                        return (
                          <details className="task-note" key={i.id}>
                            <summary>Raciocínio do Boto</summary>
                            <p>{i.text}</p>
                          </details>
                        );
                      case "tool_call": {
                        const meta = toolMeta(i.toolKind);
                        const running = i.status === "pending" || i.status === "in_progress";
                        return (
                          <div className="task-step" data-status={i.status} key={i.id}>
                            <time
                              className="task-time"
                              dateTime={new Date(i.createdAt).toISOString()}
                            >
                              {time(i.createdAt)}
                            </time>
                            <Icon
                              name={
                                running
                                  ? "loader"
                                  : i.status === "failed"
                                    ? "circle-alert"
                                    : meta.icon
                              }
                            />
                            <div className="task-step-body">
                              <p className="task-step-title">
                                <span className="task-kind">{meta.label}</span>
                                {i.title ? ` · ${i.title}` : ""}
                              </p>
                              <ToolDetail text={i.detail} />
                              <p className="task-step-status">
                                {i.status === "completed"
                                  ? `Concluída às ${time(i.updatedAt)}`
                                  : i.status === "failed"
                                    ? `Falhou às ${time(i.updatedAt)}`
                                    : i.status === "pending"
                                      ? "Na fila"
                                      : "Em andamento…"}
                              </p>
                            </div>
                          </div>
                        );
                      }
                      case "plan": {
                        const done = i.entries.filter((e) => e.status === "completed").length;
                        const total = i.entries.length;
                        return (
                          <article className="task-card task-plan" key={i.id}>
                            <p className="task-label">
                              <Icon name="list-checks" />
                              Plano · {done} de {total}{" "}
                              {total === 1 ? "etapa concluída" : "etapas concluídas"}
                            </p>
                            <span
                              className="progress"
                              role="progressbar"
                              aria-valuenow={done}
                              aria-valuemin={0}
                              aria-valuemax={total}
                              aria-label="Etapas concluídas"
                            >
                              <span style={{ "--p": total ? done / total : 0 } as CSSProperties} />
                            </span>
                            <ul className="task-plan-list">
                              {i.entries.map((entry) => (
                                <li key={entry.content} data-status={entry.status}>
                                  {entry.status === "completed" ? (
                                    <Icon name="circle-check" />
                                  ) : entry.status === "in_progress" ? (
                                    <Icon name="loader" />
                                  ) : (
                                    <span className="task-dot" aria-hidden="true" />
                                  )}
                                  <span>{entry.content}</span>
                                </li>
                              ))}
                            </ul>
                          </article>
                        );
                      }
                      case "permission": {
                        const pending =
                          data.permissionsReady &&
                          data.permissions.some(
                            (permission) => permission.requestId === i.requestId,
                          );
                        const step = data.items.find(
                          (other) => other.kind === "tool_call" && other.turnId === i.turnId,
                        );
                        return (
                          <article
                            className="task-card"
                            data-pending={!i.resolution && pending}
                            key={i.id}
                          >
                            <p className="task-label">
                              <Icon name="shield-check" />
                              Permissão de ferramenta ·{" "}
                              <time dateTime={new Date(i.createdAt).toISOString()}>
                                {time(i.createdAt)}
                              </time>
                            </p>
                            <h3>{i.title}</h3>
                            <p>O Boto precisa da sua permissão para usar esta ferramenta.</p>
                            {step?.kind === "tool_call" && (
                              <p className="task-note">
                                Etapa: {step.title}
                                {step.detail ? ` · ${step.detail}` : ""}
                              </p>
                            )}
                            {i.resolution ? (
                              <p className="task-note">
                                <Icon
                                  name={i.resolution.optionId ? "circle-check" : "circle-slash"}
                                />{" "}
                                {
                                  decisions[
                                    i.options.find((o) => o.optionId === i.resolution?.optionId)
                                      ?.kind ?? "reject_once"
                                  ]
                                }{" "}
                                · {time(i.updatedAt)}
                              </p>
                            ) : !pending ? (
                              <p className="task-note" role="status">
                                {data.permissionsReady
                                  ? "Este pedido não está mais disponível."
                                  : "Verificando permissão…"}
                              </p>
                            ) : (
                              <div className="task-actions">
                                {(["allow_once", "allow_always", "reject_once"] as const).map(
                                  (kind) => {
                                    const option = i.options.find((o) => o.kind === kind);
                                    return (
                                      option && (
                                        <button
                                          type="button"
                                          key={kind}
                                          className={`btn ${kind === "allow_once" ? "btn-primary" : "btn-outline"}`}
                                          disabled={busy}
                                          onClick={() =>
                                            void act(() =>
                                              client.request("permissions.respond", {
                                                requestId: i.requestId,
                                                optionId: option.optionId,
                                              }),
                                            )
                                          }
                                        >
                                          {labels[kind]}
                                        </button>
                                      )
                                    );
                                  },
                                )}
                              </div>
                            )}
                          </article>
                        );
                      }
                      case "error":
                        return (
                          <p className="task-error task-step" key={i.id}>
                            <Icon name="circle-alert" />
                            {i.message}
                          </p>
                        );
                      case "compaction":
                        return (
                          <p className="task-note" key={i.id}>
                            Contexto resumido ·{" "}
                            {i.summary ||
                              (i.status === "running"
                                ? "Em andamento"
                                : i.status === "failed"
                                  ? "Falhou"
                                  : "Concluído")}
                          </p>
                        );
                      case "session_reset":
                        return (
                          <p className="task-note" key={i.id}>
                            Uma nova sessão foi iniciada.
                          </p>
                        );
                      default:
                        return null;
                    }
                  })}
                </>
              )}
            </div>
          </div>
          <div className="tl-compose">
            <div className="composer composer-sm">
              <div className="composer-files" hidden={!files.length}>
                {files.map((file) => (
                  <span className="task-file od-row" key={fileIds.current.get(file)}>
                    <Icon name="file-text" />
                    <span className="od-truncate">{file.name}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      disabled={busy}
                      aria-label={`Remover ${file.name}`}
                      onClick={() =>
                        setFiles((previous) => previous.filter((item) => item !== file))
                      }
                    >
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
              </div>
              <label className="sr-only" htmlFor="instruct-input">
                Instrução para o Boto
              </label>
              <textarea
                className="composer-input"
                id="instruct-input"
                rows={1}
                placeholder="Mande uma instrução sem interromper o trabalho"
                autoComplete="off"
                ref={input}
                value={text}
                disabled={!task || task.outcome === "stopped" || busy}
                aria-describedby={task?.outcome === "stopped" ? "instruct-help" : undefined}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bar">
                <button
                  type="button"
                  className="btn btn-outline btn-icon btn-pill composer-attach"
                  data-action="attach"
                  data-tip="Anexar arquivo"
                  aria-label="Anexar arquivo"
                  title="Anexar arquivo"
                  disabled={!task || task.outcome === "stopped" || busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="plus" />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  id="instruct-files"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  multiple
                  disabled={!task || task.outcome === "stopped" || busy}
                  onChange={(event) => {
                    const added = Array.from(event.target.files ?? []);
                    for (const file of added) fileIds.current.set(file, crypto.randomUUID());
                    const next = [...files, ...added];
                    event.target.value = "";
                    const invalid = attachmentError(next);
                    if (invalid) toast(invalid);
                    else setFiles(next);
                    input.current?.focus();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-icon btn-pill composer-send"
                  id="instruct-send"
                  aria-label="Enviar instrução"
                  disabled={!task || !text.trim() || busy || task.outcome === "stopped"}
                  data-tip="Enviar instrução"
                  title="Enviar instrução"
                  onClick={send}
                >
                  <Icon name="arrow-up" />
                </button>
              </div>
            </div>
            {task?.outcome === "stopped" && (
              <p className="task-note" id="instruct-help">
                Esta tarefa foi encerrada e não recebe novas instruções.
              </p>
            )}
          </div>
        </section>
        {/* biome-ignore lint/a11y/useSemanticElements: interactive adjustable separator, not a thematic break. */}
        <div
          className="split"
          id="split"
          role="separator"
          aria-orientation="vertical"
          aria-controls="tl-pane"
          aria-label="Divisão entre a atividade e a área de trabalho"
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={split}
          tabIndex={0}
          onDoubleClick={() => setSplit(42)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setSplit((value) => clampSplit(value + (event.key === "ArrowLeft" ? -2 : 2)));
            }
            if (event.key === "Enter") setSplit(42);
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              setSplit(event.key === "Home" ? 30 : 70);
            }
          }}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = body.current?.getBoundingClientRect();
            if (rect) setSplit(clampSplit(((event.clientX - rect.left) / rect.width) * 100));
          }}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: preserve the desktop pane prototype contract. */}
        <div className="pc" id="pc-pane" role="region" aria-label="Área de trabalho do bot">
          <div className="desk" id="task-desk" data-desk="task">
            <LiveDesk
              session={session}
              available={!!machine}
              onRelease={() => void act(session.release)}
              onExpand={machine ? () => setVmOpen(true) : undefined}
            />
          </div>
        </div>
      </div>
      {machine && (
        <VmDialog machineId={machine.id} open={vmOpen} onClose={() => setVmOpen(false)} />
      )}
    </section>
  );
}
