import type { Task } from "@boto/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { upsertTask } from "../lib/tasks";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { ContextMenu, ContextMenuItem } from "../ui/ContextMenu";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { situations, TaskStatus } from "./TaskStatus";

export function TaskHistory({ close }: { close: () => void }) {
  const { client, ready } = useDaemon();
  const { view, params, navigate } = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
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
  const [menu, setMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const update = (task: Task) =>
      setData((data) =>
        data
          ? { ...data, items: upsertTask(data.items, task).filter((item) => !item.private) }
          : data,
      );
    const offs = [
      client.on("task.created", update),
      client.on("task.updated", update),
      client.on("task.deleted", ({ id: deleted }) =>
        setData((data) =>
          data ? { ...data, items: data.items.filter((item) => item.id !== deleted) } : data,
        ),
      ),
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
  const copyId = async (taskId: string) => {
    try {
      await navigator.clipboard.writeText(taskId);
      toast("ID copiado.");
    } catch {
      toast("Não foi possível copiar o ID.");
    }
  };
  const remove = async (task: Task) => {
    try {
      const confirmed = await confirm({
        title: `Excluir ${task.title}?`,
        description:
          "A tarefa sai do histórico com toda a conversa. Os arquivos que ela criou ficam no computador.",
        action: "Excluir tarefa",
      });
      if (!confirmed) return;
      await client.request("tasks.delete", { id: task.id });
      toast("Tarefa excluída.");
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const openMenu = (task: Task, x: number, y: number) => setMenu({ x, y, task });
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(task, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(task, rect.left, rect.bottom);
                  }
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Ações de ${menu.task.title}`}
          close={() => setMenu(null)}
        >
          <ContextMenuItem onClick={() => void copyId(menu.task.id)}>
            <Icon name="copy" />
            <span className="od-fill">Copiar ID</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void remove(menu.task)}>
            <Icon name="trash" />
            <span className="od-fill">Excluir tarefa</span>
          </ContextMenuItem>
        </ContextMenu>
      )}
    </nav>
  );
}
