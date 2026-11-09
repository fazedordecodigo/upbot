import { Dialog } from "../ui/Dialog";

export function ConfirmDialog({
  name,
  pending,
  onClose,
  onConfirm,
}: {
  name: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      id="confirm"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
    >
      <div className="dialog-body">
        <div className="dialog-header">
          <h2 className="dialog-title" id="confirm-title">
            Excluir a rotina “{name}”?
          </h2>
          <p className="dialog-description" id="confirm-desc">
            A rotina para de rodar e sai da lista. As tarefas que ela já criou continuam no
            histórico.
          </p>
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-outline"
            id="confirm-cancel"
            data-action="close-dialog"
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-destructive"
            id="confirm-ok"
            disabled={pending}
            onClick={onConfirm}
          >
            Excluir rotina
          </button>
        </div>
      </div>
    </Dialog>
  );
}
