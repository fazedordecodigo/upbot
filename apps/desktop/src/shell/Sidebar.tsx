import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useShellProfile } from "../hooks/useShellProfile";
import { openExternalLink } from "../lib/external-link";
import { errorFields, logWarn } from "../lib/log";
import { isMac } from "../lib/platform";
import { useThemePref } from "../lib/theme";
import { TaskHistory } from "../shell-data/TaskHistory";
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "../ui/Dropdown";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { useDaemon } from "./daemon";
import { useRouter, type ViewName } from "./router";

const navigation: { view: ViewName; label: string; icon: IconName; action: string }[] = [
  { view: "home", label: "Início", icon: "home", action: "go-home" },
  { view: "agents", label: "Bots", icon: "users", action: "go-agents" },
  {
    view: "collaboration",
    label: "Colaboração",
    icon: "network",
    action: "go-collaboration",
  },
  { view: "routines", label: "Rotinas", icon: "repeat", action: "go-routines" },
  { view: "templates", label: "Modelos", icon: "layout-template", action: "go-templates" },
  { view: "marketplace", label: "Marketplace", icon: "store", action: "go-marketplace" },
];
export function Sidebar({
  variant,
  collapse,
  close,
  openCommand,
  openShortcuts,
  openOnboarding,
}: {
  variant: "rail" | "sheet";
  collapse: () => void;
  close: () => void;
  openCommand: () => void;
  openShortcuts: () => void;
  openOnboarding: () => void;
}) {
  const { view, navigate } = useRouter();
  const toast = useToast();
  const { client, ready, agents } = useDaemon();
  const profile = useShellProfile();
  const name = profile.data?.name?.trim() || "Você";
  const words = name.split(/\s+/);
  const initials = (
    (words[0]?.[0] ?? "V") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")
  ).toLocaleUpperCase("pt-BR");
  const routines = useDaemonQuery(
    client,
    "routines.list",
    {},
    { enabled: ready, events: { "routine.updated": true, "routine.deleted": true } },
  );
  const [, setTheme] = useThemePref();
  const dark = document.documentElement.dataset.theme === "dark";
  const toggleTheme = () => {
    const theme = dark ? "light" : "dark";
    setTheme(theme);
    void client.request("profile.update", { theme }).catch(() => {});
  };
  const go = (next: ViewName) => {
    close();
    navigate(next);
  };
  return (
    <div className="sb">
      <div className="sb-head od-row">
        <button
          type="button"
          className="sb-brand"
          data-action="go-home"
          aria-label="Boto, ir para o início"
          data-tip="Boto, ir para o início"
          onClick={() => go("home")}
        >
          <img
            className="sb-logo"
            width="88"
            height="28"
            src={dark ? "/assets/boto-logo.svg" : "/assets/boto-logo-claro.svg"}
            alt=""
            data-theme-logo=""
          />
        </button>
        <span className="od-fill" />
        {variant === "rail" ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon sb-collapse"
            data-tip="Recolher barra lateral"
            aria-label="Recolher barra lateral"
            onClick={collapse}
          >
            <Icon name="panel-left" />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-icon sb-close"
            aria-label="Fechar menu"
            data-tip="Fechar menu"
            onClick={close}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className="sb-actions od-stack">
        <button
          type="button"
          className="btn btn-outline sb-new"
          data-action="new-task"
          data-nav="new"
          aria-current={view === "new" ? "page" : undefined}
          onClick={() => go("new")}
        >
          <Icon name="plus" />
          <span className="od-fill">Nova tarefa</span>
        </button>
        {navigation.map((item) => (
          <button
            type="button"
            key={item.view}
            className="sb-item od-row"
            data-action={item.action}
            data-nav={item.view}
            aria-current={view === item.view ? "page" : undefined}
            onClick={() => go(item.view)}
          >
            <Icon name={item.icon} />
            <span className="od-fill">{item.label}</span>
            {item.view === "agents" ? (
              <span className="sb-count" data-agent-count="">
                {ready && agents.length > 0 ? agents.length : ""}
              </span>
            ) : item.view === "routines" ? (
              <span className="sb-count" data-routine-count="">
                {routines.data?.length || ""}
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="sb-item od-row"
          data-action="open-command"
          onClick={openCommand}
        >
          <Icon name="search" />
          <span className="od-fill">Buscar tarefas</span>
          {(variant === "rail" || isMac) && (
            <span className="kbd" data-shortcut-label="">
              {isMac ? "⌘K" : "Ctrl K"}
            </span>
          )}
        </button>
      </div>
      <TaskHistory close={close} />
      <div className="sb-foot">
        <hr className="separator" />
        <div className="sb-foot-row od-row">
          <Dropdown
            label="Conta"
            trigger={
              <button
                type="button"
                className="sb-user od-row od-fill"
                data-menu="user-menu"
                data-menu-align="start"
                aria-label="Menu da conta"
                data-tip="Menu da conta"
              >
                <span className="avatar" aria-hidden="true" data-user-avatar="">
                  {initials}
                </span>
                <span className="sb-user-name od-truncate od-fill" data-user-name="">
                  {name}
                </span>
                <Icon name="chevron-up-down" />
              </button>
            }
          >
            <DropdownLabel>{name}</DropdownLabel>
            <DropdownItem onClick={() => go("settings")}>
              <Icon name="settings" />
              <span className="od-fill">Configurações</span>
            </DropdownItem>
            <DropdownItem
              onClick={() => {
                close();
                navigate("settings", { tab: "memory" });
              }}
            >
              <Icon name="user-check" />
              <span className="od-fill">Você e a memória</span>
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onClick={toggleTheme}>
              <Icon name="sun" />
              <span className="od-fill">Alternar tema</span>
            </DropdownItem>
            <DropdownItem onClick={openShortcuts}>
              <Icon name="keyboard" />
              <span className="od-fill">Atalhos de teclado</span>
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onClick={openOnboarding}>
              <Icon name="info" />
              <span className="od-fill">Conhecer o Boto</span>
            </DropdownItem>
            <DropdownItem
              onClick={() =>
                void openExternalLink(
                  "https://github.com/fazedordecodigo/boto/blob/develop/docs/design/identidade.html",
                ).catch((error: unknown) => {
                  logWarn("brand_guide.open_failed", errorFields(error));
                  toast("Não foi possível abrir o guia da marca. Tente de novo.");
                })
              }
            >
              <Icon name="book-open" />
              <span className="od-fill">Guia da marca</span>
            </DropdownItem>
          </Dropdown>
          <button
            type="button"
            className="btn btn-ghost btn-icon sb-settings"
            data-nav="settings"
            aria-current={view === "settings" ? "page" : undefined}
            data-tip="Configurações"
            aria-label="Configurações"
            onClick={() => go("settings")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>
    </div>
  );
}
