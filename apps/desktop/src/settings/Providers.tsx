import type {
  ProviderId,
  ProviderInfo,
  ProviderKeyInfo,
  VmCredentialProvider,
} from "@boto/protocol";
import { useEffect, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useDaemon } from "../shell/daemon";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { BlockHead, QueryState } from "./QueryState";

const logos: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  gemini: "gemini",
  opencode: "opencode",
  cursor: "cursor",
  grok: "grok",
  openrouter: "openrouter",
};
const logoIcons: Record<string, IconName> = { aider: "terminal" };

function ProviderLogo({ id }: { id: string }) {
  return (
    <span className="st-logo">
      {logos[id] ? (
        <img src={`/assets/brands/${logos[id]}-icon.svg`} alt="" />
      ) : (
        <Icon name={logoIcons[id] ?? "cpu"} />
      )}
    </span>
  );
}

const ACCOUNT_META: Record<string, { name: string; description: string }> = {
  codex: {
    name: "ChatGPT",
    description: "Use a assinatura do ChatGPT nos agentes, pelo Codex.",
  },
  claude: {
    name: "Claude",
    description: "Use a assinatura do Claude nos agentes, pelo Claude Code.",
  },
  grok: { name: "Grok", description: "Use a sua conta do Grok nos agentes." },
};
const ACCOUNT_ORDER = ["codex", "claude", "grok"];

const KEY_ROWS: { provider: VmCredentialProvider; name: string; logo?: string }[] = [
  { provider: "codex", name: "OpenAI", logo: "openai" },
  { provider: "claude", name: "Anthropic", logo: "anthropic" },
  { provider: "grok", name: "xAI", logo: "grok" },
  { provider: "gemini", name: "Google Gemini", logo: "gemini" },
  { provider: "cursor", name: "Cursor", logo: "cursor" },
  { provider: "devin", name: "Devin" },
  { provider: "openrouter", name: "OpenRouter", logo: "openrouter" },
];

function relTime(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "agora";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

function KeyRow({
  name,
  logo,
  info,
  reload,
}: {
  name: string;
  logo?: string;
  info: ProviderKeyInfo;
  reload: () => void;
}) {
  const { client } = useDaemon();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (remove) await client.request("providers.deleteApiKey", { provider: info.provider });
      else await client.request("providers.setApiKey", { provider: info.provider, value });
      setValue("");
      setOpen(false);
      reload();
    } catch {
      const message = "Não foi possível atualizar a chave de API.";
      setError(message);
      toast(message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-row od-row" aria-busy={busy}>
      <span className="st-logo">
        {logo ? <img src={`/assets/brands/${logo}-icon.svg`} alt="" /> : <Icon name="cpu" />}
      </span>
      <div className="od-field od-fill">
        <span className="st-row-name">{name}</span>
        <span className="st-row-help">
          {info.hasApiKey ? <span className="mono">{info.apiKeyMasked}</span> : "Sem chave"}
        </span>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {open ? (
        <>
          <label className="sr-only" htmlFor={`st-key-${info.provider}`}>
            Chave de API do {name}
          </label>
          <input
            className="input st-key-input"
            id={`st-key-${info.provider}`}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || value.trim().length < 8}
            onClick={() => void save(false)}
          >
            Salvar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setValue("");
              setError("");
            }}
          >
            Cancelar
          </button>
        </>
      ) : info.hasApiKey ? (
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() => void save(true)}
        >
          Remover
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          <Icon name="plus" />
          Adicionar chave
        </button>
      )}
    </div>
  );
}

