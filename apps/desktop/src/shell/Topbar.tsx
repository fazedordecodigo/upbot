import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useShellProfile } from "../hooks/useShellProfile";
import { useThemePref } from "../lib/theme";
import { Icon } from "../ui/icons";
import { Switch } from "../ui/Switch";
import { useToast } from "../ui/Toast";
import { useDaemon } from "./daemon";

const PrivateContext = createContext({
  privateMode: false,
  setPrivateMode: (_value: boolean) => {},
});
export const usePrivateMode = () => useContext(PrivateContext);
export function PrivateModeProvider({ children }: { children: ReactNode }) {
  const { client } = useDaemon();
  const profile = useShellProfile();
  const toast = useToast();
  const [privateMode, setValue] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (profile.data?.defaults) setValue(profile.data.defaults.private);
  }, [profile.data]);
  const setPrivateMode = (value: boolean) => {
    const previous = privateMode;
    const current = ++revision.current;
    setValue(value);
    void client.request("profile.update", { defaults: { private: value } }).catch(() => {
      if (current === revision.current) setValue(previous);
      toast("Não foi possível atualizar o modo privado.");
    });
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
  const { client } = useDaemon();
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
        onClick={() => {
          const theme = dark ? "light" : "dark";
          setTheme(theme);
          void client.request("profile.update", { theme }).catch(() => {});
        }}
      >
        <Icon name="moon" />
      </button>
    </header>
  );
}
