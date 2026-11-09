import type { Routine } from "@boto/protocol";
import { useRef, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { ConfirmDialog } from "../routines/ConfirmDialog";
import { formatNextRun, formatSchedule } from "../routines/format";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./RoutinesView.css";

export function RoutinesView() {
  const { client, agents } = useDaemon();
  const { navigate } = useRouter();
  const toast = useToast();
  const query = useDaemonQuery(
    client,
    "routines.list",
    {},
    {
      events: { "routine.updated": true, "routine.deleted": true },
    },
  );
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>());
  async function act(routine: Routine, action: "run" | "toggle" | "delete") {
    if (locks.current.has(routine.id)) return;
    locks.current.add(routine.id);
    setPending(new Set(locks.current));
    try {
      if (action === "run") {
        await client.request("routines.run", { id: routine.id });
        toast("Rotina iniciada");
      } else if (action === "toggle") {
        await client.request("routines.update", { id: routine.id, enabled: !routine.enabled });
      } else {
        await client.request("routines.delete", { id: routine.id });
        setDeleting(null);
        toast("Rotina excluída");
      }
      query.reload();
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      locks.current.delete(routine.id);
      setPending(new Set(locks.current));
    }
  }
  function actionButton(routine: Routine, label: string, icon: IconName, onClick: () => void) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={label}
        data-tip={label}
        title={label}
        disabled={pending.has(routine.id)}
        onClick={onClick}
      >
        <Icon name={icon} />
      </button>
    );
  }
  function content(once: boolean) {
    if (query.error)
      return (
        <p className="rt-empty">
          Não consegui carregar as rotinas. {query.error}{" "}
          <button type="button" className="btn btn-outline btn-sm" onClick={query.reload}>
            Tentar de novo
          </button>
        </p>
      );
    if (!query.loaded) return <p className="rt-empty">Carregando rotinas…</p>;
    const routines = (query.data ?? [])
      .filter((routine) =>
        once
          ? routine.runAt != null
          : routine.runAt == null && (routine.schedule != null || routine.webhook),
      )
      .sort(
        (a, b) =>
          (once ? (a.runAt ?? Infinity) : (a.nextRunAt ?? Infinity)) -
          (once ? (b.runAt ?? Infinity) : (b.nextRunAt ?? Infinity)),
      );
    if (!routines.length)
      return (
        <p className="rt-empty">
          {once
            ? "Nenhuma tarefa agendada. Ao delegar, escolha “Daqui a 1 hora” ou “Amanhã às 8h”."
            : "Nenhuma rotina recorrente. Crie uma em Nova rotina ou escolha “Todo dia às 8h” ao delegar uma tarefa."}
        </p>
      );
    return (
      <ul className="rt-list">
        {routines.map((routine) => (
          <li className="rt-row" key={routine.id}>
            <Icon name={once ? "calendar" : "repeat"} />
            <div className="rt-main">
              <div className="rt-name od-truncate" title={routine.name}>
                {routine.name}
              </div>
              <div className="rt-meta">
                <span className="rt-time">{formatSchedule(routine)}</span>
                <span aria-hidden="true"> · </span>
                <span className="rt-agent">
                  {agents.find((agent) => agent.id === routine.agentId)?.name ?? "a definir"}
                </span>
                {!once && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="rt-time">{formatNextRun(routine)}</span>
                  </>
                )}
              </div>
              <div className="rt-status">
                <span className="status" data-tone={routine.enabled ? "done" : "muted"}>
                  <Icon name={routine.enabled ? "circle-check" : "circle-pause"} />
                  {routine.enabled ? "Ativa" : "Pausada"}
                </span>
                {routine.private && <span className="badge badge-outline">Privada</span>}
              </div>
            </div>
            <div className="rt-actions">
              {actionButton(routine, "Executar agora", "play", () => void act(routine, "run"))}
              {!(once && !routine.enabled && routine.lastRunAt != null) &&
                actionButton(
                  routine,
                  routine.enabled ? "Pausar rotina" : "Retomar rotina",
                  routine.enabled ? "circle-pause" : "play",
                  () => void act(routine, "toggle"),
                )}
              {actionButton(routine, "Excluir rotina", "trash", () => setDeleting(routine))}
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section
      className="view routines od-scroll"
      id="view-routines"
      aria-labelledby="routines-title"
    >
      <div className="page-inner">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="routines-title" tabIndex={-1}>
              Rotinas
            </h1>
            <p className="page-sub">
              Tarefas que o Boto executa sozinho no horário marcado, no computador dele na nuvem.
              Você recebe a entrega quando ficar pronta.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            id="new-routine"
            data-action="new-routine"
            onClick={() => navigate("new", { when: "daily" })}
          >
            <Icon name="plus" />
            Nova rotina
          </button>
        </div>
        <section aria-labelledby="rt-recurring-title" aria-busy={!query.loaded && !query.error}>
          <div className="section-head od-row">
            <h2 className="section-title" id="rt-recurring-title">
              Recorrentes
            </h2>
          </div>
          <div id="rt-recurring">{content(false)}</div>
        </section>
        <section aria-labelledby="rt-once-title" aria-busy={!query.loaded && !query.error}>
          <div className="section-head od-row">
            <h2 className="section-title" id="rt-once-title">
              Agendadas uma vez
            </h2>
          </div>
          <div id="rt-once">{content(true)}</div>
        </section>
      </div>
      {deleting && (
        <ConfirmDialog
          name={deleting.name}
          pending={pending.has(deleting.id)}
          onClose={() => setDeleting(null)}
          onConfirm={() => void act(deleting, "delete")}
        />
      )}
    </section>
  );
}
