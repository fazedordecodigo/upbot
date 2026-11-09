import type { Agent, AgentOverview } from "@boto/protocol";
import { useRef, useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { PROVIDER_NAMES } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import { Switch } from "../ui/Switch";
import { useToast } from "../ui/Toast";
import { AgentHeading, TaskRows } from "./AgentParts";

export function AgentPanel({
  agent,
  overview,
  onClose,
}: {
  agent: Agent;
  overview: AgentOverview;
  onClose: () => void;
}) {
  const { client } = useDaemon();
  const toast = useToast();
  const confirm = useConfirm();
  const agentId = agent.id;
  const queue = useDaemonQuery(
    client,
    "queue.get",
    { agentId },
    { events: { "queue.updated": (data) => data.agentId === agentId } },
  );
  const history = useDaemonQuery(
    client,
    "chat.history",
    { agentId, limit: 20 },
    {
      events: {
        "item.created": (data) => data.agentId === agentId,
        "item.updated": (data) => data.agentId === agentId,
        "turn.ended": (data) => data.agentId === agentId,
      },
    },
  );
  const memories = useDaemonQuery(
    client,
    "memories.list",
    { agentId },
    { events: { "memories.changed": (data) => data.agentId === agentId } },
  );
  const config = useDaemonQuery(
    client,
    "agents.configOptions",
    { agentId },
    { events: { "agent.config": (data) => data.agentId === agentId } },
  );
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const immediate = !overview.paused && overview.instances.active < overview.instances.capacity;
  const last = history.data?.items.filter((item) => item.kind === "agent_message").at(-1);
  async function delegate() {
    if (busy) return;
    if (!text.trim()) {
      setError("Descreva a tarefa antes de delegar.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client.request("tasks.create", { agentId, text: text.trim() });
      setText("");
      toast(`Tarefa delegada a ${agent.name}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function update(fields: { requireApproval?: boolean; maxInstances?: number | null }) {
    setSaving(true);
    setSettingsError("");
    try {
      await client.request("agents.update", { id: agentId, ...fields });
    } catch (e) {
      setSettingsError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function toggleQueue() {
    try {
      await client.request(overview.paused ? "queue.resume" : "queue.pause", { agentId });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  async function deleteAgent() {
    if (saving) return;
    setSaving(true);
    try {
      const confirmed = await confirm({
        title: `Excluir ${agent.name}?`,
        description:
          "O agente sai do quadro e a fila dele é cancelada. A pasta de trabalho fica no computador.",
        action: "Excluir agente",
      });
      if (!confirmed) return;
      await client.request("agents.delete", { id: agentId });
      toast(`${agent.name} foi excluído.`);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Sheet
      open
      onClose={onClose}
      id="agent-panel"
      className="agent-panel"
      aria-labelledby="ap-title"
    >
      <div className="ap">
        <header className="ap-head">
          <div id="ap-head" className="ap-head-main">
            <AgentHeading agent={agent} overview={overview} panel />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm ap-close"
            aria-label="Fechar painel do agente"
            title="Fechar painel do agente"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="ap-body od-scroll">
          <div id="ap-live" className="ap-stack">
            <section className="ap-section">
              <h3 className="ap-sec-title">Agora</h3>
              <div className="ap-row od-row">
                <span className="ap-row-name">Instâncias</span>
                <span className="od-nowrap">
                  {overview.instances.active} de {overview.instances.max ?? "a definir"}
                </span>
              </div>
              <TaskRows overview={overview} />
            </section>
            <section className="ap-section">
              <div className="od-row">
                <h3 className="ap-sec-title od-fill">Fila</h3>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void toggleQueue()}
                >
                  {overview.paused ? "Retomar fila" : "Pausar fila"}
                </button>
              </div>
              {queue.error ? (
                <p role="alert">{queue.error}</p>
              ) : !queue.data ? (
                <p role="status">Carregando fila…</p>
              ) : queue.data.items.length ? (
                <ul className="ag-tasks">
                  {queue.data.items.map((item) => (
                    <li key={item.id}>
                      <span className="od-truncate od-fill">{item.text}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        aria-label="Remover da fila"
                        onClick={() =>
                          void client
                            .request("queue.remove", { queueId: item.id })
                            .catch((e) => toast(errorMessage(e)))
                        }
                      >
                        <Icon name="x" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ag-empty">Fila vazia.</p>
              )}
            </section>
            <section className="ap-section">
              <h3 className="ap-sec-title">Última resposta</h3>
              {history.error ? (
                <p role="alert">{history.error}</p>
              ) : (
                <p className="od-clamp-3">{last?.text || "Ainda sem respostas."}</p>
              )}
            </section>
          </div>
          <section className="ap-section" aria-labelledby="ap-add-title">
            <h3 className="ap-sec-title" id="ap-add-title">
              Delegar a este agente
            </h3>
            <div className="field">
              <label className="label" htmlFor="ap-add-input">
                Tarefa
              </label>
              <textarea
                ref={input}
                className="textarea"
                id="ap-add-input"
                rows={2}
                aria-describedby="ap-add-help ap-add-error"
                aria-invalid={!!error}
                placeholder="Descreva a tarefa e o resultado esperado"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void delegate();
                  }
                }}
              />
              <p className="field-help" id="ap-add-help">
                {overview.paused
                  ? "A fila está pausada. A tarefa espera você retomar."
                  : immediate
                    ? "Começa agora numa instância livre."
                    : "Entra na fila e começa quando uma instância ficar livre."}
              </p>
              <p className="field-error" id="ap-add-error" hidden={!error}>
                {error}
              </p>
            </div>
            <div className="ap-add-foot od-row">
              <button
                type="button"
                className="btn btn-primary"
                id="ap-add-btn"
                disabled={busy}
                onClick={() => void delegate()}
              >
                <span id="ap-add-label">{immediate ? "Delegar agora" : "Colocar na fila"}</span>
                <Icon name="arrow-right" />
              </button>
            </div>
          </section>
          <div id="ap-info" className="ap-stack">
            <section className="ap-section">
              <h3 className="ap-sec-title">Sobre este agente</h3>
              <div className="ap-row od-row">
                <span className="ap-row-name">O que ele faz</span>
                <span className="ap-row-help">{agent.role || "Sem descrição"}</span>
              </div>
              <div className="ap-row od-row">
                <span className="ap-row-name">Provedor</span>
                <span>{PROVIDER_NAMES[agent.provider]}</span>
              </div>
              <div className="ap-row od-row">
                <span className="od-field od-fill">
                  <span className="ap-row-name" id="ap-approval-label">
                    Pedir aprovação
                  </span>
                  <span className="ap-row-help" id="ap-approval-help">
                    Para e pergunta antes de enviar e-mail, publicar ou abrir um PR.
                  </span>
                </span>
                <Switch
                  checked={agent.requireApproval}
                  disabled={saving}
                  onCheckedChange={(requireApproval) => void update({ requireApproval })}
                  aria-labelledby="ap-approval-label"
                  aria-describedby="ap-approval-help"
                />
              </div>
              <div className="ap-row">
                <label className="ap-row-name" htmlFor="ap-max">
                  Instâncias em paralelo
                </label>
                <select
                  id="ap-max"
                  disabled={saving}
                  value={agent.maxInstances ?? ""}
                  onChange={(e) =>
                    void update({ maxInstances: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">a definir</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              {config.data?.configOptions.map((option) => (
                <div className="ap-row" key={option.id}>
                  <label htmlFor={`ap-config-${option.id}`}>{option.name}</label>
                  <select
                    id={`ap-config-${option.id}`}
                    value={option.currentValue}
                    onChange={(e) =>
                      void client
                        .request("agents.setConfig", {
                          agentId,
                          configId: option.id,
                          value: e.target.value,
                        })
                        .then((result) => config.setData(result))
                        .catch((e) => setSettingsError(errorMessage(e)))
                    }
                  >
                    {option.options.map((value) => (
                      <option key={value.value} value={value.value}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {settingsError && (
                <p className="field-error" role="alert">
                  {settingsError}
                </p>
              )}
              <div className="ap-row od-row">
                <span className="ap-row-name">Memórias</span>
                <span className="ap-row-help">
                  {memories.error ||
                    (memories.data
                      ? memories.data.length
                        ? `${memories.data.length} itens`
                        : "Nenhuma memória"
                      : "Carregando…")}
                </span>
              </div>
            </section>
            <button
              type="button"
              className="btn btn-outline ap-delete"
              disabled={saving}
              onClick={() => void deleteAgent()}
            >
              Excluir agente
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
