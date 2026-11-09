import type { MethodResult, Task } from "@boto/protocol";
import { useEffect, useState } from "react";
import { useThemePref } from "../lib/theme";
import { TaskStatus } from "../shell-data/TaskStatus";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
import { useDaemon } from "./daemon";
import { useRouter, type ViewName } from "./router";
import "./CommandPalette.css";

const actions: { label: string; view?: ViewName }[] = [
  { label: "Nova tarefa", view: "new" },
  { label: "Início", view: "home" },
  { label: "Agentes", view: "agents" },
  { label: "Rotinas", view: "routines" },
  { label: "Modelos", view: "templates" },
  { label: "Marketplace", view: "marketplace" },
  { label: "Configurações", view: "settings" },
  { label: "Alternar tema" },
  { label: "Atalhos de teclado" },
];
export function CommandPalette({
  open,
  onClose,
  openShortcuts,
}: {
  open: boolean;
  onClose: () => void;
  openShortcuts: () => void;
}) {
  const { navigate } = useRouter();
  const { client } = useDaemon();
  const [, setTheme] = useThemePref();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [search, setSearch] = useState<MethodResult<"tasks.search">>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
      return;
    }
    const text = query.trim();
    setSearch(undefined);
    setError(false);
    setLoading(Boolean(text));
    if (!text) return;
    let stale = false;
    const timer = setTimeout(() => {
      void client
        .request("tasks.search", { query: text.slice(0, 200), limit: 20 })
        .then((result) => {
          if (!stale) {
            setSearch(result);
            setLoading(false);
            setActive(0);
          }
        })
        .catch(() => {
          if (!stale) {
            setError(true);
            setLoading(false);
          }
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [client, open, query]);
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-BR");
  const groups: {
    label: string;
    items: { label: string; task: Task | undefined; run: () => void }[];
  }[] = [
    {
      label: "Tarefas",
      items: (search?.tasks ?? []).map((task) => ({
        label: task.title,
        task,
        run: () => navigate("task", { id: task.id }),
      })),
    },
    {
      label: "Rotinas",
      items: (search?.routines ?? []).map((routine) => ({
        label: routine.name,
        task: undefined,
        run: () => navigate("routines", { id: routine.id }),
      })),
    },
    {
      label: "Ações",
      items: actions
        .filter((action) => normalize(action.label).includes(normalize(query.trim())))
        .map((action) => ({ label: action.label, task: undefined, run: () => run(action) })),
    },
  ];
  const results = groups.flatMap((group) => group.items);
  const run = (action: (typeof actions)[number]) => {
    onClose();
    if (action.view) navigate(action.view);
    else if (action.label === "Alternar tema") {
      const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      setTheme(theme);
      void client.request("profile.update", { theme }).catch(() => {});
    } else openShortcuts();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="command"
      id="command"
      aria-label="Buscar tarefas, rotinas e ações"
    >
      <div className="command-search od-row">
        <Icon name="search" />
        <input
          autoComplete="off"
          className="command-input od-fill"
          id="command-input"
          type="text"
          placeholder="Buscar tarefas, rotinas e ações"
          aria-label="Buscar tarefas, rotinas e ações"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? `command-option-${active}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) =>
                results.length
                  ? (value + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length
                  : 0,
              );
            }
            if (event.key === "Enter" && results[active]) {
              event.preventDefault();
              onClose();
              results[active].run();
            }
          }}
        />
        <span className="kbd">Esc</span>
      </div>
      <div
        className="command-list od-scroll"
        id="command-list"
        role="listbox"
        aria-label="Resultados"
      >
        {groups
          .filter((group) => group.items.length)
          .map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: listbox groups are not form fieldsets.
            <div role="group" aria-label={group.label} key={group.label}>
              <div className="dropdown-label" role="presentation">
                {group.label}
              </div>
              {group.items.map((action) => {
                const index = results.indexOf(action);
                return (
                  <button
                    type="button"
                    className="command-item dropdown-item"
                    id={`command-option-${index}`}
                    key={action.task?.id ?? `${group.label}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onPointerMove={() => setActive(index)}
                    onClick={() => {
                      onClose();
                      action.run();
                    }}
                  >
                    {action.task && <TaskStatus situation={action.task.situation} />}
                    {action.label}
                  </button>
                );
              })}
            </div>
          ))}
      </div>
      <p
        className="command-empty"
        id="command-empty"
        role="status"
        hidden={!loading && !error && results.length > 0}
      >
        {loading
          ? "Buscando…"
          : error
            ? "Não foi possível buscar."
            : `Nenhum resultado para “${query.trim()}”.`}
      </p>
    </Dialog>
  );
}
