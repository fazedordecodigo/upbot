import type { Agent, AgentOverview, Machine } from "@boto/protocol";
import { useEffect, useState } from "react";
import { DesktopClient, frameDataUrl } from "../lib/desktop";
import { mono } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon } from "../ui/icons";
import { agentStatus, relativeTime } from "./helpers";

export function AgentHeading({
  agent,
  overview,
  panel = false,
}: {
  agent: Agent;
  overview: AgentOverview;
  panel?: boolean;
}) {
  const status = agentStatus(overview);
  return (
    <>
      <div className="od-row">
        <span className="avatar">
          {agent.avatar && "emoji" in agent.avatar ? (
            agent.avatar.emoji
          ) : agent.avatar && "icon" in agent.avatar ? (
            <Icon
              name={
                (
                  {
                    sym: "monitor",
                    mail: "mail",
                    receipt: "file-text",
                    plane: "globe",
                    chart: "list-checks",
                    cal: "calendar",
                    sheet: "file-text",
                  } as const
                )[agent.avatar.icon]
              }
            />
          ) : (
            mono(agent.name)
          )}
        </span>
        <div className="od-fill">
          {panel ? (
            <h2 id="ap-title">{agent.name}</h2>
          ) : (
            <h3 className="ag-card-title od-truncate">{agent.name}</h3>
          )}
          <p className="ag-card-role od-clamp-2">{agent.role || "Sem descrição"}</p>
        </div>
      </div>
      <span
        className="status"
        data-tone={status.tone}
        title={overview.error ?? undefined}
        aria-description={overview.error ?? undefined}
      >
        <Icon name={status.icon} />
        {status.text}
      </span>
    </>
  );
}

export function TaskRows({ overview }: { overview: AgentOverview }) {
  const { navigate } = useRouter();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  const rows = [
    ...overview.waiting.map((task) => ({ task, wait: true })),
    ...overview.running.map((task) => ({ task, wait: false })),
  ];
  if (!rows.length) return <p className="ag-empty">Nenhuma tarefa em execução.</p>;
  return (
    <ul className="ag-tasks">
      {rows.map(({ task, wait }) => (
        <li key={task.id}>
          <span className="status" data-tone={wait ? "wait" : "run"}>
            <Icon name={wait ? "circle-alert" : "loader"} />
            <span className="sr-only">{wait ? "Aguardando você" : "Trabalhando"}</span>
          </span>
          {task.taskId ? (
            <button
              type="button"
              className="ag-task-link od-truncate od-fill"
              onClick={() => navigate("task", { id: task.taskId as string })}
            >
              {task.title}
            </button>
          ) : (
            <span className="od-truncate od-fill">{task.title}</span>
          )}
          <time className="ag-time" dateTime={new Date(task.since).toISOString()}>
            {relativeTime(task.since)}
          </time>
        </li>
      ))}
    </ul>
  );
}

export function MachineThumb({ machine }: { machine: Machine }) {
  const { client } = useDaemon();
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSrc(undefined);
    if (machine.status !== "ready") return;
    const desktop = new DesktopClient(client);
    const load = () => {
      void desktop
        .thumbnail(machine.id)
        .then((frame) => {
          if (live) setSrc(frameDataUrl(frame));
        })
        .catch(() => {
          if (live) setSrc(undefined);
        })
        .finally(() => {
          if (live) timer = setTimeout(load, 10000);
        });
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, machine.id, machine.status]);
  return (
    <figure className="ag-thumb">
      {src ? (
        <img
          className="od-media"
          src={src}
          onError={() => setSrc(undefined)}
          alt={`Tela da máquina ${machine.name}`}
        />
      ) : (
        <div className="ag-thumb-placeholder">
          <Icon name="monitor" />
        </div>
      )}
      <figcaption>
        <span className="od-truncate">{machine.name}</span>
        <span>
          {
            { starting: "Ligando", ready: "Pronta", stopped: "Desligada", error: "Com erro" }[
              machine.status
            ]
          }
        </span>
      </figcaption>
    </figure>
  );
}
