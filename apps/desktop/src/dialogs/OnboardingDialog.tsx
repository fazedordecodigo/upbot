import { Dialog } from "../ui/Dialog";

export function OnboardingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} aria-label="Boas-vindas" closeButton>
      <div className="dialog-body">
        <h2>Boas-vindas</h2>
        <p>Em construção</p>
      </div>
    </Dialog>
  );
}
