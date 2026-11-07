import type { Agent, Gateway, GatewayKind, MarketplaceItem, ProviderId } from "@boto/protocol";
import { useEffect, useId, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { errorFields, type LogFields, logWarn } from "../lib/log";
import { PROVIDERS } from "./AgentSettings";
import { Button, Field, Select, Switch, Tag } from "./ds/controls";
import styles from "./Library.module.css";
import { Markdown } from "./Markdown";

export function SkillsView({ client }: { client: DaemonClient }) {
  const [edit, setEdit] = useState<{ name: string; description: string; body: string } | null>(
    null,
  );
  const { data: skills = [], error: loadError } = useDaemonQuery(
    client,
    "skills.list",
    {},
    {
      events: { "skills.changed": true },
      onError: (e) => logWarn("skills.list_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };

  if (edit) {
    return (
      <form
        className={styles.page}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("skills.save", edit)
            .then(() => setEdit(null))
            .catch(fail("skills.save_failed"));
        }}
      >
        <h2 className={styles.title}>Habilidade</h2>
        <Field
          label="Nome (kebab-case)"
          placeholder="Nome (kebab-case)"
          value={edit.name}
          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          required
        />
        <Field
          label="Quando usar"
          placeholder="Quando usar"
          value={edit.description}
          onChange={(e) => setEdit({ ...edit, description: e.target.value })}
        />
        <Field
          multiline
          label="Conteúdo da habilidade"
          className={styles.editor}
          value={edit.body}
          onChange={(e) => setEdit({ ...edit, body: e.target.value })}
          required
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.formRow}>
          <Button type="submit" variant="primary">
            Salvar
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setError(null);
              setEdit(null);
            }}
          >
            Cancelar
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <h2 className={styles.title}>Biblioteca de habilidades</h2>
        <Button
          type="button"
          variant="primary"
          className={styles.push}
          onClick={() => {
            setError(null);
            setEdit({ name: "", description: "", body: "" });
          }}
        >
          Nova habilidade
        </Button>
      </div>
      <p className={styles.muted}>
        Compartilhadas por todos os bots. Os bots também podem criar e revisar habilidades.
      </p>
      <ul className={styles.stack}>
        {skills.map((s) => (
          <li key={s.name} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.name}>{s.name}</span>
              {s.author && <span className={styles.muted}>por {s.author}</span>}
              <Button
                type="button"
                className={styles.push}
                onClick={() => {
                  setError(null);
                  setEdit({ name: s.name, description: s.description, body: s.body });
                }}
              >
                Editar
              </Button>
              <Button
                type="button"
                className={styles.action}
                onClick={() => {
                  setError(null);
                  client
                    .request("skills.delete", { name: s.name })
                    .catch(fail("skills.delete_failed"));
                }}
              >
                Excluir
              </Button>
            </div>
            <p className={styles.muted}>{s.description}</p>
          </li>
        ))}
        {skills.length === 0 && <li className={styles.muted}>Nenhuma habilidade ainda.</li>}
      </ul>
      {(error || loadError) && (
        <p className={styles.error} role="alert">
          {error ?? loadError}
        </p>
      )}
    </div>
  );
}

