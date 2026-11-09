import { createContext, type ReactNode, useContext, useState } from "react";
import { readStorage, writeStorage } from "../lib/storage";
import { useThemePref } from "../lib/theme";
import { Icon } from "../ui/icons";
import { Switch } from "../ui/Switch";

const PrivateContext = createContext({
  privateMode: false,
  setPrivateMode: (_value: boolean) => {},
});
export const usePrivateMode = () => useContext(PrivateContext);
export function PrivateModeProvider({ children }: { children: ReactNode }) {
  const [privateMode, setValue] = useState(() => readStorage("boto.private-task") === "true");
  const setPrivateMode = (value: boolean) => {
    setValue(value);
    writeStorage("boto.private-task", String(value));
  };
  return (
    <PrivateContext.Provider value={{ privateMode, setPrivateMode }}>
      {children}
    </PrivateContext.Provider>
  );
}
export function Topbar({
  collapsed,
  expand,
  openMenu,
}: {
  collapsed: boolean;
  expand: () => void;
  openMenu: () => void;
}) {
  const [, setTheme] = useThemePref();
  const dark = document.documentElement.dataset.theme === "dark";
  const { privateMode, setPrivateMode } = usePrivateMode();
  return (
    <header className="topbar od-row">
      <button
        type="button"
        className="btn btn-ghost btn-icon topbar-menu"
        aria-label="Abrir menu"
        aria-haspopup="dialog"
        data-tip="Abrir menu"
        onClick={openMenu}
      >
        <Icon name="menu" />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon topbar-expand"
        data-tip="Mostrar barra lateral"
        aria-label="Mostrar barra lateral"
        hidden={!collapsed}
        onClick={expand}
      >
        <Icon name="panel-left" />
      </button>
      <span className="od-fill" />
      <div className="private-toggle od-row">
        <span className="private-label" id="private-label">
          Privada
        </span>
        <Switch
          id="private-switch"
          checked={privateMode}
          onCheckedChange={setPrivateMode}
          aria-labelledby="private-label"
          data-tip="Tarefas privadas não ficam no histórico"
        />
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        data-theme-toggle=""
        aria-label="Tema escuro"
        aria-pressed={dark}
        data-tip="Alternar tema"
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        <Icon name={dark ? "moon" : "sun"} />
      </button>
    </header>
  );
}
