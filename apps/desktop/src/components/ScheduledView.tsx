import type { Agent } from "@boto/protocol";
import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { Button } from "./ds/controls";
import { RoutineRuns } from "./RoutineRuns";

export function ScheduledView({
  client,
  agents,
  onOpen,
}: {
  client: DaemonClient;
  agents: Agent[];
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const {
    data: routines,
    error,
    reload,
  } = useDaemonQuery(
    client,
    "routines.list",
    {},
    {
      events: { "routine.updated": true, "routine.deleted": true },
    },
  );
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Agendadas</h1>
              <p>Rotinas dos seus bots.</p>
            </div>
          </div>
          {error ? (
            <div role="alert">
              <p>Não foi possível carregar as rotinas: {error}</p>
              <button type="button" className="btn btn-secondary" onClick={() => reload()}>
                Tentar novamente
              </button>
            </div>
          ) : routines === undefined ? (
            <p role="status">Carregando rotinas…</p>
          ) : routines.length === 0 ? (
            <p>Nenhuma rotina ainda. Abra as configurações de um bot para criar uma.</p>
          ) : (
            <ul className="scheduled-list">
              {routines.map((routine) => {
                const bot = agents.find((agent) => agent.id === routine.agentId);
                return (
                  <li key={routine.id}>
                    <button
                      type="button"
                      className="scheduled-row"
                      disabled={!bot}
                      onClick={() => onOpen(routine.agentId)}
                    >
                      <b>{routine.name}</b>
                      <span>
                        {bot?.name ?? "Bot removido"} · {routine.enabled ? "Ativa" : "Desativada"}
                      </span>
                      <small>
                        {routine.schedule ??
                          (routine.webhook ? "Por webhook" : "Sem horário agendado")}
                        {routine.nextRunAt
                          ? ` · Próxima: ${new Date(routine.nextRunAt).toLocaleString("pt-BR")}`
                          : ""}
                      </small>
                    </button>
                    <Button
                      small
                      aria-expanded={expanded.has(routine.id)}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(routine.id)) next.delete(routine.id);
                          else next.add(routine.id);
                          return next;
                        })
                      }
                    >
                      Histórico
                    </Button>
                    {expanded.has(routine.id) && (
                      <RoutineRuns
                        client={client}
                        routineId={routine.id}
                        onOpenChat={bot ? () => onOpen(routine.agentId) : undefined}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
