import type { RoutineRun } from "@boto/protocol";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { errorFields, logWarn } from "../lib/log";
import { Button, Tag } from "./ds/controls";
import s from "./RoutineRuns.module.css";

function status(run: RoutineRun) {
  if (run.error) return "Falhou ao enfileirar";
  if (run.turn)
    return {
      running: "Em execução",
      completed: "Concluída",
      failed: "Falhou",
      cancelled: "Cancelada",
      interrupted: "Interrompida",
    }[run.turn.status];
  if (run.queueStatus === "queued") return "Na fila";
  if (run.queueStatus === "removed") return "Removida da fila";
  return "Sem execução registrada";
}

export function RoutineRuns({
  client,
  routineId,
  onOpenChat,
}: {
  client: DaemonClient;
  routineId: string;
  onOpenChat?: (() => void) | undefined;
}) {
  const { data, error, reload } = useDaemonQuery(
    client,
    "routines.runs",
    { id: routineId },
    {
      events: {
        "routine.updated": true,
        "turn.started": true,
        "turn.ended": true,
        "queue.updated": true,
      },
      onError: (e) => logWarn("routines.runs_failed", errorFields(e)),
    },
  );
  const time = (value: number) => new Date(value).toLocaleString("pt-BR");
  if (error)
    return (
      <div role="alert">
        <p>Não foi possível carregar o histórico: {error}</p>
        <Button onClick={reload}>Tentar novamente</Button>
      </div>
    );
  if (!data) return <p role="status">Carregando histórico…</p>;
  if (!data.length) return <p>Nenhuma execução ainda.</p>;
  return (
    <ul className={s.list}>
      {data.map((run) => (
        <li key={run.id} className={s.run}>
          <div className={s.summary}>
            <p>
              {{ schedule: "Agendada", webhook: "Webhook", manual: "Manual" }[run.trigger]} ·{" "}
              <time className={s.meta} dateTime={new Date(run.createdAt).toISOString()}>
                {time(run.createdAt)}
              </time>
            </p>
            <Tag>{status(run)}</Tag>
          </div>
          {run.error && <p>{run.error}</p>}
          {run.turn && (
            <p className={s.meta}>
              Início: {time(run.turn.startedAt)}
              {run.turn.endedAt !== null ? ` · Fim: ${time(run.turn.endedAt)}` : ""}
            </p>
          )}
          {run.turn && onOpenChat && (
            <Button small onClick={onOpenChat}>
              Abrir conversa
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
