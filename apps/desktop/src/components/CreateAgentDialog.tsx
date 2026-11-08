import type { AgentAvatar, ProviderId } from "@boto/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { statusProvider } from "../lib/ui";
import { PROVIDERS } from "./AgentSettings";
import { Switch } from "./ds/controls";
import { Icon } from "./icons";

export type Autonomy = "ask" | "sensitive" | "auto";

export type NewAgentForm = {
  name: string;
  provider: ProviderId;
  instructions: string;
  autonomy: Autonomy;
  avatar: AgentAvatar | null;
};

export function CreateAgentDialog({
  client,
  onSubmit,
  onCancel,
}: {
  client: DaemonClient;
  onSubmit: (form: NewAgentForm) => Promise<void>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const approvalHelp = useId();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<AgentAvatar | null>(null);
  const [askApproval, setAskApproval] = useState(true);
  const [nameError, setNameError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const suggest = async () => {
    setDraftError(null);
    setDrafting(true);
    try {
      const proposal = await client.request("agents.draft", { prompt: instructions.trim() });
      setName(proposal.name);
      setInstructions(proposal.instructions);
      setAvatar(proposal.avatar);
    } catch (e) {
      setDraftError(errorMessage(e));
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previous?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="agent-new"
      aria-labelledby="dlgTitle"
      aria-describedby="dlgDesc"
      data-od-id="new-agent-dialog"
      onClose={onCancel}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmedName = name.trim();
          if (!trimmedName) {
            setNameError(true);
            return;
          }
          setNameError(false);
          setSubmitError(null);
          setBusy(true);
          try {
            await onSubmit({
              name: trimmedName,
              provider,
              instructions: instructions.trim(),
              autonomy: askApproval ? "ask" : "auto",
              avatar,
            });
          } catch (e) {
            setSubmitError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <div className="dlg-body">
          <div className="dlg-head agent-new-head">
            <div>
              <h2 id="dlgTitle">Novo agente</h2>
              <p id="dlgDesc" className="field-help">
                Um agente é um colega com uma especialidade. Ele pede permissão na primeira vez que
                usa cada ferramenta numa sessão.
              </p>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Fechar"
              onClick={() => dialogRef.current?.close()}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="field">
            <label className="label" htmlFor="fName">
              Nome
            </label>
            <input
              className="input"
              id="fName"
              placeholder="Por exemplo: Notas fiscais"
              value={name}
              maxLength={80}
              aria-invalid={nameError}
              aria-describedby={nameError ? "fNameErr" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (event.target.value.trim()) setNameError(false);
              }}
            />
            {nameError && (
              <span className="err" id="fNameErr">
                Dê um nome ao agente.
              </span>
            )}
          </div>
          <div className="field">
            <div className="section-head">
              <label className="label" htmlFor="fRole">
                O que ele faz <span className="label-opt">(opcional)</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!instructions.trim() || drafting}
                onClick={() => void suggest()}
              >
                {drafting ? "Sugerindo…" : "Sugerir nome e papel"}
              </button>
            </div>
            <textarea
              className="textarea"
              id="fRole"
              rows={3}
              maxLength={4000}
              placeholder="Por exemplo: confere as notas fiscais e atualiza a planilha do financeiro"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            {draftError && <span className="err">{draftError}</span>}
          </div>
          <div className="field">
            <label className="label" htmlFor="fProvider">
              Provedor
            </label>
            <select
              className="input"
              id="fProvider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderId)}
            >
              {PROVIDERS.map((providerId) => (
                <option key={providerId} value={providerId}>
                  {statusProvider(providerId)}
                </option>
              ))}
            </select>
          </div>
          <div className="an-row">
            <span>
              <span className="ap-row-name" id="an-approval-label">
                Pedir aprovação
              </span>
              <span className="field-help" id={approvalHelp}>
                {askApproval
                  ? "Para e pergunta antes de cada ação."
                  : "Age sozinho. Pagamentos, envios e exclusões ainda pedem aprovação."}
              </span>
            </span>
            <Switch
              checked={askApproval}
              onCheckedChange={setAskApproval}
              aria-label="Pedir aprovação"
              aria-describedby={approvalHelp}
            />
          </div>
          {submitError && <p className="err">{submitError}</p>}
        </div>
        <div className="dlg-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => dialogRef.current?.close()}
          >
            Cancelar
          </button>
          <button type="submit" className="btn rn-btn-primary" disabled={busy}>
            Criar agente
          </button>
        </div>
      </form>
    </dialog>
  );
}
