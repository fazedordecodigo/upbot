import type { Task } from "@boto/protocol";
import { Icon, type IconName } from "../ui/icons";
import "./shell-data.css";

export const situations: { tone: Task["situation"]; label: string; icon: IconName }[] = [
  { tone: "run", label: "Em andamento", icon: "loader" },
  { tone: "wait", label: "Aguardando você", icon: "circle-alert" },
  { tone: "muted", label: "Pausadas", icon: "circle-pause" },
  { tone: "done", label: "Concluídas", icon: "circle-check" },
];

export function TaskStatus({ situation }: { situation: Task["situation"] }) {
  const status = situations.find((item) => item.tone === situation);
  if (!status) return null;
  return (
    <span className="status" data-tone={situation}>
      <Icon name={status.icon} />
      <span className="sr-only">{status.label}</span>
    </span>
  );
}
