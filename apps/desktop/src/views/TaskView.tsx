import type { ChatItem } from "@boto/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { VmDialog } from "../dialogs/VmDialog";
import { useMachine } from "../hooks/useMachine";
import { useTask } from "../hooks/useTask";
import { useTaskMachine } from "../hooks/useTaskMachine";
import { errorFields, logError } from "../lib/log";
import { readStorage, writeStorage } from "../lib/storage";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { LiveDesk } from "../task/LiveDesk";
import { Dialog } from "../ui/Dialog";
import { Icon, type IconName } from "../ui/icons";
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
    (kind) => ({ profile: "Perfil", agent: "Agente", skill: "Skill" })[kind],
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
        Usou {item.memoryUsage.count} itens da memória · {kinds}
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
          <button type="button" className="btn btn-link" onClick={() => navigate("settings")}>
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
    ? "Este agente não tem uma área de trabalho"
    : session.machine?.status !== "ready"
      ? "A máquina ainda não está pronta"
      : task?.situation === "done"
        ? "Esta tarefa já terminou"
        : undefined;
  useEffect(() => {
    writeStorage("boto.task-split", String(split));
  }, [split]);
  useEffect(() => {
    if (session.error) toast(session.error);
  }, [session.error, toast]);
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const current = useRef(params.id);
  current.current = params.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset task-local controls when routing to another task.
  useEffect(() => {
    setText("");
    setConfirm(false);
    setBusy(false);
    bottom.current = true;
  }, [params.id]);
  useEffect(() => {
    if (data.items.length && bottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [data.items]);
  const act = async (operation: () => Promise<unknown>, success?: () => void) => {
    const id = params.id;
    setBusy(true);
    try {
      await operation();
      if (current.current === id) success?.();
    } catch (error) {
      logError("task.action_failed", errorFields(error));
      if (current.current === id) toast("Não foi possível concluir a ação. Tente de novo.");
    } finally {
      if (current.current === id) setBusy(false);
    }
  };
  const send = () => {
    if (!task || !text.trim() || busy || task.outcome === "stopped") return;
    void act(
      () => client.request("tasks.instruct", { id: task.id, text: text.trim() }),
      () => {
        setText("");
        if (input.current) input.current.style.height = "auto";
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
            onClick={() => setConfirm(true)}
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
                      const decidedAt = a.interruptedAt ?? data.approvalTimes[a.id];
                      return (
                        <article
                          className="task-card"
                          data-pending={a.status === "pending"}
                          key={a.id}
                        >
                          <h3>
                            <Icon name="shield-check" />
                            {a.title}
                          </h3>
                          <p>{a.detail}</p>
                          {a.status === "pending" ? (
                            <div className="task-actions">
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
                                Aprovar
                              </button>
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
                      case "user_message":
                        return (
                          <div className="task-user" key={i.id}>
                            {i.text}
                          </div>
                        );
                      case "agent_message":
                        return (
                          <article className="task-message" key={i.id}>
                            <p>{i.text}</p>
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
                      case "tool_call":
                        return (
                          <div className="task-step" key={i.id}>
                            <Icon
                              name={
                                i.status === "failed"
                                  ? "circle-alert"
                                  : i.status === "completed"
                                    ? "circle-check"
                                    : "loader"
                              }
                            />
                            <div>
                              <p>{i.title}</p>
                              {i.detail && <p className="task-note">{i.detail}</p>}
                            </div>
                          </div>
                        );
                      case "permission": {
                        const step = data.items.find(
                          (other) => other.kind === "tool_call" && other.turnId === i.turnId,
                        );
                        return (
                          <article className="task-card" data-pending={!i.resolution} key={i.id}>
                            <h3>
                              <Icon name="shield-check" />
                              {i.title}
                            </h3>
                            <p>O Boto precisa da sua permissão para usar esta ferramenta.</p>
                            {step?.kind === "tool_call" && (
                              <p className="task-note">
                                Etapa: {step.title}
                                {step.detail ? ` · ${step.detail}` : ""}
                              </p>
                            )}
                            {i.resolution ? (
                              <p className="task-note">
                                {i.options
                                  .find((o) => o.optionId === i.resolution?.optionId)
                                  ?.kind.startsWith("allow")
                                  ? "Permitido"
                                  : "Não permitido"}{" "}
                                · {time(i.updatedAt)}
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
                onChange={(event) => {
                  setText(event.target.value);
                  event.target.style.height = "auto";
                  event.target.style.height = `${event.target.scrollHeight}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-icon btn-pill"
                id="instruct-send"
                aria-label="Enviar instrução"
                disabled={!task || !text.trim() || busy || task.outcome === "stopped"}
                data-tip="Enviar instrução"
                title="Enviar instrução"
                onClick={send}
              >
                <Icon name="send" />
              </button>
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
              setSplit((value) =>
                Math.max(30, Math.min(70, value + (event.key === "ArrowLeft" ? -2 : 2))),
              );
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
            if (rect)
              setSplit(
                Math.max(30, Math.min(70, ((event.clientX - rect.left) / rect.width) * 100)),
              );
          }}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: preserve the desktop pane prototype contract. */}
        <div className="pc" id="pc-pane" role="region" aria-label="Área de trabalho do agente">
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
      <Dialog
        id="confirm-stop"
        open={confirm}
        onClose={() => setConfirm(false)}
        aria-labelledby="confirm-stop-title"
        aria-describedby="confirm-stop-desc"
      >
        <div className="dialog-body">
          <div className="dialog-header">
            <h2 className="dialog-title" id="confirm-stop-title">
              Encerrar esta tarefa?
            </h2>
            <p className="dialog-description" id="confirm-stop-desc">
              O Boto para na etapa atual e não continua depois. O que já foi feito fica em Arquivos.
            </p>
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn btn-outline" onClick={() => setConfirm(false)}>
              Continuar a tarefa
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              id="confirm-stop-btn"
              disabled={busy}
              onClick={() =>
                task &&
                void act(
                  () => client.request("tasks.stop", { id: task.id }),
                  () => setConfirm(false),
                )
              }
            >
              Encerrar tarefa
            </button>
          </div>
        </div>
      </Dialog>
      {machine && (
        <VmDialog machineId={machine.id} open={vmOpen} onClose={() => setVmOpen(false)} />
      )}
    </section>
  );
}
