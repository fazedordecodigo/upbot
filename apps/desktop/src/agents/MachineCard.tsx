import type { ChatItem, Machine } from "@boto/protocol";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon, type IconName } from "../ui/icons";
import { MachineThumb } from "./AgentParts";

export function MachineCard({
  machine,
  taskTitle,
}: {
  machine: Machine;
  taskTitle: string | null;
}) {
  const { client, connected } = useDaemon();
  const { navigate } = useRouter();
  const taskId = machine.taskId;
  const permissions = useDaemonQuery(
    client,
    "permissions.list",
    { taskId: taskId ?? "" },
    {
      enabled: connected && !!taskId,
      events: { "permission.requested": true, "permission.resolved": true },
    },
  );
  const approvals = useDaemonQuery(
    client,
    "approvals.list",
    { taskId: taskId ?? "" },
    { enabled: connected && !!taskId, events: { "approval.updated": true } },
  );
  const history = useDaemonQuery(
    client,
    "tasks.history",
    { id: taskId ?? "", limit: 500 },
    {
      enabled: connected && !!taskId,
      events: {
        "item.created": (item) => item.kind === "plan" && item.taskId === taskId,
        "item.updated": (item) => item.kind === "plan" && item.taskId === taskId,
      },
    },
  );
  const plan = history.data?.items.findLast(
    (item): item is Extract<ChatItem, { kind: "plan" }> => item.kind === "plan",
  );
  const step = plan?.entries.findIndex((entry) => entry.status !== "completed") ?? -1;
  const approval = approvals.data?.find((entry) => entry.status === "pending");
  const permission = permissions.data?.[0];
  let tone: "run" | "wait" | "muted" | "done" = "muted";
  let icon: IconName = "circle-pause";
  let text = "Desligada";
  let tip: string | undefined;
  if (machine.status === "error") {
    icon = "circle-alert";
    text = "Com erro";
  } else if (approval) {
    tone = "wait";
    icon = "circle-alert";
    text = "Pede aprovação";
    tip = approval.title;
  } else if (permission) {
    tone = "wait";
    icon = "circle-alert";
    text = "Pede permissão";
    tip = permission.title;
  } else if (machine.controller === "user") {
    icon = "user-check";
    text = "Você está no controle";
  } else if (machine.status === "starting") {
    icon = "loader";
    text = "Ligando…";
  } else if (machine.status === "stopped") {
    tone = "done";
    text = "Desligada";
  } else if (!taskId) {
    tone = "done";
    icon = "circle-check";
    text = "Livre";
  } else {
    tone = "run";
    icon = "loader";
    text = plan && step >= 0 ? `Etapa ${step + 1} de ${plan.entries.length}` : "Em execução";
  }
  const body = (
    <>
      <MachineThumb machine={machine} caption={false} />
      <span className="am-name">
        <span className="am-dot" data-tone={tone} aria-hidden="true" />
        <span className="od-truncate">{machine.name}</span>
      </span>
      <span className="am-task od-truncate">{taskTitle ?? "Sem tarefa em andamento"}</span>
      <span className="status" data-tone={tone} title={tip}>
        <Icon name={icon} />
        {text}
      </span>
    </>
  );
  return taskId ? (
    <button type="button" className="am-machine" onClick={() => navigate("task", { id: taskId })}>
      {body}
    </button>
  ) : (
    <div className="am-machine">{body}</div>
  );
}
