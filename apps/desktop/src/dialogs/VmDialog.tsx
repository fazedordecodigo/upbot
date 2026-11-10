import { useEffect, useState } from "react";
import { useMachine } from "../hooks/useMachine";
import { errorFields, logError } from "../lib/log";
import { useDaemon } from "../shell/daemon";
import { LiveDesk, machineStatus } from "../task/LiveDesk";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./VmDialog.css";

export function VmDialog({
  machineId,
  open,
  onClose,
}: {
  machineId: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      className="vm-dialog"
      id="vm-dialog"
      open={open}
      onClose={onClose}
      aria-labelledby="vm-title"
      aria-describedby="vm-sub"
    >
      {open && <VmContent key={machineId} machineId={machineId} onClose={onClose} />}
    </Dialog>
  );
}

function VmContent({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const { client, agents } = useDaemon();
  const session = useMachine(client, machineId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (session.machine?.status !== "ready") return;
    void session.takeover().catch((error: unknown) => {
      logError("vm.takeover_failed", errorFields(error));
      toast("Não foi possível assumir a máquina. Ela pode estar em uso em outra janela.");
    });
  }, [session.machine?.status, session.takeover, toast]);
  const close = async () => {
    setBusy(true);
    try {
      await session.release();
      onClose();
    } catch (error) {
      logError("vm.release_failed", errorFields(error));
      toast("Não foi possível devolver a máquina. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };
  const agent = agents.find((a) => a.id === session.machine?.agentId);
  return (
    <>
      <header className="vm-head od-row">
        <span className="vm-head-icon" aria-hidden="true">
          <Icon name="monitor" />
        </span>
        <div className="od-field od-fill">
          <h2 className="vm-title od-truncate" id="vm-title">
            {session.machine?.name ?? "Máquina"}
          </h2>
          <p className="vm-sub od-truncate" id="vm-sub">
            {agent?.name ?? "Bot"} ·{" "}
            {session.owned
              ? "Usada por você"
              : session.machine
                ? machineStatus[session.machine.status]
                : "Conectando…"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label="Fechar e devolver a máquina"
          data-tip="Fechar e devolver a máquina"
          title="Fechar e devolver a máquina"
          disabled={busy}
          onClick={() => void close()}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="desk" id="vm-desk" data-desk="vm">
        <LiveDesk session={session} available onRelease={() => void close()} />
      </div>
    </>
  );
}
