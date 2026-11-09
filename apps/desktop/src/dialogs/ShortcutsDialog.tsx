import { isMac } from "../lib/platform";
import { Dialog } from "../ui/Dialog";
import "./ShortcutsDialog.css";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows = [
    ["Buscar tarefas, rotinas e ações", isMac ? "⌘K" : "Ctrl K"],
    ["Nova tarefa", isMac ? "⇧⌘O" : "Ctrl Shift O"],
    ["Delegar a tarefa ou enviar a instrução", "Enter"],
    ["Quebrar linha", "Shift + Enter"],
    ["Fechar janelas e menus", "Esc"],
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      id="shortcuts"
      aria-labelledby="shortcuts-title"
      closeButton
    >
      <div className="dialog-body">
        <div className="dialog-header">
          <h2 className="dialog-title" id="shortcuts-title">
            Atalhos de teclado
          </h2>
          <p className="dialog-description">Use o Boto sem tirar as mãos do teclado.</p>
        </div>
        <dl className="shortcut-list">
          {rows.map(([label, key]) => (
            <div className="shortcut-row od-row" key={label}>
              <dt className="od-fill">{label}</dt>
              <dd>
                <span className="kbd">{key}</span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="dialog-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Entendi
          </button>
        </div>
      </div>
    </Dialog>
  );
}
