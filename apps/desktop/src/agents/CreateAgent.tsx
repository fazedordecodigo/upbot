import type { Agent } from "@boto/protocol";
import { useRef, useState } from "react";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";
import { useToast } from "../ui/Toast";

export function CreateAgent({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const { client } = useDaemon();
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [approval, setApproval] = useState(true);
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function create() {
    if (!name.trim()) {
      setNameError("Dê um nome ao bot.");
      input.current?.focus();
      return;
    }
    setNameError("");
    setError("");
    setBusy(true);
    try {
      const agent = await client.request("agents.create", {
        name: name.trim(),
        role: role.trim(),
        requireApproval: approval,
      });
      toast(`${agent.name} foi criado.`);
      onCreated(agent);
    } catch (e) {
      const message = errorMessage(e);
      setError(
        message.includes("provider is required")
          ? `${message}. Escolha um provedor de IA em Configurações.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      id="agent-new"
      className="agent-new"
      aria-labelledby="an-title"
      aria-describedby="an-desc"
      closeButton
    >
      <div className="dialog-body">
        <div className="dialog-header">
          <h2 className="dialog-title" id="an-title">
            Novo bot
          </h2>
          <p className="dialog-description" id="an-desc">
            Um bot é um colega com uma especialidade. Ele pode usar todas as ferramentas disponíveis
            no computador do Boto e pede sua permissão na primeira vez que usa cada uma numa sessão.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="an-name">
            Nome
          </label>
          <input
            ref={input}
            className="input"
            id="an-name"
            maxLength={32}
            autoComplete="off"
            aria-describedby="an-name-error"
            aria-invalid={!!nameError}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-error" id="an-name-error" hidden={!nameError}>
            {nameError}
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="an-role">
            O que ele faz <span className="label-opt">(opcional)</span>
          </label>
          <textarea
            className="textarea"
            id="an-role"
            rows={2}
            maxLength={140}
            placeholder="Por exemplo: confere as notas fiscais e atualiza a planilha do financeiro"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </div>
        <div className="an-row od-row">
          <span className="od-field od-fill">
            <span className="ap-row-name" id="an-approval-label">
              Pedir aprovação
            </span>
            <span className="ap-row-help" id="an-approval-help">
              Para e pergunta antes de enviar e-mail, publicar ou abrir um PR.
            </span>
          </span>
          <Switch
            checked={approval}
            onCheckedChange={setApproval}
            id="an-approval"
            aria-labelledby="an-approval-label"
            aria-describedby="an-approval-help"
          />
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            id="an-create"
            disabled={busy}
            onClick={() => void create()}
          >
            Criar bot
          </button>
        </div>
      </div>
    </Dialog>
  );
}
