import type { ToolMode, When } from "@boto/protocol";
import { useEffect, useRef, useState } from "react";
import { errorFields, logWarn } from "../lib/log";
import { attachmentError, delegateTask, draftError, greeting } from "../lib/new-task";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { usePrivateMode } from "../shell/Topbar";
import { Icon } from "../ui/icons";
import { Switch } from "../ui/Switch";
import { useToast } from "../ui/Toast";
import { ToolPicker, WhenPicker } from "./new-task/ComposerOptions";
import "./NewTaskView.css";

export function NewTaskView() {
  const { params } = useRouter();
  return (
    <NewTaskComposer
      key={`${params.agentId ?? ""}:${params.templateId ?? ""}:${params.when ?? ""}`}
    />
  );
}

function NewTaskComposer() {
  const { client, connected, agents } = useDaemon();
  const { navigate, params } = useRouter();
  const { privateMode } = usePrivateMode();
  const toast = useToast();
  const [text, setText] = useState("");
  const agentId =
    agents.find((agent) => agent.id === params.agentId)?.id ??
    agents.find((agent) => agent.isDefault)?.id ??
    "";
  const [when, setWhen] = useState<When>(params.when === "daily" ? "daily" : "now");
  const [schedule, setSchedule] = useState<string | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>("both");
  const [requireApproval, setRequireApproval] = useState(true);
  const [templateId, setTemplateId] = useState<string>();
  const [files, setFiles] = useState<File[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [templateMissing, setTemplateMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileIds = useRef(new WeakMap<File, string>());
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads a failed request.
  useEffect(() => {
    if (!connected || loaded) return;
    let active = true;
    setLoadError(false);
    void Promise.all([
      client.request("profile.get", {}),
      params.templateId
        ? client.request("templates.use", { id: params.templateId }).catch((cause: unknown) => {
            if ((cause as { code?: unknown })?.code !== "not_found") throw cause;
            return null;
          })
        : null,
    ])
      .then(([profile, template]) => {
        if (!active) return;
        setToolMode(template?.toolMode ?? profile.defaults.toolMode);
        setRequireApproval(
          template?.requireApproval ??
            (profile.defaults.delegationMode === "approval" || profile.defaults.requireApproval),
        );
        setTemplateMissing(Boolean(params.templateId) && !template);
        setWhen(
          params.when === "daily"
            ? "daily"
            : profile.defaults.delegationMode === "scheduled"
              ? "in1h"
              : "now",
        );
        if (template) {
          setText(template.prompt);
          setTemplateId(template.templateId);
          setWhen(template.when ?? "now");
          setSchedule(template.when ? null : template.schedule);
        }
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        logWarn("new_task.load_failed", errorFields(cause));
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [client, connected, loaded, params.templateId, params.when, retry]);

  const agentExists = agents.some((agent) => agent.id === agentId);
  const draft = {
    agentId: agentExists ? agentId : "",
    text,
    when,
    schedule,
    toolMode,
    requireApproval,
    private: privateMode,
    templateId,
    files,
  };
  const invalid = agentId ? draftError(draft) : "O bot padrão não está disponível.";
  const busy = submitting || !loaded;
  const submit = async () => {
    if (pending.current || !connected || !loaded || invalid) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await delegateTask(client, draft);
      if (!alive.current) return;
      if (result.view === "routines") toast("Rotina criada.");
      navigate(result.view, { id: result.id });
    } catch (cause: unknown) {
      logWarn("new_task.delegate_failed", errorFields(cause));
      if (alive.current)
        setError("Não foi possível delegar a tarefa. Seu texto e seus anexos foram mantidos.");
    } finally {
      pending.current = false;
      if (alive.current) setSubmitting(false);
    }
  };

  return (
    <section className="view chat" id="view-new" aria-labelledby="chat-title">
      <div className="chat-scroll od-scroll">
        <div className="chat-inner" role="log" aria-label="Conversa com o Boto">
          <div className="chat-msg">
            <span className="chat-avatar" aria-hidden="true">
              <img width="20" height="20" src="/assets/boto-simbolo.svg" alt="" />
            </span>
            <div className="chat-body">
              <p className="chat-label">Boto</p>
              <p className="chat-greeting" id="chat-greeting">
                {greeting()}
              </p>
              <h1 className="chat-title" id="chat-title" tabIndex={-1}>
                O que eu devo fazer hoje?
              </h1>
              <p className="chat-text">
                Descreva a tarefa e o resultado esperado. Trabalho no meu computador na nuvem,
                mostro cada etapa e peço sua aprovação antes de ações externas.
              </p>
              <div className="chat-mem" id="chat-greet-mem" />
              <button
                type="button"
                className="btn btn-outline btn-sm chat-link"
                data-action="go-templates"
                onClick={() => navigate("templates")}
              >
                <Icon name="layout-template" />
                Começar de um modelo
              </button>
            </div>
          </div>
          <div className="chat-msg" id="chat-template-note" hidden>
            <span className="chat-avatar" aria-hidden="true">
              <img width="20" height="20" src="/assets/boto-simbolo.svg" alt="" />
            </span>
            <div className="chat-body">
              <p className="chat-label">Boto</p>
              <p className="chat-text" id="chat-template-text" />
              <div className="chat-mem" id="chat-template-mem" />
            </div>
          </div>
        </div>
      </div>
      <div className="chat-compose">
        <p className="hero-private od-row" id="hero-private" hidden={!privateMode}>
          <Icon name="eye-off" />
          <span>Tarefa privada: ela não fica no histórico nem nas entregas.</span>
        </p>
        <div className="composer" id="composer" data-when={when} aria-busy={submitting}>
          <div className="composer-files" id="composer-files" hidden={!files.length}>
            {files.map((file) => (
              <span className="new-task-file od-row" key={fileIds.current.get(file)}>
                <Icon name="file-text" />
                <span className="od-truncate">{file.name}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  disabled={submitting}
                  aria-label={`Remover ${file.name}`}
                  onClick={() => setFiles((previous) => previous.filter((item) => item !== file))}
                >
                  <Icon name="x" />
                </button>
              </span>
            ))}
          </div>
          <label className="sr-only" htmlFor="composer-input">
            Tarefa para o Boto
          </label>
          <textarea
            ref={input}
            className="composer-input"
            id="composer-input"
            rows={2}
            placeholder="Descreva a tarefa e o resultado esperado"
            autoComplete="off"
            maxLength={100_000}
            value={text}
            disabled={busy}
            aria-describedby="new-task-status"
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (!event.shiftKey && event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-bar">
            <button
              type="button"
              className="btn btn-ghost btn-icon composer-attach"
              data-action="attach"
              data-tip="Anexar arquivo"
              aria-label="Anexar arquivo"
              title="Anexar arquivo"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="paperclip" />
            </button>
            <input
              ref={fileInput}
              type="file"
              id="file-input"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              multiple
              disabled={busy}
              onChange={(event) => {
                const added = Array.from(event.target.files ?? []);
                for (const file of added) fileIds.current.set(file, crypto.randomUUID());
                const next = [...files, ...added];
                event.target.value = "";
                const invalidFiles = attachmentError(next);
                if (invalidFiles) setError(invalidFiles);
                else {
                  setFiles(next);
                  setError(null);
                }
                input.current?.focus();
              }}
            />{" "}
            <WhenPicker
              when={when}
              schedule={schedule}
              disabled={busy}
              onChange={(value) => {
                setWhen(value);
                setSchedule(null);
                setError(null);
              }}
            />{" "}
            <ToolPicker value={toolMode} disabled={busy} onChange={setToolMode} />
            <div className="opt-approval od-row">
              <Icon name="shield-check" />
              <span id="approval-label">Pedir aprovação</span>
              <Switch
                id="approval-switch"
                checked={requireApproval}
                onCheckedChange={setRequireApproval}
                disabled={busy}
                aria-labelledby="approval-label"
                aria-describedby="approval-help"
              />
              <span className="sr-only" id="approval-help">
                O Boto para e pergunta antes de ações externas, como enviar e-mail, publicar ou
                abrir um PR.
              </span>
            </div>
            <span className="composer-spacer" />
            <button
              type="button"
              className="btn btn-primary btn-pill composer-send"
              id="send"
              disabled={busy || !connected || invalid !== null}
              onClick={() => void submit()}
            >
              <span id="send-label">{submitting ? "Delegando…" : "Delegar"}</span>
              <Icon name={submitting ? "loader" : "arrow-right"} />
            </button>
          </div>
        </div>
        <div id="new-task-status" className="new-task-status" role="status" aria-live="polite">
          {error ? (
            <p>{error}</p>
          ) : !connected ? (
            <p>Aguardando conexão com o Boto…</p>
          ) : loadError ? (
            <p>
              Não foi possível carregar as opções da tarefa.{" "}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                Tentar de novo
              </button>
            </p>
          ) : !loaded ? (
            <p>Carregando opções da tarefa…</p>
          ) : !agents.length ? (
            <p>
              Nenhum bot disponível.{" "}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => navigate("agents")}
              >
                Criar bot
              </button>
            </p>
          ) : !agentExists ? (
            <p>O bot padrão não está disponível. Você pode delegar a outro bot em Bots.</p>
          ) : templateMissing && !text.trim() ? (
            <p>
              Este modelo não está mais disponível. Descreva a tarefa ou{" "}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => navigate("templates")}
              >
                escolha outro modelo
              </button>
            </p>
          ) : text.trim() && invalid ? (
            <p>{invalid}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
