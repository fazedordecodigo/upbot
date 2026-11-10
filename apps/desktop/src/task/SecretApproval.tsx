import { useId, useRef } from "react";
import type { DaemonClient } from "../lib/daemon";
import { useToast } from "../ui/Toast";

export function SecretApproval({
  client,
  id,
  disabled,
  onBusyChange,
}: {
  client: DaemonClient;
  id: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const inputId = useId();
  const pending = useRef(false);
  const toast = useToast();
  const submit = async (form: HTMLFormElement) => {
    if (pending.current || disabled) return;
    const value = new FormData(form).get("value");
    if (typeof value !== "string" || !value) return;
    pending.current = true;
    onBusyChange(true);
    try {
      await client.request("approvals.respond", { id, decision: "approve", value });
    } catch {
      toast("Não foi possível salvar o segredo. Tente de novo.");
    } finally {
      form.reset();
      pending.current = false;
      onBusyChange(false);
    }
  };
  return (
    <form
      className="od-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
    >
      <label htmlFor={inputId}>Valor secreto</label>
      <input
        className="input"
        id={inputId}
        name="value"
        type="password"
        autoComplete="off"
        required
        disabled={disabled}
      />
      <button type="submit" className="btn btn-primary" disabled={disabled}>
        Aprovar
      </button>
    </form>
  );
}
