import type { UiStatus } from "../lib/ui";
import { BotoSimboloCurrentcolorIcon } from "./ds/icons";
import { SituationStatus } from "./SituationStatus";

export function AgentDesk({
  mode,
  machine,
  statusLabel,
  task,
  apps,
  note,
  situation,
  variant = "full",
  onReturn,
}: {
  mode: "boto" | "user";
  machine: string;
  statusLabel: string;
  task: string | null;
  apps: string[];
  note?: string | null;
  situation?: { status: UiStatus; paused: boolean };
  variant?: "full" | "thumb";
  onReturn?: () => void;
}) {
  const title = task || "Sem tarefa no momento";
  return (
    <div className={`agent-desk${variant === "thumb" ? " is-thumb" : ""}`} data-mode={mode}>
      <p className="sr">
        Prévia ilustrada da área de trabalho {machine}. {statusLabel}. {title}. Não é a tela ao vivo
        da máquina.
      </p>
      {mode === "user" && variant === "full" && (
        <div className="desk-banner">
          <span>Você está no controle</span>
          {onReturn && (
            <button type="button" onClick={onReturn}>
              Devolver ao Boto
            </button>
          )}
        </div>
      )}
      <div className="desk-top">
        <span className="od-truncate">{machine}</span>
        {situation ? (
          <SituationStatus status={situation.status} paused={situation.paused} />
        ) : (
          <span>{statusLabel}</span>
        )}
      </div>
      <div className="desk-stage">
        <div className="desk-mark" aria-hidden="true">
          <BotoSimboloCurrentcolorIcon />
        </div>
        <div className="desk-window" aria-hidden="true">
          <div className="desk-window-bar">
            <span className="desk-dots">
              <i />
              <i />
              <i />
            </span>
            <span className="od-truncate">{title}</span>
          </div>
          <p>{title}</p>
        </div>
        {variant === "full" && (
          <div className="desk-dock" aria-hidden="true">
            <span className="desk-dock-mark">
              <BotoSimboloCurrentcolorIcon />
            </span>
            {apps.slice(0, 4).map((app) => (
              <span className="desk-dock-app" key={app} title={app}>
                {app.slice(0, 1).toLocaleUpperCase("pt-BR")}
              </span>
            ))}
          </div>
        )}
      </div>
      {variant === "full" && (
        <p className="desk-note">
          {note ?? "Prévia ilustrada. O Boto não transmite a tela desta máquina."}
        </p>
      )}
    </div>
  );
}
