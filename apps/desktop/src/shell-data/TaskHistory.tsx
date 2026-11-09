import { useEffect, useId, useRef, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { upsertTask } from "../lib/tasks";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { situations, TaskStatus } from "./TaskStatus";

export function TaskHistory({ close }: { close: () => void }) {
  const { client, ready } = useDaemon();
  const { view, params, navigate } = useRouter();
  const id = useId();
  const query = useDaemonQuery(
    client,
    "tasks.list",
    { limit: 200, includePrivate: false },
    { enabled: ready },
  );
  const { setData } = query;
  const [more, setMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const update = (task: import("@boto/protocol").Task) =>
      setData((data) =>
        data
          ? { ...data, items: upsertTask(data.items, task).filter((item) => !item.private) }
          : data,
      );
    const offs = [
      client.on("task.created", update),
      client.on("task.updated", update),
      client.onReconnect(() => {
        generation.current++;
      }),
    ];
    return () => {
      generation.current++;
      for (const off of offs) off();
    };
  }, [client, setData]);
  const loadMore = async () => {
    if (!query.data?.nextCursor || more) return;
    const gen = generation.current;
    setMore(true);
    setPageError(false);
    try {
      const page = await client.request("tasks.list", {
        limit: 200,
        includePrivate: false,
        cursor: query.data.nextCursor,
      });
      if (gen === generation.current)
        setData((data) =>
          data
            ? {
                items: page.items
                  .reduce((items, task) => upsertTask(items, task), data.items)
                  .filter((task) => !task.private),
                nextCursor: page.nextCursor,
              }
            : data,
        );
    } catch {
      if (gen === generation.current) setPageError(true);
    } finally {
      setMore(false);
    }
  };
  return (
    <nav className="sb-history od-scroll" aria-label="Tarefas" data-history="">
      {ready && !query.loaded && !query.error && (
        <p className="sb-history-message">Carregando tarefas…</p>
      )}
      {(query.error || pageError) && (
        <div className="sb-history-message" role="status">
          Não foi possível carregar as tarefas.{" "}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => (pageError ? void loadMore() : query.reload())}
          >
            Tentar de novo
          </button>
        </div>
      )}
      {query.loaded && !query.data?.items.length && (
        <p className="sb-history-message">Nenhuma tarefa ainda.</p>
      )}
      {situations.map(({ tone, label }) => {
        const tasks =
          query.data?.items.filter((task) => !task.private && task.situation === tone) ?? [];
        return tasks.length ? (
          <section className="sb-group" key={tone} aria-labelledby={`${id}-${tone}`}>
            <h2 className="sb-group-title" id={`${id}-${tone}`}>
              {label}
            </h2>
            {tasks.map((task) => (
              <button
                type="button"
                className="sb-item sb-task od-row"
                data-task-id={task.id}
                key={task.id}
                aria-current={view === "task" && params.id === task.id ? "page" : undefined}
                onClick={() => {
                  navigate("task", { id: task.id });
                  close();
                }}
              >
                <TaskStatus situation={task.situation} />
                <span className="od-truncate">{task.title}</span>
              </button>
            ))}
          </section>
        ) : null;
      })}
      {query.data?.nextCursor && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={more}
          onClick={() => void loadMore()}
        >
          Mostrar mais
        </button>
      )}
    </nav>
  );
}
