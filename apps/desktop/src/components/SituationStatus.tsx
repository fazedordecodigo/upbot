import { ST, statusIcon, statusTone, type UiStatus } from "../lib/ui";
import { Icon } from "./icons";

export function SituationStatus({
  status,
  paused = false,
  detail,
}: {
  status: UiStatus;
  paused?: boolean;
  detail?: string | null | undefined;
}) {
  const pausedLabel = paused && status !== "run" && status !== "wait";
  const tone = pausedLabel ? "muted" : statusTone(status);
  const label = pausedLabel ? "Fila pausada" : ST[status];
  return (
    <span className="rn-status" data-tone={tone} title={detail || undefined}>
      <Icon name={statusIcon(status, pausedLabel)} size={13} />
      {label}
    </span>
  );
}
