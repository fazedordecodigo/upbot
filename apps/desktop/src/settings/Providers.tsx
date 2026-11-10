import type { ProviderInfo } from "@boto/protocol";
import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { BlockHead, QueryState } from "./QueryState";

const logos: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  gemini: "gemini",
  opencode: "opencode",
  cursor: "cursor",
  grok: "grok",
  "openai-compatible": "openai",
};
type KeyProvider = Exclude<ProviderInfo["id"], "opencode" | "openai-compatible">;

function KeyRow({ provider, reload }: { provider: ProviderInfo; reload: () => void }) {
  const { client } = useDaemon();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (provider.hasApiKey)
        await client.request("providers.deleteApiKey", { provider: provider.id as KeyProvider });
      else
        await client.request("providers.setApiKey", {
          provider: provider.id as KeyProvider,
          value,
        });
      setValue("");
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
      <div className="od-field od-fill">
        <span className="st-row-name">{provider.name}</span>
        {provider.hasApiKey && <span className="st-row-help mono">{provider.apiKeyMasked}</span>}
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!provider.hasApiKey && (
        <>
          <label className="sr-only" htmlFor={`st-key-${provider.id}`}>
            Chave de API do {provider.name}
          </label>
          <input
            className="input"
            id={`st-key-${provider.id}`}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </>
      )}
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={busy || (!provider.hasApiKey && value.trim().length < 8)}
        onClick={() => void save()}
      >
        {provider.hasApiKey ? "Remover" : "Salvar"}
      </button>
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
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const toast = useToast();
  const providers = query.data ?? [];
  const accounts = providers.filter((p) => p.canLogin);
  const available = providers.filter((p) => p.ready);
  const fail = () => {
    const message = "Não foi possível atualizar o provedor.";
    setError(message);
    toast(message);
  };
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
              try {
                const result = await client.request("providers.scan", {});
                query.setData(result);
                setStatus(
                  `${result.filter((p) => p.installed).length} de ${result.length} CLIs encontradas.`,
                );
              } catch {
                setStatus("Não foi possível procurar as CLIs.");
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
          {status}
        </p>
        <div id="st-clis" aria-busy={!query.loaded && !query.error}>
          <QueryState query={query}>
            {providers.map((p) => (
              <div className="st-row od-row" key={p.id}>
                <span className="st-logo">
                  {logos[p.id] ? (
                    <img src={`/assets/brands/${logos[p.id]}-icon.svg`} alt="" />
                  ) : (
                    <Icon name="cpu" />
                  )}
                </span>
                <div className="od-field od-fill">
                  <span className="st-row-name">{p.name}</span>
                  <span className="st-row-help">
                    {p.installed ? (
                      <>
                        {p.version} <span className="mono">{p.path}</span>
                      </>
                    ) : (
                      <code className="mono">{p.installHint}</code>
                    )}
                  </span>
                </div>
                <span className={`badge ${p.installed ? "badge-success" : "badge-outline"}`}>
                  {p.installed && <Icon name="check" />}
                  {p.installed ? "Instalada" : "Não instalada"}
                </span>
              </div>
            ))}
          </QueryState>
        </div>
      </div>
      <div className="st-block">
        <BlockHead
          title="Entrar com a sua conta"
          description="Use a assinatura que você já tem. O login abre no navegador, e o Boto guarda só o acesso, nunca a sua senha."
        />
        <div className="st-accounts" id="st-accounts" aria-busy={!query.loaded && !query.error}>
          <QueryState query={query}>
            {accounts.length ? (
              accounts.map((p) => (
                <div className="st-row od-row" key={p.id}>
                  <span className="st-row-name od-fill">{p.name}</span>
                  {p.loggedIn !== null && (
                    <span className={p.loggedIn ? "badge badge-success" : "badge badge-outline"}>
                      {p.loggedIn ? "Conectado" : "Não conectado"}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={p.loginRunning || login === p.id}
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
                    {p.loginRunning || login === p.id ? "Aguardando o navegador…" : "Entrar"}
                  </button>
                </div>
              ))
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
        <div id="st-keys" aria-busy={!query.loaded && !query.error}>
          <QueryState query={query}>
            {providers
              .filter((p) => p.id !== "opencode" && p.id !== "openai-compatible")
              .map((p) => (
                <KeyRow key={p.id} provider={p} reload={query.reload} />
              ))}
          </QueryState>
        </div>
      </div>
      <div className="st-block">
        <BlockHead
          title="Provedor padrão"
          id="st-default-title"
          description="O que os bots usam quando você não escolhe outro. Só aparecem os provedores prontos para uso."
        />
        <div id="st-default" aria-busy={!defaultQuery.loaded && !defaultQuery.error}>
          <QueryState query={defaultQuery}>
            {available.length ? (
              <select
                className="input"
                aria-labelledby="st-default-title"
                value={defaultQuery.data?.provider ?? ""}
                onChange={async (event) => {
                  setError("");
                  try {
                    await client.request("providers.setDefault", {
                      provider: event.target.value as ProviderInfo["id"],
                    });
                    defaultQuery.reload();
                  } catch {
                    fail();
                  }
                }}
              >
                <option value="" disabled>
                  Escolha um provedor
                </option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
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
