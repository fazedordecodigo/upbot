import { useEffect, useRef, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorFields, logWarn } from "../lib/log";
import { readSidebarWidth, setSidebarWidth } from "../lib/sidebar-width";
import { readStorage } from "../lib/storage";
import { setThemePreference, useThemePref } from "../lib/theme";
import { Memories } from "../settings/Memories";
import { Permissions } from "../settings/Permissions";
import { Providers } from "../settings/Providers";
import { QueryState } from "../settings/QueryState";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Dialog } from "../ui/Dialog";
import { Icon, type IconName } from "../ui/icons";
import { Switch } from "../ui/Switch";
import { useToast } from "../ui/Toast";
import "./SettingsView.css";

const tabs: { id: string; label: string; icon: IconName }[] = [
  { id: "provider", label: "Provedor de IA", icon: "cpu" },
  { id: "memory", label: "Você e a memória", icon: "user-check" },
  { id: "appearance", label: "Aparência", icon: "palette" },
  { id: "privacy", label: "Privacidade", icon: "shield-check" },
];
export function SettingsView() {
  const { params } = useRouter();
  const { client, ready } = useDaemon();
  const [tab, setTab] = useState(() =>
    tabs.some((item) => item.id === params.tab) ? params.tab : "provider",
  );
  useEffect(() => {
    if (tabs.some((item) => item.id === params.tab)) setTab(params.tab);
  }, [params.tab]);
  const profile = useDaemonQuery(
    client,
    "profile.get",
    {},
    { enabled: ready, events: { "profile.changed": true } },
  );
  const [draft, setDraft] = useState<{ name: string; about: string } | null>(null);
  const name = draft?.name ?? profile.data?.name ?? "";
  const about = draft?.about ?? profile.data?.about ?? "";
  const dirty = name !== profile.data?.name || about !== profile.data?.about;
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState(false);
  const toast = useToast();
  const [theme] = useThemePref();
  const [width, setWidth] = useState(readSidebarWidth);
  useEffect(() => {
    const update = () => setWidth(readSidebarWidth());
    window.addEventListener("boto:sidebar-width", update);
    return () => window.removeEventListener("boto:sidebar-width", update);
  }, []);
  const widthEdited = useRef(false);
  const changeWidth = (next: number) => {
    widthEdited.current = true;
    setSidebarWidth(next);
  };
  const stored = profile.data;
  useEffect(() => {
    if (!stored) return;
    if (stored.sidebarWidth !== null && readStorage("boto.sidebar-width") === null)
      setSidebarWidth(stored.sidebarWidth);
  }, [stored]);
  useEffect(() => {
    if (!ready || !widthEdited.current) return;
    const timer = setTimeout(() => {
      if (profile.data?.sidebarWidth === width) return;
      void client
        .request("profile.update", { sidebarWidth: width })
        .catch((cause: unknown) => logWarn("settings.sidebar-width", errorFields(cause)));
    }, 350);
    return () => clearTimeout(timer);
  }, [width, client, ready, profile.data?.sidebarWidth]);
  const fail = () => {
    setError("Não foi possível salvar as configurações.");
    toast("Não foi possível salvar as configurações.");
  };
  const saveMemory = async (erase: boolean) => {
    setBusy(true);
    setError("");
    try {
      const result = erase
        ? await client.request("profile.forget", {})
        : await client.request("profile.update", { name, about });
      profile.setData(result);
      setDraft(null);
      setSaved("Salvo.");
      setForget(false);
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };
  const updateDefaults = async (key: "private" | "requireApproval", value: boolean) => {
    setBusy(true);
    setError("");
    const defaults = { ...profile.data?.defaults, [key]: value };
    if (key === "requireApproval" && !value && defaults.delegationMode === "approval")
      defaults.delegationMode = "now";
    try {
      profile.setData(
        await client.request("profile.update", {
          defaults,
        }),
      );
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };
  const changeTheme = (next: "dark" | "light") => {
    setThemePreference(next);
    void client
      .request("profile.update", { theme: next })
      .catch(() => toast("Não foi possível salvar o tema no perfil."));
  };
  return (
    <section className="view st-view od-scroll" id="view-settings" aria-labelledby="settings-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="settings-title" tabIndex={-1}>
              Configurações
            </h1>
            <p className="page-sub">
              Escolha o provedor de IA que os agentes usam e ajuste a memória, a aparência e a
              privacidade. Não tem conta no Boto: tudo fica neste navegador.
            </p>
          </div>
        </div>

        <div className="st-layout">
          <div
            className="st-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Seções das configurações"
            id="st-tabs"
          >
            {tabs.map((item, index) => (
              <button
                type="button"
                className="st-tab od-row"
                role="tab"
                key={item.id}
                id={`st-tab-${item.id}`}
                data-st={item.id}
                aria-controls={`st-${item.id}`}
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 3
                        : ["ArrowDown", "ArrowRight"].includes(event.key)
                          ? (index + 1) % 4
                          : ["ArrowUp", "ArrowLeft"].includes(event.key)
                            ? (index + 3) % 4
                            : null;
                  const nextTab = next === null ? undefined : tabs[next];
                  if (nextTab) {
                    event.preventDefault();
                    setTab(nextTab.id);
                    document.getElementById(`st-tab-${nextTab.id}`)?.focus();
                  }
                }}
              >
                <Icon name={item.icon} />
                <span className="od-fill">{item.label}</span>
              </button>
            ))}
          </div>

          <div className="st-panels">
            <section
              className="st-panel"
              id="st-provider"
              role="tabpanel"
              aria-labelledby="st-tab-provider"
              tabIndex={-1}
              hidden={tab !== "provider"}
            >
              <Providers />
            </section>
            <section
              className="st-panel"
              id="st-memory"
              aria-busy={!profile.loaded && !profile.error}
              role="tabpanel"
              aria-labelledby="st-tab-memory"
              tabIndex={-1}
              hidden={tab !== "memory"}
            >
              <div className="st-block">
                <div className="st-block-head">
                  <div className="od-field od-fill">
                    <h2 className="st-title">Você e a memória</h2>
                    <p className="st-desc">
                      O Boto não tem cadastro. Ele só sabe o que você escreve aqui e usa isso para
                      personalizar as sessões de todos os agentes.
                    </p>
                  </div>
                </div>
                <QueryState query={profile}>
                  <div className="field">
                    <label className="label" htmlFor="st-name">
                      Como você quer ser chamado
                    </label>
                    <input
                      className="input"
                      id="st-name"
                      type="text"
                      maxLength={40}
                      autoComplete="nickname"
                      placeholder="Por exemplo: Iara"
                      disabled={!profile.loaded}
                      value={name}
                      onChange={(event) => {
                        setDraft({ name: event.target.value, about });
                        setSaved("");
                      }}
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="st-about">
                      Sobre você <span className="label-opt">(opcional)</span>
                    </label>
                    <textarea
                      className="textarea"
                      id="st-about"
                      rows={6}
                      maxLength={600}
                      aria-describedby="st-about-help"
                      placeholder="Sou dev front-end, prefiro respostas curtas, trabalho com React"
                      disabled={!profile.loaded}
                      value={about}
                      onChange={(event) => {
                        setDraft({ name, about: event.target.value });
                        setSaved("");
                      }}
                    ></textarea>
                    <p className="field-help od-row" id="st-about-help">
                      <span className="od-fill">
                        Conte sua função, as ferramentas que usa e como prefere receber as entregas.
                      </span>
                      <span className="od-nowrap" id="st-about-count">
                        {about.length}/600
                      </span>
                    </p>
                  </div>
                  <div className="st-actions">
                    <button
                      type="button"
                      className="btn btn-outline st-danger"
                      id="st-forget"
                      disabled={!profile.loaded || busy}
                      onClick={() => setForget(true)}
                    >
                      <Icon name="trash" />
                      Apagar memória
                    </button>
                    <span className="od-fill"></span>
                    <p className="st-saved" id="st-mem-status" aria-live="polite">
                      {saved}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      id="st-mem-save"
                      disabled={!profile.loaded || !dirty || busy}
                      onClick={() => void saveMemory(false)}
                    >
                      Salvar
                    </button>
                  </div>
                </QueryState>
              </div>
              <Memories />
              <div className="st-note">
                <h3 className="st-subtitle">Como o Boto usa a memória</h3>
                <ul className="st-points">
                  <li>
                    <Icon name="check" />
                    <span>O nome aparece na saudação e no menu da conta.</span>
                  </li>
                  <li>
                    <Icon name="check" />
                    <span>
                      O texto entra no contexto de cada tarefa nova. A tela da tarefa mostra o selo
                      “Usando sua memória”.
                    </span>
                  </li>
                  <li>
                    <Icon name="check" />
                    <span>
                      Nada sai deste navegador além do que vai junto com a tarefa para o provedor de
                      IA.
                    </span>
                  </li>
                </ul>
              </div>
            </section>

            <section
              className="st-panel"
              id="st-appearance"
              role="tabpanel"
              aria-labelledby="st-tab-appearance"
              tabIndex={-1}
              hidden={tab !== "appearance"}
            >
              <div className="st-block">
                <div className="st-block-head">
                  <div className="od-field od-fill">
                    <h2 className="st-title" id="st-theme-label">
                      Tema
                    </h2>
                    <p className="st-desc">O tema muda na hora e fica salvo neste navegador.</p>
                  </div>
                </div>
                <div
                  className="ob-theme-options st-themes"
                  role="radiogroup"
                  aria-labelledby="st-theme-label"
                  id="st-themes"
                >
                  {/* biome-ignore lint/a11y/useSemanticElements: the prototype uses button radios with arrow-key focus. */}
                  <button
                    type="button"
                    className="ob-option ob-theme-option"
                    role="radio"
                    aria-checked={theme === "dark"}
                    data-st-theme="dark"
                    tabIndex={theme === "dark" ? 0 : -1}
                    onClick={() => changeTheme("dark")}
                    onKeyDown={(event) => {
                      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        changeTheme("light");
                        document
                          .querySelector<HTMLButtonElement>('[data-st-theme="light"]')
                          ?.focus();
                      }
                    }}
                  >
                    <span className="ob-swatch" data-swatch="dark" aria-hidden="true">
                      <span></span>
                      <span></span>
                    </span>
                    <span className="ob-option-row od-row">
                      <span className="ob-option-name od-fill">Escuro</span>
                      <span className="ob-radio" aria-hidden="true"></span>
                    </span>
                  </button>
                  {/* biome-ignore lint/a11y/useSemanticElements: the prototype uses button radios with arrow-key focus. */}
                  <button
                    type="button"
                    className="ob-option ob-theme-option"
                    role="radio"
                    aria-checked={theme === "light"}
                    data-st-theme="light"
                    tabIndex={theme === "light" ? 0 : -1}
                    onClick={() => changeTheme("light")}
                    onKeyDown={(event) => {
                      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        changeTheme("dark");
                        document
                          .querySelector<HTMLButtonElement>('[data-st-theme="dark"]')
                          ?.focus();
                      }
                    }}
                  >
                    <span className="ob-swatch" data-swatch="light" aria-hidden="true">
                      <span></span>
                      <span></span>
                    </span>
                    <span className="ob-option-row od-row">
                      <span className="ob-option-name od-fill">Claro</span>
                      <span className="ob-radio" aria-hidden="true"></span>
                    </span>
                  </button>
                </div>
              </div>
              <div className="st-block">
                <div className="st-block-head">
                  <div className="od-field od-fill">
                    <h2 className="st-title">
                      <label htmlFor="st-width">Largura da barra lateral</label>
                    </h2>
                    <p className="st-desc" id="st-width-help">
                      Arraste a borda direita da barra ou use este controle. Vale para telas a
                      partir de 1024 px; no celular a barra abre como painel.
                    </p>
                  </div>
                </div>
                <div className="st-range od-row">
                  <input
                    className="st-range-input od-fill"
                    type="range"
                    id="st-width"
                    min="220"
                    max="400"
                    step="4"
                    value={width}
                    onChange={(event) => changeWidth(Number(event.target.value))}
                    aria-describedby="st-width-help"
                  />
                  <output className="st-range-value od-nowrap" id="st-width-out" htmlFor="st-width">
                    {width} px
                  </output>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    id="st-width-reset"
                    onClick={() => changeWidth(272)}
                  >
                    Restaurar
                  </button>
                </div>
              </div>
            </section>

            <section
              className="st-panel"
              id="st-privacy"
              role="tabpanel"
              aria-labelledby="st-tab-privacy"
              tabIndex={-1}
              hidden={tab !== "privacy"}
            >
              <div className="st-block" aria-busy={!profile.loaded && !profile.error}>
                <div className="st-block-head">
                  <div className="od-field od-fill">
                    <h2 className="st-title">Privacidade</h2>
                    <p className="st-desc">
                      Os padrões de cada tarefa nova. Você ainda pode mudar na caixa de tarefa antes
                      de delegar.
                    </p>
                  </div>
                </div>
                <QueryState query={profile}>{null}</QueryState>
                <div className="st-row od-row">
                  <span className="od-field od-fill">
                    <span className="st-row-name" id="st-private-label">
                      Tarefa privada como padrão
                    </span>
                    <span className="st-row-help" id="st-private-help">
                      As tarefas novas não ficam no histórico, na busca nem nas entregas.
                    </span>
                  </span>
                  <Switch
                    id="st-private"
                    aria-labelledby="st-private-label"
                    aria-describedby="st-private-help"
                    checked={profile.data?.defaults.private ?? false}
                    disabled={!profile.loaded || busy}
                    onCheckedChange={(value) => void updateDefaults("private", value)}
                  />
                </div>
                <div className="st-row od-row">
                  <span className="od-field od-fill">
                    <span className="st-row-name" id="st-approval-label">
                      Pedir aprovação antes de ações externas
                    </span>
                    <span className="st-row-help" id="st-approval-help">
                      O agente para e pergunta antes de enviar e-mail, publicar, abrir um PR ou
                      mexer em pagamentos.
                    </span>
                  </span>
                  <Switch
                    id="st-approval"
                    aria-labelledby="st-approval-label"
                    aria-describedby="st-approval-help"
                    checked={profile.data?.defaults.requireApproval ?? false}
                    disabled={!profile.loaded || busy}
                    onCheckedChange={(value) => void updateDefaults("requireApproval", value)}
                  />
                </div>
              </div>
              <div className="st-block">
                <div className="st-block-head">
                  <div className="od-field od-fill">
                    <h2 className="st-title">Permissões das ferramentas</h2>
                    <p className="st-desc">
                      Todos os agentes podem usar as ferramentas do computador e os apps instalados.
                      Na primeira vez que um agente usa uma ferramenta numa sessão, o Boto pede sua
                      permissão. O que você libera em todas as sessões aparece aqui, e dá para
                      revogar.
                    </p>
                  </div>
                </div>
                <Permissions />
              </div>
            </section>
          </div>
        </div>
      </div>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
      <Dialog open={forget} onClose={() => setForget(false)} aria-labelledby="st-forget-title">
        <div className="dialog-header">
          <h2 id="st-forget-title">Apagar memória?</h2>
          <p>
            Seu nome e o texto sobre você serão apagados, assim como o uso deles no histórico das
            tarefas.
          </p>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-outline" onClick={() => setForget(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-destructive"
            disabled={busy}
            onClick={() => void saveMemory(true)}
          >
            Apagar
          </button>
        </div>
      </Dialog>
    </section>
  );
}
