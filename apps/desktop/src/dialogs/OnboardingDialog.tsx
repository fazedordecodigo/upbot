import { Dialog } from "../ui/Dialog";
import "./OnboardingDialog.css";

export function OnboardingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      id="onboarding"
      className="onboarding"
      aria-label="Apresentação do Boto"
      closeButton
    >
      <div className="ob-content od-scroll">
        <section className="ob-step" data-ob-step="1" aria-labelledby="ob-title-1">
          <div className="ob-intro">
            <p className="ob-eyebrow">Boas-vindas</p>
            <h2 className="ob-title" id="ob-title-1">
              Oi, eu sou o Boto.
            </h2>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
