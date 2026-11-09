import { Dialog } from "../ui/Dialog";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} aria-label="Atalhos de teclado" closeButton>
      <div className="dialog-body">
        <h2>Atalhos de teclado</h2>
        <p>Em construção</p>
      </div>
    </Dialog>
  );
}
