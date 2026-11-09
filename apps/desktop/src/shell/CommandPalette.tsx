import { useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-BR");
  const results = actions.filter((action) => normalize(action.label).includes(normalize(query)));
  const run = (action: (typeof actions)[number]) => {
    onClose();
    if (action.view) navigate(action.view);
    else openShortcuts();
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
              run(results[active]);
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
        {results.map((action, index) => (
          <button
            type="button"
            className="command-item dropdown-item"
            id={`command-option-${index}`}
            key={action.label}
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            onPointerMove={() => setActive(index)}
            onClick={() => run(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
      <p className="command-empty" id="command-empty" hidden={results.length > 0}>
        Nenhum resultado.
      </p>
    </Dialog>
  );
}
