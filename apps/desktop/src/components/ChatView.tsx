import type { Agent } from "@boto/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useChatApi } from "../hooks/useChat";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useMediaQuery } from "../hooks/useLayerFocus";
import type { AgentOverview } from "../hooks/useOverview";
import { workspaceOf } from "../lib/agent-surface";
import { decideApproval } from "../lib/approval-decisions";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { moveControlFocus } from "../lib/keyboard";
import { errorFields, logWarn } from "../lib/log";
import { role, ST } from "../lib/ui";
import { AgentDesk } from "./AgentDesk";
import { PermissionNotice } from "./AgentSettings";
import { ApprovalCards } from "./ApprovalsView";
import { Composer } from "./Composer";
import { DraftCards } from "./EmailView";
import { Icon } from "./icons";
import { MessageList } from "./MessageList";
import { SituationStatus } from "./SituationStatus";

export function ChatView({
  client,
  agent,
  overview,
  onOpenSettings,
  onHome,
  notice,
  onNoticeDismiss,
}: {
  client: DaemonClient;
  agent: Agent;
  overview: AgentOverview | undefined;
  onOpenSettings: () => void;
  onHome: () => void;
  notice: string | null;
  onNoticeDismiss: () => void;
}) {
  const { items, hasMore, runningTurn, loaded, queue, errors, loadEarlier, queueRemove } =
    useChatApi();
  const [sendBusy, setSendBusy] = useState(false);
  const {
    data: permissions,
    loaded: permissionsLoaded,
    error: permissionsError,
    setData: setPermissions,
  } = useDaemonQuery(
    client,
    "permissions.list",
    {},
    {
      events: { "permission.requested": true, "permission.resolved": true },
      onError: (e) => logWarn("permissions.list_failed", errorFields(e)),
    },
  );
  useEffect(
    () =>
      client.on("permission.requested", (permission) => {
        setPermissions((previous) => [
          ...(previous ?? []).filter((item) => item.requestId !== permission.requestId),
          permission,
        ]);
      }),
    [client, setPermissions],
  );
  const livePermissionIds =
    permissionsLoaded && !permissionsError
      ? new Set(
          permissions
            ?.filter((permission) => permission.agentId === agent.id)
            .map((permission) => permission.requestId),
        )
      : undefined;
  const [voice, setVoice] = useState({ tts: false, stt: false });
  const [composerText, setComposerText] = useState("");
  const [modeError, setModeError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    client
      .request("voice.status", {})
      .then(setVoice)
      .catch((e: unknown) => logWarn("voice.status_failed", errorFields(e)));
  }, [client]);

  const isClaude = agent.provider === "claude";
  const isCodex = agent.provider === "codex";
  const supportsModes = isClaude || isCodex;
  const mode = agent.config?.mode ?? (isClaude ? "default" : "auto");
  const safeMode = mode === "plan" || mode === "read-only";
  const latestUser = [...items].reverse().find((item) => item.kind === "user_message");
  const isDirectMessage =
    latestUser?.kind === "user_message" &&
    !latestUser.from &&
    !latestUser.gateway &&
    !latestUser.routine &&
    !latestUser.channelId &&
    !latestUser.team;
  const retryHasAttachments =
    latestUser?.kind === "user_message" &&
    isDirectMessage &&
    Boolean(latestUser.attachments?.length);
  const canRetry =
    latestUser?.kind === "user_message" &&
    isDirectMessage &&
    !retryHasAttachments &&
    !latestUser.attachments?.length;

  const setMode = async (value: string) => {
    setModeError(null);
    try {
      await client.request("agents.setConfig", { agentId: agent.id, configId: "mode", value });
    } catch (e) {
      setModeError(errorMessage(e));
    }
  };

  const send = useCallback(
    async (text: string, attachments: { name: string; mime: string; dataBase64: string }[]) => {
      setSendBusy(true);
      setSendError(null);
      try {
        await client.request("chat.send", {
          agentId: agent.id,
          text,
          ...(attachments.length ? { attachments } : {}),
        });
      } catch (e) {
        setSendError(errorMessage(e));
        throw e;
      } finally {
        setSendBusy(false);
      }
    },
    [client, agent.id],
  );

  const retry = useCallback(() => {
    if (latestUser?.kind === "user_message") void send(latestUser.text, []).catch(() => {});
  }, [latestUser, send]);

  const respondPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      void client.request("permissions.respond", { requestId, optionId }).catch((e) => {
        setSendError(errorMessage(e));
      });
    },
    [client],
  );

  const speak = useCallback(
    (text: string) =>
      void client
        .request("voice.speak", { text })
        .catch((e: unknown) => logWarn("voice.speak_failed", errorFields(e))),
    [client],
  );

  const loadEarlierItems = useCallback(() => {
    void loadEarlier();
  }, [loadEarlier]);
  const displayStatus = overview?.status ?? "idle";
  const narrow = useMediaQuery("(max-width: 1023px)");
  const [pane, setPane] = useState<"activity" | "desk">("activity");
  const [deskOpen, setDeskOpen] = useState(true);
  const [split, setSplit] = useState(42);
  const [dragging, setDragging] = useState(false);
  const [userControl, setUserControl] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsId = useId();
  const activityTab = `${tabsId}-tab-activity`;
  const deskTab = `${tabsId}-tab-desk`;
  const activityPane = `${tabsId}-pane-activity`;
  const deskPane = `${tabsId}-pane-desk`;
  const { data: placements } = useDaemonQuery(
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
  const { data: approvals } = useDaemonQuery(
    client,
    "approvals.list",
    { agentId: agent.id },
    { events: { "approval.updated": (item) => item.agentId === agent.id } },
  );
  const takeover = approvals?.find((item) => item.kind === "takeover" && item.status === "pending");
  const workspace = workspaceOf(agent.id, placements, hosts, displayStatus);
  const apps = overview?.apps.map((app) => app.name) ?? [];
  const paused = queue?.paused ?? overview?.paused ?? false;
  const statusLabel =
    paused && displayStatus !== "run" && displayStatus !== "wait"
      ? "Fila pausada"
      : ST[displayStatus];
  const isAsking = supportsModes && safeMode;
  const placeholder = userControl
    ? "Instrução para o agente. A fila segue pausada até você devolver."
    : isAsking
      ? `Pergunte algo para ${agent.name}`
      : `Peça uma tarefa para ${agent.name}`;
  const hint = supportsModes
    ? isAsking
      ? "Modo Perguntar: responde e sugere um plano, sem executar nada."
      : "Modo Agir: executa sozinho e pede aprovação em ações sensíveis."
    : "Enter envia · Shift+Enter quebra linha";

  const assumeControl = async () => {
    setActionError(null);
    if (takeover) {
      try {
        await decideApproval(client, takeover, "done");
      } catch (e) {
        setActionError(errorMessage(e));
      }
      return;
    }
    try {
      await client.request("queue.pause", { agentId: agent.id });
      await client.request("chat.cancel", { agentId: agent.id });
      setUserControl(true);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const returnControl = async () => {
    setActionError(null);
    try {
      await client.request("queue.resume", { agentId: agent.id });
      setUserControl(false);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const togglePause = async () => {
    setActionError(null);
    try {
      if (paused || userControl) {
        await client.request("queue.resume", { agentId: agent.id });
        setUserControl(false);
      } else {
        await client.request("queue.pause", { agentId: agent.id });
      }
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const endTask = async () => {
    setStopOpen(false);
    setActionError(null);
    setUserControl(false);
    try {
      await client.request("chat.cancel", { agentId: agent.id });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  return (
    <div className="task-shell" data-od-id="chat-view">
      <header className="task-head" data-tauri-drag-region>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onHome}>
          <Icon name="home" />
          <span className="ctl-label">Início</span>
        </button>
        <div className="task-heading">
          <h1 className="task-title">{overview?.task || agent.name}</h1>
          <div className="task-meta">
            <span>{agent.name}</span>
            <SituationStatus status={displayStatus} paused={paused} />
            <span>{role(agent)}</span>
          </div>
        </div>
        <div className="task-controls">
          {supportsModes && (
            <fieldset className="seg" onKeyDown={moveControlFocus}>
              <legend className="sr">Modo do agente</legend>
              <button
                type="button"
                aria-pressed={isAsking}
                tabIndex={isAsking ? 0 : -1}
                onClick={() => void setMode(isClaude ? "plan" : "read-only")}
              >
                Perguntar
              </button>
              <button
                type="button"
                aria-pressed={!isAsking}
                tabIndex={isAsking ? -1 : 0}
                onClick={() => void setMode(isClaude ? "default" : "auto")}
              >
                Agir
              </button>
            </fieldset>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={deskOpen}
            onClick={() => {
              setDeskOpen((open) => !open);
              if (narrow) setPane((current) => (current === "desk" ? "activity" : "desk"));
            }}
          >
            <Icon name="monitor" />
            <span className="ctl-label">Área de trabalho</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void togglePause()}
          >
            <Icon name={paused || userControl ? "play" : "pause"} />
            <span className="ctl-label">{paused || userControl ? "Retomar" : "Pausar"}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void assumeControl()}
          >
            <Icon name="pointer" />
            <span className="ctl-label">{takeover ? "Concluir etapa" : "Assumir o controle"}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Configurar agente"
            title="Configurar agente"
            onClick={onOpenSettings}
          >
            <Icon name="gear" />
          </button>
          <button
            type="button"
            className="btn btn-destructive btn-sm"
            onClick={() => setStopOpen(true)}
          >
            <Icon name="power" />
            <span className="ctl-label">Encerrar</span>
          </button>
        </div>
      </header>
      <div className="task-tabs">
        <div className="tabs-list" role="tablist" aria-label="Painéis da tarefa">
          <button
            type="button"
            className="tabs-trigger"
            role="tab"
            id={activityTab}
            aria-controls={activityPane}
            aria-selected={pane === "activity"}
            onClick={() => setPane("activity")}
          >
            Atividade
          </button>
          <button
            type="button"
            className="tabs-trigger"
            role="tab"
            id={deskTab}
            aria-controls={deskPane}
            aria-selected={pane === "desk"}
            onClick={() => setPane("desk")}
          >
            Área de trabalho
          </button>
        </div>
      </div>
      <div
        className="task-body"
        ref={bodyRef}
        data-pane={pane}
        data-desk={deskOpen || (narrow && pane === "desk") ? "on" : "off"}
      >
        <div
          className="task-tl"
          id={activityPane}
          {...(narrow ? { role: "tabpanel", "aria-labelledby": activityTab } : {})}
          style={!narrow && deskOpen ? { flexBasis: `${split}%` } : undefined}
        >
          {modeError && <div className="notice is-err">{modeError}</div>}
          {actionError && (
            <div className="notice is-err" role="alert">
              {actionError}
            </div>
          )}
          {(["history", "status", "queue", "earlier", "action"] as const).map((source) =>
            errors[source] ? (
              <div className="notice is-err" key={source} role="alert">
                {errors[source]}
              </div>
            ) : null,
          )}
          <MessageList
            livePermissionIds={livePermissionIds}
            agent={agent}
            status={displayStatus}
            items={items}
            hasMore={hasMore}
            loaded={loaded}
            emptyNotice={<PermissionNotice provider={agent.provider} />}
            running={runningTurn !== null || displayStatus === "run"}
            onLoadEarlier={loadEarlierItems}
            onPermissionRespond={respondPermission}
            onSpeak={voice.tts ? speak : undefined}
            onRetry={retry}
            canRetry={canRetry}
            retryHasAttachments={retryHasAttachments}
            onSuggestion={setComposerText}
          />
          <Composer
            text={composerText}
            onTextChange={setComposerText}
            running={runningTurn !== null || sendBusy}
            placeholder={placeholder}
            hint={hint}
            hintError={sendError}
            onSend={send}
            onStop={() =>
              void client.request("chat.cancel", { agentId: agent.id }).catch((e: unknown) => {
                logWarn("chat.cancel_failed", { agentId: agent.id, ...errorFields(e) });
                setSendError(`Não foi possível parar: ${errorMessage(e)}`);
              })
            }
            onTranscribe={
              voice.stt
                ? async (audioBase64, mime) =>
                    (await client.request("voice.transcribe", { audioBase64, mime })).text
                : undefined
            }
          >
            {notice && (
              <div className="notice">
                {notice}
                <button
                  type="button"
                  aria-label="Dispensar aviso"
                  title="Dispensar aviso"
                  onClick={onNoticeDismiss}
                >
                  ×
                </button>
              </div>
            )}
            {queue && queue.items.length > 0 && (
              <div className="quiet">
                <span className="meta">{`${queue.items.length} na fila`}</span>
                {queue.items.map((item) => (
                  <span className="chip" key={item.id}>
                    {item.text.slice(0, 60)}
                    <button
                      type="button"
                      aria-label="Remover da fila"
                      title="Remover da fila"
                      onClick={() => void queueRemove(item.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ApprovalCards client={client} agentId={agent.id} botName={agent.name} />
            <DraftCards client={client} agentId={agent.id} />
          </Composer>
        </div>
        <hr
          className="task-split"
          aria-orientation="vertical"
          aria-label="Divisão entre a atividade e a área de trabalho"
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={split}
          tabIndex={0}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (!dragging || !bodyRef.current) return;
            const rect = bodyRef.current.getBoundingClientRect();
            const ratio = ((event.clientX - rect.left) / rect.width) * 100;
            setSplit(Math.min(70, Math.max(30, Math.round(ratio))));
          }}
          onPointerUp={() => setDragging(false)}
          onDoubleClick={() => setSplit(42)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") setSplit((value) => Math.max(30, value - 2));
            else if (event.key === "ArrowRight") setSplit((value) => Math.min(70, value + 2));
            else if (event.key === "Enter") setSplit(42);
            else return;
            event.preventDefault();
          }}
        />
        <section
          className="task-desk-pane"
          id={deskPane}
          {...(narrow
            ? { role: "tabpanel", "aria-labelledby": deskTab }
            : { "aria-label": "Área de trabalho do agente" })}
        >
          <AgentDesk
            mode={userControl ? "user" : "boto"}
            machine={workspace.machine}
            statusLabel={statusLabel}
            situation={{ status: displayStatus, paused }}
            task={overview?.task ?? null}
            apps={apps}
            note={
              takeover
                ? "Há uma etapa de navegador esperando você. Conclua na linha do tempo. Esta área não é a janela do navegador."
                : null
            }
            {...(userControl ? { onReturn: () => void returnControl() } : {})}
          />
        </section>
      </div>
      {stopOpen && (
        <StopTaskDialog onCancel={() => setStopOpen(false)} onConfirm={() => void endTask()} />
      )}
    </div>
  );
}

function StopTaskDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="stop-title"
      aria-describedby="stop-desc"
      onClose={onCancel}
    >
      <div className="dlg-body">
        <h2 id="stop-title">Encerrar tarefa</h2>
        <p id="stop-desc" className="field-help">
          O agente para na etapa atual. O que já foi feito permanece no histórico.
        </p>
      </div>
      <div className="dlg-foot">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => dialogRef.current?.close()}
        >
          Continuar a tarefa
        </button>
        <button type="button" className="btn btn-destructive" onClick={onConfirm}>
          Encerrar tarefa
        </button>
      </div>
    </dialog>
  );
}