export function BrowserView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const { data: state, error: loadError } = useDaemonQuery(
    client,
    "browser.status",
    {},
    {
      events: { "browser.updated": true },
      onError: (e) => logWarn("browser.status_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  if (!state) {
    return loadError ? (
      <div className={styles.page}>
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      </div>
    ) : null;
  }
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "bot excluído";
  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <h2 className={styles.title}>Navegador dos bots</h2>
        {state.running && (
          <Button
            type="button"
            variant="secondary"
            className={styles.push}
            onClick={() => {
              setError(null);
              client.request("browser.close", {}).catch(fail("browser.close_failed"));
            }}
          >
            Fechar navegador
          </Button>
        )}
      </div>
      <p className={styles.muted}>
        {state.available
          ? "Os bots controlam uma janela separada do Chromium (com perfil próprio) pelas ferramentas browser_*; cada bot tem sua aba. Você pode acompanhar e usar essa janela diretamente."
          : "Nenhum navegador baseado em Chromium encontrado. Instale o Google Chrome ou configure BOTO_BROWSER_PATH."}
      </p>
      <ul className={styles.stack}>
        {state.tabs.map((t) => (
          <li key={t.agentId} className={styles.cardRow}>
            <div className={styles.grow}>
              <div className={styles.name}>{nameOf(t.agentId)}</div>
              <div className={styles.truncate}>{t.title || t.url}</div>
              <div className={styles.truncate}>{t.url}</div>
            </div>
            <Button
              type="button"
              className={styles.action}
              onClick={() => {
                setError(null);
                client
                  .request("browser.closeTab", { agentId: t.agentId })
                  .catch(fail("browser.closeTab_failed", { agentId: t.agentId }));
              }}
            >
              Fechar aba
            </Button>
          </li>
        ))}
        {state.tabs.length === 0 && <li className={styles.muted}>Nenhuma aba aberta.</li>}
      </ul>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const gatewayStatus: Record<Gateway["status"], string> = {
  connected: "Conectado",
  connecting: "Conectando",
  stopped: "Parado",
  error: "Erro",
};
const messageStatus = { pending: "Pendente", completed: "Concluída", failed: "Falhou" };

const CONNECTORS = [
  ["connector.github", "Token de acesso pessoal do GitHub (ferramenta github_api)"],
  [
    "connector.1password",
    "Token de conta de serviço do 1Password, ou 'desktop' para a integração com o app op",
  ],
  ["connector.bitwarden", "BW_SESSION do Bitwarden obtido com `bw unlock --raw`"],
] as const;

export function VaultView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const { data: entries = [], error: loadError } = useDaemonQuery(
    client,
    "vault.list",
    {},
    {
      events: { "vault.changed": true },
      onError: (e) => logWarn("vault.list_failed", errorFields(e)),
    },
  );
  const [form, setForm] = useState({ name: "", value: "", agentIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  return (
    <div className={styles.page}>
      <h2 className={styles.title}>Cofre</h2>
      <p className={styles.muted}>
        Os segredos são criptografados com uma chave no armazenamento seguro do sistema (macOS
        Keychain, Windows DPAPI ou Linux Secret Service). Os bots só veem os segredos que você
        compartilha com eles (vault_get); os conectores usam seus segredos sem revelá-los.
      </p>
      <ul className={styles.stack}>
        {entries.map((e) => (
          <li key={e.name} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.mono}>{e.name}</span>
              <Button
                type="button"
                className={styles.push}
                onClick={() =>
                  client
                    .request("vault.delete", { name: e.name })
                    .catch(fail("vault.delete_failed"))
                }
              >
                Excluir
              </Button>
            </div>
            <div className={styles.wrap}>
              {agents.map((a) => (
                <label key={a.id} className={styles.checkLabel}>
                  <input
                    className={styles.checkbox}
                    type="checkbox"
                    checked={e.agentIds.includes(a.id)}
                    onChange={() =>
                      client
                        .request("vault.setAccess", {
                          name: e.name,
                          agentIds: toggle(e.agentIds, a.id),
                        })
                        .catch(fail("vault.setAccess_failed"))
                    }
                  />
                  {a.name}
                </label>
              ))}
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className={styles.muted}>Nenhum segredo ainda.</li>}
      </ul>
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("vault.set", form)
            .then(() => setForm({ name: "", value: "", agentIds: [] }))
            .catch(fail("vault.set_failed"));
        }}
      >
        <h3 className={styles.subtitle}>Adicionar ou substituir um segredo</h3>
        <div className={styles.formRow}>
          <Field
            label="Nome"
            placeholder="Nome"
            value={form.name}
            list="vault-connectors"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <Field
            label="Valor"
            type="password"
            placeholder="Valor"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            required
          />
        </div>
        <datalist id="vault-connectors">
          {CONNECTORS.map(([n, d]) => (
            <option key={n} value={n}>
              {d}
            </option>
          ))}
        </datalist>
        <div className={styles.wrap}>
          {agents.map((a) => (
            <label key={a.id} className={styles.checkLabel}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={form.agentIds.includes(a.id)}
                onChange={() => setForm({ ...form, agentIds: toggle(form.agentIds, a.id) })}
              />
              {a.name}
            </label>
          ))}
        </div>
        <ul className={styles.muted}>
          {CONNECTORS.map(([n, d]) => (
            <li key={n}>
              <span className={styles.mono}>{n}</span>: {d}
            </li>
          ))}
        </ul>
        {(error || loadError) && (
          <p className={styles.error} role="alert">
            {error ?? loadError}
          </p>
        )}
        <Button type="submit" variant="primary">
          Salvar segredo
        </Button>
      </form>
    </div>
  );
}

const GATEWAY_HELP: Record<GatewayKind, { fields: [string, string][]; help: string }> = {
  telegram: {
    fields: [["botToken", "Token do bot fornecido pelo @BotFather"]],
    help: "Envie uma mensagem diretamente ao bot. Os IDs de usuário são numéricos; usuários desconhecidos recebem seu ID na resposta.",
  },
  slack: {
    fields: [
      ["botToken", "Token do bot (xoxb-…)"],
      ["appToken", "Token do app com connections:write (xapp-…)"],
    ],
    help: "Ative Socket Mode e assine app_mention e message.im. Mencione o app em um canal ou envie uma mensagem direta.",
  },
  discord: {
    fields: [["botToken", "Token do bot"]],
    help: "Ative a intent Message Content. Mencione o bot em um servidor ou envie uma mensagem direta. Os IDs de usuário são snowflakes do Discord.",
  },
};

export function GatewaysView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [kind, setKind] = useState<GatewayKind>("telegram");
  const [form, setForm] = useState({
    name: "",
    agentId: "",
    users: "",
    tokens: {} as Record<string, string>,
  });
  const { data: items = [], error: loadError } = useDaemonQuery(
    client,
    "gateways.list",
    {},
    {
      events: { "gateway.updated": true, "gateway.deleted": true },
      onError: (e) => logWarn("gateways.list_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  const users = (s: string) =>
    s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className={styles.page}>
      <h2 className={styles.title}>Gateways</h2>
      <p className={styles.muted}>
        Converse com seus bots pelo Telegram, Slack ou Discord. Apenas IDs de usuário autorizados
        têm acesso; comece a mensagem com @BotName para falar com outro bot. Os tokens ficam no
        cofre.
      </p>
      <ul className={styles.stack}>
        {items.map((g) => (
          <li key={g.id} className={styles.card}>
            <div className={styles.row}>
              <Tag>{gatewayStatus[g.status]}</Tag>
              <span className={styles.name}>{g.name}</span>
              <span className={styles.muted}>{g.kind}</span>
              <Select
                aria-label={`Bot do gateway ${g.name}`}
                className={styles.push}
                value={g.agentId}
                onChange={(e) =>
                  client
                    .request("gateways.update", { id: g.id, agentId: e.target.value })
                    .catch(fail("gateways.update_failed", { id: g.id }))
                }
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <label className={styles.checkLabel} htmlFor={`gateway-${g.id}`}>
                <Switch
                  id={`gateway-${g.id}`}
                  aria-label={`Ativar gateway ${g.name}`}
                  checked={g.enabled}
                  onCheckedChange={(checked) =>
                    client
                      .request("gateways.update", { id: g.id, enabled: checked })
                      .catch(fail("gateways.update_failed", { id: g.id }))
                  }
                />
                Ativo
              </label>
              <Button
                type="button"
                className={styles.action}
                onClick={() =>
                  client
                    .request("gateways.delete", { id: g.id })
                    .catch(fail("gateways.delete_failed", { id: g.id }))
                }
              >
                Excluir
              </Button>
            </div>
            {g.error && (
              <div className={styles.error} role="alert">
                {g.error}
              </div>
            )}
            <Field
              label="IDs de usuário autorizados (separados por vírgula)"
              defaultValue={g.allowedUsers.join(", ")}
              placeholder="IDs de usuário autorizados (separados por vírgula)"
              onBlur={(e) =>
                client
                  .request("gateways.update", { id: g.id, allowedUsers: users(e.target.value) })
                  .catch(fail("gateways.update_failed", { id: g.id }))
              }
            />
          </li>
        ))}
        {items.length === 0 && <li className={styles.muted}>Nenhum gateway ainda.</li>}
      </ul>
      {loadError && (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      )}
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("gateways.create", {
              kind,
              name: form.name,
              agentId: form.agentId || agents[0]?.id || "",
              tokens: form.tokens,
              allowedUsers: users(form.users),
            })
            .then(() => setForm({ name: "", agentId: "", users: "", tokens: {} }))
            .catch(fail("gateways.create_failed"));
        }}
      >
        <h3 className={styles.subtitle}>Novo gateway</h3>
        <div className={styles.formRow}>
          <Select
            aria-label="Serviço do gateway"
            value={kind}
            onChange={(e) => setKind(e.target.value as GatewayKind)}
          >
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
          </Select>
          <Field
            label="Nome"
            placeholder="Nome"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <Select
            aria-label="Bot do novo gateway"
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value })}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        {GATEWAY_HELP[kind].fields.map(([field, label]) => (
          <Field
            label={label}
            key={field}
            type="password"
            placeholder={label}
            value={form.tokens[field] ?? ""}
            onChange={(e) =>
              setForm({ ...form, tokens: { ...form.tokens, [field]: e.target.value } })
            }
            required
          />
        ))}
        <Field
          label="IDs de usuário autorizados (separados por vírgula)"
          placeholder="IDs de usuário autorizados (separados por vírgula)"
          value={form.users}
          onChange={(e) => setForm({ ...form, users: e.target.value })}
        />
        <p className={styles.muted}>{GATEWAY_HELP[kind].help}</p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={agents.length === 0}>
          Conectar
        </Button>
      </form>
    </div>
  );
}