function EndpointRow({ info, reload }: { info: ProviderKeyInfo; reload: () => void }) {
  const { client } = useDaemon();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const configured = info.endpoint !== "";
  const save = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (remove) await client.request("providers.deleteApiKey", { provider: "openai-compatible" });
      else
        await client.request("providers.setEndpoint", {
          url,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        });
      setKey("");
      setOpen(false);
      reload();
    } catch {
      const message = "Não foi possível atualizar o endpoint.";
      setError(message);
      toast(message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-row od-row" aria-busy={busy}>
      <span className="st-logo">
        <Icon name="terminal" />
      </span>
      <div className="od-field od-fill">
        <span>
          <span className="st-row-name">Endpoint compatível</span>{" "}
          <span className="st-vendor">(no formato da API da OpenAI)</span>
        </span>
        <span className="st-row-help">
          {configured ? (
            <>
              {info.endpoint} <span className="mono">{info.apiKeyMasked}</span>
            </>
          ) : (
            "Não configurado. Para servidores locais ou do seu time."
          )}
        </span>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {open ? (
        <>
          <label className="sr-only" htmlFor="st-endpoint-url">
            URL do endpoint compatível
          </label>
          <input
            className="input st-endpoint-url"
            id="st-endpoint-url"
            type="url"
            autoComplete="off"
            placeholder="http://localhost:11434/v1"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <label className="sr-only" htmlFor="st-key-openai-compatible">
            Chave de API do endpoint (opcional)
          </label>
          <input
            className="input st-key-input"
            id="st-key-openai-compatible"
            type="password"
            autoComplete="off"
            placeholder={
              info.hasApiKey ? "Deixe vazio para manter a chave" : "Chave de API (opcional)"
            }
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || url.trim().length < 8}
            onClick={() => void save(false)}
          >
            Salvar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setKey("");
              setError("");
            }}
          >
            Cancelar
          </button>
        </>
      ) : (
        <>
          {configured && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={busy}
              onClick={() => {
                setUrl(info.endpoint ?? "");
                setOpen(true);
              }}
            >
              Editar
            </button>
          )}
          {configured ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Remover
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              <Icon name="plus" />
              Configurar
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function Providers() {
  const { client, ready } = useDaemon();
  const query = useDaemonQuery(
    client,
    "providers.list",
    {},
    { enabled: ready, events: { "providers.changed": true } },
  );
  const defaultQuery = useDaemonQuery(
    client,
    "providers.getDefault",
    {},
    { enabled: ready, events: { "providers.changed": true } },
  );
  const keyQuery = useDaemonQuery(
    client,
    "providers.listApiKeys",
    {},
    { enabled: ready, events: { "providers.changed": true } },
  );
  const [scanning, setScanning] = useState(false);
  const [scanAt, setScanAt] = useState<number | null>(null);
  const [scanError, setScanError] = useState("");
  const [error, setError] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const toast = useToast();
  const providers = query.data ?? [];
  const installed = providers.filter((p) => p.installed);
  const missing = providers.filter((p) => !p.installed);
  const accounts = providers
    .filter((p) => p.canLogin)
    .sort(
      (a, b) =>
        (ACCOUNT_ORDER.indexOf(a.id) === -1 ? ACCOUNT_ORDER.length : ACCOUNT_ORDER.indexOf(a.id)) -
        (ACCOUNT_ORDER.indexOf(b.id) === -1 ? ACCOUNT_ORDER.length : ACCOUNT_ORDER.indexOf(b.id)),
    );
  const available = providers.filter((p) => p.ready);
  const defaultProvider = defaultQuery.data?.provider ?? null;
  const keys = keyQuery.data ?? [];
  const keyInfo = (provider: VmCredentialProvider) =>
    keys.find((k) => k.provider === provider) ??
    ({ provider, hasApiKey: false, apiKeyMasked: null, endpoint: null } as ProviderKeyInfo);
  useEffect(() => {
    if (query.loaded && scanAt === null) setScanAt(Date.now());
  }, [query.loaded, scanAt]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const fail = () => {
    const message = "Não foi possível atualizar o provedor.";
    setError(message);
    toast(message);
  };
  const makeDefault = async (provider: ProviderId) => {
    setError("");
    try {
      await client.request("providers.setDefault", { provider });
      defaultQuery.reload();
    } catch {
      fail();
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Comando copiado.");
    } catch {
      toast("Não foi possível copiar o comando.");
    }
  };
  const install = async (provider: ProviderInfo) => {
    setError("");
    try {
      await client.request("providers.install", { provider: provider.id });
      query.reload();
    } catch {
      toast("Não foi possível instalar esta CLI.");
    }
  };
  const cliRow = (p: ProviderInfo) => (
    <div className="st-row od-row" key={p.id} aria-busy={p.installRunning}>
      <ProviderLogo id={p.id} />
      <div className="od-field od-fill">
        <span>
          <span className="st-row-name">{p.name}</span>{" "}
          <span className="st-vendor">{p.vendor}</span>
        </span>
        <span className="st-row-help">
          {p.installed ? (
            <span className="st-installed">
              <Icon name="check" />
              Instalada <span className="mono">{p.path}</span>
            </span>
          ) : (
            <span className="st-install-hint">
              <code className="mono">{p.installHint}</code>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm st-copy"
                title="Copiar comando"
                aria-label={`Copiar comando de instalação do ${p.name}`}
                onClick={() => void copy(p.installHint)}
              >
                <Icon name="copy" />
              </button>
            </span>
          )}
        </span>
        {p.installError && (
          <p className="st-error" role="alert">
            Não foi possível instalar. Rode o comando acima no terminal.
          </p>
        )}
      </div>
      {p.installed ? (
        p.id === defaultProvider ? (
          <span className="st-tag" aria-current="true">
            Padrão
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!p.ready}
            title={
              p.ready
                ? undefined
                : "Entre na conta ou salve uma chave de API para usar este provedor."
            }
            onClick={() => void makeDefault(p.id)}
          >
            Tornar padrão
          </button>
        )
      ) : (
        !/^https?:\/\//i.test(p.installHint.trim()) && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={p.installRunning}
            onClick={() => void install(p)}
          >
            <Icon
              name={p.installRunning ? "loader" : "download"}
              className={p.installRunning ? "st-spin" : ""}
            />
            {p.installRunning ? "Instalando…" : "Instalar"}
          </button>
        )
      )}
    </div>
  );
  return (
    <>
      <div className="st-block">
        <BlockHead
          title="CLIs nesta máquina"
          id="st-clis-title"
          description="Ferramentas de linha de comando dos provedores de IA. O Boto usa as que estão instaladas e mostra como instalar as outras que ele suporta."
        >
          <button
            type="button"
            className="btn btn-outline btn-sm od-fixed"
            id="st-scan"
            disabled={scanning || !ready}
            aria-busy={scanning}
            onClick={async () => {
              setScanning(true);
              setScanError("");
              try {
                const result = await client.request("providers.scan", {});
                query.setData(result);
                setScanAt(Date.now());
              } catch {
                setScanError("Não foi possível procurar as CLIs.");
              } finally {
                setScanning(false);
              }
            }}
          >
            <Icon name="refresh-cw" />
            <span id="st-scan-label">{scanning ? "Procurando…" : "Procurar de novo"}</span>
          </button>
        </BlockHead>
        <p className="st-scan-status" id="st-scan-status" aria-live="polite">
          {scanError || (scanAt ? `Última busca: ${relTime(scanAt)}.` : "")}
        </p>
        <div id="st-clis" aria-busy={!query.loaded && !query.error}>
          <QueryState query={query}>
            {installed.length > 0 && (
              <>
                <p className="st-group">
                  Instalados <span className="st-group-count">{installed.length}</span>
                </p>
                <div className="st-listbox">{installed.map(cliRow)}</div>
              </>
            )}
            {missing.length > 0 && (
              <>
                <p className="st-group">
                  Suportadas, ainda não instaladas{" "}
                  <span className="st-group-count">{missing.length}</span>
                </p>
                <div className="st-listbox">{missing.map(cliRow)}</div>
              </>
            )}
          </QueryState>
        </div>
      </div>
      <div className="st-block">
        <BlockHead
          title="Entrar com a sua conta"
          description="Use a assinatura que você já tem. O login abre no navegador, e o Boto guarda só o acesso, nunca a sua senha."
        />
        <div className="st-account-grid" id="st-accounts" aria-busy={!query.loaded && !query.error}>
          <QueryState query={query}>
            {accounts.length ? (
              accounts.map((p) => {
                const meta = ACCOUNT_META[p.id] ?? {
                  name: p.name,
                  description: `Use a sua conta do ${p.name} nos agentes.`,
                };
                const waiting = p.loginRunning || login === p.id;
                return (
                  <div className="st-account-card" key={p.id}>
                    <div className="st-account-head">
                      <ProviderLogo id={p.id} />
                      {p.loggedIn === true && (
                        <span className="badge badge-success">
                          <Icon name="check" />
                          Conectado
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="st-account-name">{meta.name}</p>
                      <p className="st-account-desc">{p.vendor}</p>
                    </div>
                    <p className="st-account-desc">{meta.description}</p>
                    <button
                      type="button"
                      className="btn btn-outline st-account-btn"
                      disabled={waiting}
                      onClick={async () => {
                        setLogin(p.id);
                        setError("");
                        try {
                          await client.request("providers.login", { provider: p.id });
                          query.reload();
                        } catch {
                          fail();
                        } finally {
                          setLogin(null);
                        }
                      }}
                    >
                      <Icon
                        name={waiting ? "loader" : "arrow-up-right"}
                        className={waiting ? "st-spin" : ""}
                      />
                      {waiting ? "Aguardando o navegador…" : `Entrar com ${meta.name}`}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="st-empty">Nenhuma CLI instalada aceita login com conta.</p>
            )}
          </QueryState>
        </div>
      </div>
      <div className="st-block">
        <BlockHead
          title="Chaves de API"
          description="Para cobrar direto na sua conta do provedor. A chave fica só neste navegador e aparece mascarada depois de salva."
        />
        <div id="st-keys" aria-busy={!keyQuery.loaded && !keyQuery.error}>
          <QueryState query={keyQuery}>
            <div className="st-listbox">
              {KEY_ROWS.map((row) => (
                <KeyRow
                  key={row.provider}
                  name={row.name}
                  logo={row.logo ?? ""}
                  info={keyInfo(row.provider)}
                  reload={keyQuery.reload}
                />
              ))}
              <EndpointRow info={keyInfo("openai-compatible")} reload={keyQuery.reload} />
            </div>
          </QueryState>
        </div>
      </div>
      <div className="st-block">
        <BlockHead
          title="Provedor padrão"
          id="st-default-title"
          description="O que os agentes usam quando você não escolhe outro. Só aparecem os provedores prontos para uso."
        />
        <div id="st-default" aria-busy={!defaultQuery.loaded && !defaultQuery.error}>
          <QueryState query={defaultQuery}>
            {available.length ? (
              <div className="st-default-grid" role="radiogroup" aria-labelledby="st-default-title">
                {available.map((p, index) => (
                  // biome-ignore lint/a11y/useSemanticElements: button radios support arrow-key focus like the theme picker.
                  <button
                    type="button"
                    className="ob-option"
                    role="radio"
                    aria-checked={defaultProvider === p.id}
                    key={p.id}
                    data-provider={p.id}
                    tabIndex={
                      defaultProvider === p.id || (defaultProvider === null && index === 0) ? 0 : -1
                    }
                    onClick={() => void makeDefault(p.id)}
                    onKeyDown={(event) => {
                      const last = available.length - 1;
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? last
                            : ["ArrowRight", "ArrowDown"].includes(event.key)
                              ? (index + 1) % available.length
                              : ["ArrowLeft", "ArrowUp"].includes(event.key)
                                ? (index + last) % available.length
                                : null;
                      if (next === null) return;
                      event.preventDefault();
                      document
                        .querySelector<HTMLButtonElement>(
                          `#st-default [data-provider="${available[next]?.id}"]`,
                        )
                        ?.focus();
                      const provider = available[next];
                      if (provider) void makeDefault(provider.id);
                    }}
                  >
                    <ProviderLogo id={p.id} />
                    <span className="od-field od-fill">
                      <span className="ob-option-name">{p.name}</span>
                      <span className="st-row-help">CLI nesta máquina</span>
                    </span>
                    <span className="ob-radio" aria-hidden="true"></span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="st-empty">
                Nenhum provedor pronto. Instale uma CLI e entre com a conta ou salve uma chave de
                API.
              </p>
            )}
          </QueryState>
        </div>
      </div>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
