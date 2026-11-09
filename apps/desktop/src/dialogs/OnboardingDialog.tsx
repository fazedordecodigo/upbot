import { type KeyboardEvent, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { dayGreeting } from "../lib/greeting";
import { isMac } from "../lib/platform";
import { setThemePreference } from "../lib/theme";
import { useDaemon } from "../shell/daemon";
import { Dialog } from "../ui/Dialog";
import "./OnboardingDialog.css";

const modeLabels = { now: "Executar agora", scheduled: "Agendar", approval: "Pedir aprovação" };
type Mode = keyof typeof modeLabels;
function radioKeys(event: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key))
    return;
  event.preventDefault();
  const radios = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
  );
  const index = radios.indexOf(event.currentTarget);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + radios.length) %
          radios.length;
  radios[next]?.click();
  radios[next]?.focus();
}
export function OnboardingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client, connected } = useDaemon();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [mode, setMode] = useState<Mode>("approval");
  const [privateTask, setPrivateTask] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !connected) return;
    let active = true;
    setStep(1);
    setLoaded(false);
    setError(null);
    void client
      .request("profile.get", {})
      .then((profile) => {
        if (!active) return;
        setName(profile.name);
        setAbout(profile.about);
        setMode(profile.defaults.delegationMode);
        setPrivateTask(profile.defaults.private);
        setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [client, open, connected]);
  const greeting = `${dayGreeting(new Date().getHours())}${name.trim() ? `, ${name.trim()}` : ""}.`;
  const chooseTheme = (value: "dark" | "light") => {
    setTheme(value);
    setThemePreference(value);
  };
  const finish = async () => {
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.request("profile.update", {
        name,
        about,
        theme,
        defaults: {
          private: privateTask,
          delegationMode: mode,
          ...(mode === "approval" ? { requireApproval: true } : {}),
        },
      });
      await client.request("onboarding.complete", {});
      onClose();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!loaded) onClose();
        else void finish();
      }}
      id="onboarding"
      className="onboarding"
      aria-label="Apresentação do Boto"
      aria-busy={busy || !loaded}
    >
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="ob-visual" aria-hidden="true">
        <div className="ob-scene" data-ob-scene="1" hidden={step !== 1}>
          <svg
            className="ob-ripples"
            aria-hidden="true"
            viewBox="0 0 340 300"
            width="340"
            height="300"
          >
            <circle cx="170" cy="128" r="76" />
            <circle cx="170" cy="128" r="106" />
            <circle cx="170" cy="128" r="136" />
            <circle cx="170" cy="128" r="166" />
            <circle cx="170" cy="128" r="196" />
          </svg>
          <img
            className="ob-hero-mark"
            width="120"
            height="120"
            src="/assets/boto-simbolo.svg"
            alt=""
          />
          <p className="ob-equation">
            <span>bot</span>
            <span className="ob-eq-op">+</span>
            <span className="ob-eq-o">o</span>
            <span className="ob-eq-op">=</span>
            <img
              width="72"
              height="24"
              src={`/assets/boto-logo${theme === "light" ? "-claro" : ""}.svg`}
              alt="Boto"
            />
          </p>
        </div>

        <div className="ob-scene" data-ob-scene="2" hidden={step !== 2}>
          <div className="ob-mock ob-memory">
            <div className="ob-mock-head od-row">
              <span className="ob-mock-avatar">
                <img width="15" height="15" src="/assets/boto-simbolo.svg" alt="" />
              </span>
              <div className="od-field od-fill">
                <p className="ob-mock-title">Memória do Boto</p>
                <p className="ob-mock-meta">Usada em todas as sessões</p>
              </div>
            </div>
            <dl className="ob-memory-list">
              <div>
                <dt>Nome</dt>
                <dd id="ob-mem-name">{name}</dd>
              </div>
              <div>
                <dt>Sobre você</dt>
                <dd className="od-clamp-3" id="ob-mem-about">
                  {about}
                </dd>
              </div>
            </dl>
            <div className="ob-memory-greet">
              <p className="ob-memory-greet-sub" id="ob-mem-greet">
                {greeting}
              </p>
              <p className="ob-memory-greet-title">O que eu devo fazer hoje?</p>
            </div>
          </div>
        </div>

        <div className="ob-scene" data-ob-scene="3" hidden={step !== 3}>
          <div className="ob-mock" id="ob-mock"></div>
        </div>

        <div className="ob-scene" data-ob-scene="4" hidden={step !== 4}>
          <div className="ob-mini">
            <img
              className="ob-mini-mark"
              width="48"
              height="48"
              src="/assets/boto-simbolo.svg"
              alt=""
            />
            <p className="ob-mini-sub" id="ob-mini-greeting">
              {greeting}
            </p>
            <p className="ob-mini-title">O que o Boto deve fazer hoje?</p>
            <div className="ob-mini-composer">
              <p className="ob-mini-placeholder">Descreva a tarefa e o resultado esperado</p>
              <div className="ob-mini-bar od-row">
                <span className="badge badge-secondary ob-mini-mode" id="ob-mini-mode">
                  {modeLabels[mode]}
                </span>
                <span
                  className="badge badge-outline ob-mini-mode"
                  id="ob-mini-private"
                  hidden={!privateTask}
                >
                  <svg className="od-icon" aria-hidden="true">
                    <use href="/assets/icons.svg#i-eye-off"></use>
                  </svg>
                  Privada
                </span>
                <span className="od-fill"></span>
                <span className="ob-mini-send">
                  <svg className="od-icon" aria-hidden="true">
                    <use href="/assets/icons.svg#i-arrow-right"></use>
                  </svg>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="ob-panel">
        <div className="ob-head od-row">
          <ol className="ob-progress" aria-label="Passos da apresentação">
            <li>
              <button
                type="button"
                className="ob-dot"
                data-ob-go="1"
                aria-current={step === 1 ? "step" : undefined}
                onClick={() => setStep(1)}
                aria-label="Passo 1: Boas-vindas"
                data-tip="Passo 1: Boas-vindas"
                title="Passo 1: Boas-vindas"
              ></button>
            </li>
            <li>
              <button
                type="button"
                className="ob-dot"
                data-ob-go="2"
                aria-current={step === 2 ? "step" : undefined}
                onClick={() => setStep(2)}
                aria-label="Passo 2: Sobre você"
                data-tip="Passo 2: Sobre você"
                title="Passo 2: Sobre você"
              ></button>
            </li>
            <li>
              <button
                type="button"
                className="ob-dot"
                data-ob-go="3"
                aria-current={step === 3 ? "step" : undefined}
                onClick={() => setStep(3)}
                aria-label="Passo 3: Três jeitos de delegar"
                data-tip="Passo 3: Três jeitos de delegar"
                title="Passo 3: Três jeitos de delegar"
              ></button>
            </li>
            <li>
              <button
                type="button"
                className="ob-dot"
                data-ob-go="4"
                aria-current={step === 4 ? "step" : undefined}
                onClick={() => setStep(4)}
                aria-label="Passo 4: Do seu jeito"
                data-tip="Passo 4: Do seu jeito"
                title="Passo 4: Do seu jeito"
              ></button>
            </li>
          </ol>
          <p className="ob-count od-nowrap" id="ob-count">
            Passo {step} de 4
          </p>
          <span className="od-fill"></span>
          <button
            type="button"
            className="btn btn-ghost btn-sm ob-skip"
            id="ob-skip"
            disabled={!loaded || busy}
            onClick={() => void finish()}
          >
            Pular
          </button>
        </div>
        <p className="sr-only" aria-live="polite" id="ob-live">
          Passo {step} de 4
        </p>

        <div className="ob-content od-scroll">
          <section
            className="ob-step"
            data-ob-step="1"
            hidden={step !== 1}
            aria-labelledby="ob-title-1"
          >
            <div className="ob-intro">
              <p className="ob-eyebrow">Boas-vindas</p>
              <h2 className="ob-title" id="ob-title-1">
                Oi, eu sou o Boto.
              </h2>
              <p className="ob-lead">
                Um colega de trabalho virtual. Trabalho num computador próprio na nuvem e levo a
                tarefa até o fim: pesquiso, escrevo código, preencho planilhas e entrego o
                resultado. O nome vem do boto-cor-de-rosa, o golfinho dos rios da Amazônia, com um
                trocadilho: bot + o.
              </p>
            </div>
            <ul className="ob-points">
              <li>
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-circle-check"></use>
                </svg>{" "}
                <span>
                  Você acompanha cada etapa e a tela do meu computador enquanto eu trabalho.
                </span>
              </li>
              <li>
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-circle-check"></use>
                </svg>{" "}
                <span>
                  Peço sua aprovação antes de ações externas, como enviar e-mail, publicar ou abrir
                  um PR.
                </span>
              </li>
              <li className="ob-point-note">
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-info"></use>
                </svg>{" "}
                <span>Posso errar. Confira as entregas antes de usar.</span>
              </li>
            </ul>
          </section>

          <section
            className="ob-step"
            data-ob-step="2"
            hidden={step !== 2}
            aria-labelledby="ob-title-2"
          >
            <div className="ob-intro">
              <p className="ob-eyebrow">Sobre você</p>
              <h2 className="ob-title" id="ob-title-2">
                Como devo te chamar?
              </h2>
              <p className="ob-lead">
                Não tem cadastro nem conta. O Boto só guarda o que você contar aqui, para
                personalizar as sessões.
              </p>
            </div>
            <div className="field">
              <label className="label" htmlFor="ob-name">
                Como você quer ser chamado
              </label>
              <input
                className="input"
                id="ob-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                type="text"
                maxLength={40}
                autoComplete="nickname"
                placeholder="Por exemplo: Iara"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="ob-about">
                Sobre você <span className="label-opt">(opcional)</span>
              </label>
              <textarea
                className="textarea"
                id="ob-about"
                value={about}
                onChange={(event) => setAbout(event.target.value)}
                rows={4}
                maxLength={600}
                aria-describedby="ob-about-help"
                placeholder="Sou dev front-end, prefiro respostas curtas, trabalho com React"
              ></textarea>
              <p className="field-help od-row" id="ob-about-help">
                <span className="od-fill">
                  Fica na memória do Boto e personaliza as sessões. Dá para editar ou apagar nas
                  Configurações.
                </span>
                <span className="od-nowrap" id="ob-about-count">
                  {about.length}/600
                </span>
              </p>
            </div>
          </section>

          <section
            className="ob-step"
            data-ob-step="3"
            hidden={step !== 3}
            aria-labelledby="ob-title-3"
          >
            <div className="ob-intro">
              <p className="ob-eyebrow">Delegar</p>
              <h2 className="ob-title" id="ob-title-3">
                Três jeitos de delegar
              </h2>
              <p className="ob-lead">
                Escolha como o Boto deve começar as tarefas. As opções ficam logo abaixo da caixa de
                tarefa e mudam quando você quiser.
              </p>
            </div>
            <div
              className="ob-options"
              role="radiogroup"
              aria-label="Jeito de delegar"
              id="ob-modes"
            >
              {/* biome-ignore lint/a11y/useSemanticElements: prototype radio buttons implement roving keyboard selection. */}
              <button
                type="button"
                className="ob-option"
                role="radio"
                aria-checked={mode === "now"}
                data-ob-mode="agora"
                tabIndex={mode === "now" ? 0 : -1}
                onClick={() => setMode("now")}
                onKeyDown={radioKeys}
              >
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-play"></use>
                </svg>
                <span className="od-field od-fill">
                  <span className="ob-option-name">Executar agora</span>
                  <span className="ob-option-desc">
                    Começa assim que você delega e segue até o fim sem parar.
                  </span>
                </span>
                <span className="ob-radio" aria-hidden="true"></span>
              </button>
              {/* biome-ignore lint/a11y/useSemanticElements: prototype radio buttons implement roving keyboard selection. */}
              <button
                type="button"
                className="ob-option"
                role="radio"
                aria-checked={mode === "scheduled"}
                data-ob-mode="agendar"
                tabIndex={mode === "scheduled" ? 0 : -1}
                onClick={() => setMode("scheduled")}
                onKeyDown={radioKeys}
              >
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-calendar"></use>
                </svg>
                <span className="od-field od-fill">
                  <span className="ob-option-name">Agendar</span>
                  <span className="ob-option-desc">
                    Você marca o horário ou a repetição, e o Boto executa sozinho.
                  </span>
                </span>
                <span className="ob-radio" aria-hidden="true"></span>
              </button>
              {/* biome-ignore lint/a11y/useSemanticElements: prototype radio buttons implement roving keyboard selection. */}
              <button
                type="button"
                className="ob-option"
                role="radio"
                aria-checked={mode === "approval"}
                data-ob-mode="aprovacao"
                tabIndex={mode === "approval" ? 0 : -1}
                onClick={() => setMode("approval")}
                onKeyDown={radioKeys}
              >
                <svg className="od-icon" aria-hidden="true">
                  <use href="/assets/icons.svg#i-shield-check"></use>
                </svg>
                <span className="od-field od-fill">
                  <span className="ob-option-name">Pedir aprovação</span>
                  <span className="ob-option-desc">
                    Começa na hora, mas para e pergunta antes de enviar, publicar ou abrir um PR.
                  </span>
                </span>
                <span className="ob-radio" aria-hidden="true"></span>
              </button>
            </div>
            <p className="ob-note">O jeito marcado aqui vira o padrão da caixa de tarefa.</p>
          </section>

          <section
            className="ob-step"
            data-ob-step="4"
            hidden={step !== 4}
            aria-labelledby="ob-title-4"
          >
            <div className="ob-intro">
              <p className="ob-eyebrow">Preferências</p>
              <h2 className="ob-title" id="ob-title-4">
                Do seu jeito
              </h2>
              <p className="ob-lead">
                Ajuste o básico agora. Dá para mudar tudo depois, nas Configurações.
              </p>
            </div>
            <div className="ob-field-group">
              <p className="label" id="ob-theme-label">
                Tema
              </p>
              <div
                className="ob-theme-options"
                role="radiogroup"
                aria-labelledby="ob-theme-label"
                id="ob-themes"
              >
                {/* biome-ignore lint/a11y/useSemanticElements: prototype radio buttons implement roving keyboard selection. */}
                <button
                  type="button"
                  className="ob-option ob-theme-option"
                  role="radio"
                  aria-checked={theme === "dark"}
                  data-ob-theme="dark"
                  tabIndex={theme === "dark" ? 0 : -1}
                  onClick={() => chooseTheme("dark")}
                  onKeyDown={radioKeys}
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
                {/* biome-ignore lint/a11y/useSemanticElements: prototype radio buttons implement roving keyboard selection. */}
                <button
                  type="button"
                  className="ob-option ob-theme-option"
                  role="radio"
                  aria-checked={theme === "light"}
                  data-ob-theme="light"
                  tabIndex={theme === "light" ? 0 : -1}
                  onClick={() => chooseTheme("light")}
                  onKeyDown={radioKeys}
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
            <div className="ob-setting od-row">
              <span className="od-field od-fill">
                <span className="ob-setting-name" id="ob-private-label">
                  Tarefa privada
                </span>
                <span className="ob-setting-help" id="ob-private-help">
                  Nada fica salvo no histórico.
                </span>
              </span>
              <button
                type="button"
                className="switch od-fixed"
                role="switch"
                aria-checked={privateTask}
                onClick={() => setPrivateTask(!privateTask)}
                aria-labelledby="ob-private-label"
                aria-describedby="ob-private-help"
                id="ob-private"
              ></button>
            </div>
            <p className="ob-tip od-row">
              <svg className="od-icon" aria-hidden="true">
                <use href="/assets/icons.svg#i-keyboard"></use>
              </svg>
              <span className="od-fill">Busque tarefas, rotinas e ações a qualquer momento.</span>
              <span className="kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
            </p>
          </section>
        </div>

        <div className="ob-foot">
          <button
            type="button"
            className="btn btn-outline"
            id="ob-back"
            hidden={step === 1}
            disabled={busy}
            onClick={() => setStep(step - 1)}
          >
            Voltar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            id="ob-next"
            disabled={!loaded || busy}
            onClick={() => (step === 4 ? void finish() : setStep(step + 1))}
          >
            <span className="ob-next-label">
              {busy ? "Salvando…" : step === 4 ? "Começar" : "Continuar"}
            </span>
            <svg className="od-icon" aria-hidden="true">
              <use href="/assets/icons.svg#i-arrow-right"></use>
            </svg>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