export function MarketplaceView({ client }: { client: DaemonClient }) {
  const providerId = useId();
  const {
    data,
    error: loadError,
    reload,
  } = useDaemonQuery(
    client,
    "marketplace.list",
    {},
    {
      onError: (e) => logWarn("marketplace.list_failed", errorFields(e)),
    },
  );
  const [sources, setSources] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setSources(data.sources.join("\n"));
  }, [data]);
  const install = (i: MarketplaceItem) => {
    setBusy(`${i.source}#${i.id}`);
    setError(null);
    client
      .request("marketplace.install", {
        source: i.source,
        id: i.id,
        ...(i.kind === "agent" ? { provider } : {}),
      })
      .then(reload)
      .catch((e) => {
        logWarn("marketplace.install_failed", { id: i.id, ...errorFields(e) });
        setError(errorMessage(e));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <h2 className={styles.title}>Marketplace</h2>
        <label className={styles.provider} htmlFor={providerId}>
          Provedor dos novos bots{" "}
          <Select
            id={providerId}
            className={styles.select}
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {(error || loadError) && (
        <p className={styles.error} role="alert">
          {error ?? loadError}
        </p>
      )}
      {data?.errors.map((e) => (
        <p key={e.source} className={styles.warning}>
          {e.source}: {e.error}
        </p>
      ))}
      <ul className={styles.grid}>
        {data?.items.map((i) => (
          <li key={`${i.source}#${i.id}`} className={styles.marketCard}>
            <div className={styles.row}>
              <span className={styles.name}>{i.name}</span>
              <Tag>{i.kind === "agent" ? "Bot" : "Habilidade"}</Tag>
            </div>
            <p className={styles.description}>{i.description}</p>
            <div className={styles.cardFooter}>
              {i.author} · v{i.version}
              <Button
                type="button"
                variant="primary"
                className={styles.push}
                disabled={busy !== null}
                onClick={() => install(i)}
              >
                {busy === `${i.source}#${i.id}`
                  ? "Instalando…"
                  : i.installed
                    ? "Reinstalar"
                    : "Instalar"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("marketplace.setSources", {
              urls: sources
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
            .then(reload)
            .catch((err) => {
              logWarn("marketplace.setSources_failed", errorFields(err));
              setError(errorMessage(err));
            });
        }}
      >
        <h3 className={styles.subtitle}>Registros</h3>
        <Field
          multiline
          label="Registros"
          className={styles.registry}
          value={sources}
          onChange={(e) => setSources(e.target.value)}
        />
        <p className={styles.muted}>
          Uma URL de index.json por linha (https ou file). Os arquivos são verificados pelo sha256.
        </p>
        <Button type="submit" variant="secondary">
          Salvar registros
        </Button>
      </form>
    </div>
  );
}

export function MobileView({ client }: { client: DaemonClient }) {
  const enabledId = useId();
  const {
    data: st,
    error: loadError,
    reload,
  } = useDaemonQuery(
    client,
    "mobile.status",
    {},
    {
      onError: (e) => logWarn("mobile.status_failed", errorFields(e)),
    },
  );
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  if (!st) {
    return loadError ? (
      <div className={styles.narrow}>
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      </div>
    ) : null;
  }
  return (
    <div className={styles.narrow}>
      <h2 className={styles.title}>Celular</h2>
      <p className={styles.muted}>
        Converse com seus bots e responda a pedidos de permissão pelo celular na mesma rede Wi-Fi.
        Abra o endereço no Safari e use "Adicionar à Tela de Início". O tráfego usa HTTP sem
        criptografia na rede local; apenas dispositivos emparelhados têm acesso.
      </p>
      <label className={styles.checkLabel} htmlFor={enabledId}>
        <Switch
          id={enabledId}
          aria-label="Permitir acesso pelo celular nesta rede"
          checked={st.enabled}
          onCheckedChange={(checked) => {
            setPair(null);
            client
              .request("mobile.enable", { enabled: checked })
              .then(reload)
              .catch(fail("mobile.enable_failed"));
          }}
        />
        Permitir acesso pelo celular nesta rede
      </label>
      {st.enabled && (
        <>
          <ul className={styles.stack}>
            {st.urls.map((u) => (
              <li key={u} className={styles.address}>
                {u}
              </li>
            ))}
            {st.urls.length === 0 && (
              <li className={styles.warning}>Nenhum endereço de rede encontrado.</li>
            )}
          </ul>
          <div className={styles.row}>
            <Button
              type="button"
              variant="primary"
              onClick={() =>
                client.request("mobile.pair", {}).then(setPair).catch(fail("mobile.pair_failed"))
              }
            >
              Emparelhar dispositivo
            </Button>
            {pair && (
              <span
                className={styles.pairCode}
                title={`expira às ${new Date(pair.expiresAt).toLocaleTimeString()}`}
              >
                {pair.code}
              </span>
            )}
          </div>
        </>
      )}
      {(error || loadError) && (
        <p className={styles.error} role="alert">
          {error ?? loadError}
        </p>
      )}
      <h3 className={styles.subtitle}>Dispositivos emparelhados</h3>
      <ul className={styles.stack}>
        {st.devices.map((d) => (
          <li key={d.id} className={styles.cardRow}>
            <span>{d.name}</span>
            <span className={styles.muted}>
              {d.lastSeenAt
                ? `visto em ${new Date(d.lastSeenAt).toLocaleString()}`
                : "nunca conectado"}
            </span>
            <Button
              type="button"
              className={styles.push}
              onClick={() =>
                client
                  .request("mobile.revoke", { id: d.id })
                  .then(reload)
                  .catch(fail("mobile.revoke_failed", { id: d.id }))
              }
            >
              Revogar
            </Button>
          </li>
        ))}
        {st.devices.length === 0 && <li className={styles.muted}>Nenhum ainda.</li>}
      </ul>
    </div>
  );
}

export function TeamView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const {
    data: st,
    error: statusError,
    reload: reloadStatus,
  } = useDaemonQuery(
    client,
    "team.status",
    {},
    {
      events: { "team.updated": true },
      onError: (e) => logWarn("team.status_failed", errorFields(e)),
    },
  );
  const { data: msgs = [], error: msgsError } = useDaemonQuery(
    client,
    "team.messages",
    {},
    {
      events: { "team.message": true },
      onError: (e) => logWarn("team.messages_failed", errorFields(e)),
    },
  );
  const [join, setJoin] = useState({ url: "", token: "" });
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  const shownError = error ?? statusError ?? msgsError;
  if (!st) {
    return shownError ? (
      <div className={styles.narrow}>
        <p className={styles.error} role="alert">
          {shownError}
        </p>
      </div>
    ) : null;
  }
  if (!st.configured) {
    return (
      <form
        className={styles.narrow}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("team.connect", join)
            .then(reloadStatus)
            .catch(fail("team.connect_failed"));
        }}
      >
        <h2 className={styles.title}>Equipe</h2>
        <p className={styles.muted}>
          Conecte-se a um relay de equipe do Boto para compartilhar bots e conversar com os bots da
          equipe. Hospede um com <code>bun run relay -- --data ./relay-data</code> e convide membros
          com o token de administrador.
        </p>
        <Field
          label="URL do relay (https://relay.example.com)"
          placeholder="URL do relay (https://relay.example.com)"
          value={join.url}
          onChange={(e) => setJoin({ ...join, url: e.target.value })}
          required
        />
        <Field
          label="Token de membro"
          type="password"
          placeholder="Token de membro"
          value={join.token}
          onChange={(e) => setJoin({ ...join, token: e.target.value })}
          required
        />
        {shownError && (
          <p className={styles.error} role="alert">
            {shownError}
          </p>
        )}
        <Button type="submit" variant="primary">
          Entrar na equipe
        </Button>
      </form>
    );
  }
  const options = st.members.flatMap((m) =>
    m.agents.map((a) => ({ key: `${m.id}:${a.id}`, label: `${a.name} (${m.name})` })),
  );
  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <h2 className={styles.title}>Equipe</h2>
        <span className={styles.muted}>
          {st.connected ? `conectado como ${st.me?.name ?? ""}` : (st.error ?? "conectando…")}
        </span>
        <Button
          type="button"
          className={styles.push}
          onClick={() =>
            client
              .request("team.disconnect", {})
              .then(reloadStatus)
              .catch(fail("team.disconnect_failed"))
          }
        >
          Sair
        </Button>
      </div>
      <section className={styles.stack}>
        <h3 className={styles.subtitle}>Bots que você compartilha</h3>
        <div className={styles.wrap}>
          {agents.map((a) => (
            <label key={a.id} className={styles.checkLabel}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={st.sharedAgentIds.includes(a.id)}
                onChange={() =>
                  client
                    .request("team.share", {
                      agentIds: st.sharedAgentIds.includes(a.id)
                        ? st.sharedAgentIds.filter((x) => x !== a.id)
                        : [...st.sharedAgentIds, a.id],
                    })
                    .then(reloadStatus)
                    .catch(fail("team.share_failed"))
                }
              />
              {a.name}
            </label>
          ))}
        </div>
      </section>
      <section className={styles.stack}>
        <h3 className={styles.subtitle}>Membros da equipe</h3>
        <ul className={styles.stack}>
          {st.members.map((m) => (
            <li key={m.id}>
              <span className={m.online ? styles.name : styles.muted}>{m.name}</span>
              <span className={styles.muted}>
                {m.online
                  ? m.agents.map((a) => a.name).join(", ") || "nenhum bot compartilhado"
                  : "desconectado"}
              </span>
            </li>
          ))}
          {st.members.length === 0 && <li className={styles.muted}>Nenhum membro ainda.</li>}
        </ul>
      </section>
      <ul className={styles.stack}>
        {msgs.map((m) => (
          <li key={m.id} className={styles.card}>
            <div className={styles.muted}>
              {m.direction === "out"
                ? `Você → ${m.agentName} (${m.memberName})`
                : `${m.memberName} → seu bot ${m.agentName}`}{" "}
              · {messageStatus[m.status]}
            </div>
            <div className={styles.message}>{m.text}</div>
            {m.reply && (
              <div className={styles.reply}>
                <span>↳</span>
                <Markdown text={m.reply} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className={styles.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const [memberId, agentId] = (target || options[0]?.key || "").split(":");
          if (!memberId || !agentId || !text.trim()) return;
          setError(null);
          client
            .request("team.send", { memberId, agentId, text })
            .then(() => setText(""))
            .catch(fail("team.send_failed"));
        }}
      >
        <Select
          aria-label="Bot destinatário"
          className={styles.select}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </Select>
        <Field
          label="Mensagem para um bot da equipe"
          placeholder="Mensagem para um bot da equipe"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={options.length === 0}>
          Enviar
        </Button>
      </form>
      {shownError && (
        <p className={styles.error} role="alert">
          {shownError}
        </p>
      )}
    </div>
  );
}
