import type {
  Agent,
  AgentPlacement,
  RemoteHost,
  Subagent,
  VmCredentialKind,
  VmCredentialProvider,
} from "@boto/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { Button, Field, Select, Tag } from "./ds/controls";
import styles from "./HostsView.module.css";

const subStatus: Record<Subagent["status"], string> = {
  running: "Em execução",
  done: "Concluído",
  failed: "Falhou",
  stopped: "Parado",
};

function Preflight({ h }: { h: RemoteHost }) {
  const p = h.preflight;
  if (!p) return <p className={styles.muted}>Não instalado — clique em Instalar.</p>;
  const ok = (v: boolean) => (v ? styles.ready : styles.warning);
  const providers = Object.entries(p.providers)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <div className={styles.preflight}>
      <span>
        {p.os}/{p.arch} · kernel {p.kernelRelease} · bun {p.bun}
      </span>
      <span>CLIs: {providers.length ? providers.join(", ") : "nenhuma encontrada"}</span>
      <span className={ok(p.kvm)}>/dev/kvm {p.kvm ? "ok" : "ausente"}</span>
      <span className={ok(!!p.firecracker?.version)}>
        firecracker {p.firecracker?.version ?? "ausente"}
      </span>
      <span className={ok(!!p.kernelImage && !!p.rootfs)}>
        imagem da microVM{" "}
        {p.kernelImage && p.rootfs ? "ok" : "ausente (execute rootfs/build-rootfs.sh)"}
      </span>
      <span className={ok(p.firecrackerReady)}>
        microVMs {p.firecrackerReady ? "disponíveis" : "indisponíveis"}
      </span>
    </div>
  );
}

const CRED_HINT: Record<VmCredentialProvider, Partial<Record<VmCredentialKind, string>>> = {
  claude: {
    oauth_token: "Token de `claude setup-token` (usa sua assinatura Claude)",
    api_key: "Chave de API da Anthropic",
  },
  codex: { api_key: "Chave de API da OpenAI" },
  gemini: { api_key: "Chave de API do Gemini (aistudio.google.com/apikey)" },
  cursor: { api_key: "Chave de API do Cursor (painel Cursor → Integrations)" },
};

function VmCredentials({
  client,
  onError,
}: {
  client: DaemonClient;
  onError: (e: unknown) => void;
}) {
  const providerId = useId();
  const kindId = useId();
  const {
    data: credsData,
    error: credsError,
    reload,
  } = useDaemonQuery(client, "vmCredentials.list", {}, { events: { "hosts.changed": true } });
  const creds = credsData ?? [];
  useEffect(() => {
    onError(credsError);
  }, [credsError, onError]);
  const [form, setForm] = useState<{
    provider: VmCredentialProvider;
    kind: VmCredentialKind;
    value: string;
  }>({ provider: "claude", kind: "oauth_token", value: "" });
  const kinds = Object.keys(CRED_HINT[form.provider]) as VmCredentialKind[];
  return (
    <section className={styles.stack}>
      <h3 className={styles.subtitle}>Autenticação nas microVMs</h3>
      <p className={styles.muted}>
        Cada microVM inicia sem autenticação. As credenciais salvas são criptografadas no cofre,
        nunca são mostradas aos bots e só são entregues ao provedor dentro da microVM durante a
        sessão. A execução em processo continua usando a autenticação da CLI do próprio servidor.
      </p>
      {creds.map((c) => (
        <div key={c.provider} className={styles.row}>
          <span className={styles.provider}>{c.provider}</span>
          <span className={styles.muted}>
            {c.kind === "oauth_token" ? "token de assinatura" : "Chave de API"} · salvo em{" "}
            {new Date(c.updatedAt).toLocaleString()}
          </span>
          <span className={styles.grow} />
          <Button
            type="button"
            className={styles.action}
            onClick={() =>
              client
                .request("vmCredentials.delete", { provider: c.provider })
                .then(reload)
                .catch(onError)
            }
          >
            Remover
          </Button>
        </div>
      ))}
      <form
        className={styles.credentialsForm}
        onSubmit={(e) => {
          e.preventDefault();
          client
            .request("vmCredentials.set", form)
            .then(() => {
              setForm({ ...form, value: "" });
              reload();
            })
            .catch(onError);
        }}
      >
        <div className={styles.selectField}>
          <label htmlFor={providerId}>Provedor</label>
          <Select
            id={providerId}
            aria-label="Provedor da microVM"
            value={form.provider}
            onChange={(e) => {
              const provider = e.target.value as VmCredentialProvider;
              const kind = Object.keys(CRED_HINT[provider])[0] as VmCredentialKind;
              setForm({ provider, kind, value: "" });
            }}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="gemini">gemini</option>
            <option value="cursor">cursor</option>
          </Select>
        </div>
        <div className={styles.selectField}>
          <label htmlFor={kindId}>Tipo de credencial</label>
          <Select
            id={kindId}
            aria-label="Tipo de credencial"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as VmCredentialKind })}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k === "oauth_token" ? "Token de assinatura" : "Chave de API"}
              </option>
            ))}
          </Select>
        </div>
        <Field
          type="password"
          autoComplete="off"
          label="Credencial da microVM"
          hint={CRED_HINT[form.provider][form.kind] ?? ""}
          placeholder="Token ou chave de API"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
          required
        />
        <Button type="submit">Salvar</Button>
      </form>
    </section>
  );
}

export function HostsView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [placements, setPlacements] = useState<AgentPlacement[]>([]);
  const [subs, setSubs] = useState<Subagent[]>([]);
  const [form, setForm] = useState({ name: "", target: "", port: "22", identityFile: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setError(e === null ? null : errorMessage(e)), []);

  const reload = useCallback(() => {
    client.request("hosts.list", {}).then(setHosts).catch(fail);
    client.request("placements.list", {}).then(setPlacements).catch(fail);
    client.request("subagents.list", {}).then(setSubs).catch(fail);
  }, [client, fail]);

  useEffect(() => {
    reload();
    const offs = [
      client.on("hosts.changed", reload),
      client.on("placement.updated", reload),
      client.on("subagent.updated", (s) =>
        setSubs((prev) => {
          const i = prev.findIndex((x) => x.agentId === s.agentId);
          return i >= 0 ? prev.map((x, j) => (j === i ? s : x)) : [...prev, s];
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, reload]);

  const act = (id: string, method: "hosts.install" | "hosts.check") => {
    setBusy(id);
    setError(null);
    client
      .request(method, { id })
      .then(reload)
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const place = (agentId: string, patch: Partial<AgentPlacement>) => {
    const cur = placements.find((p) => p.agentId === agentId) ?? {
      agentId,
      hostId: null,
      isolation: "none" as const,
      vcpus: 2,
      memMib: 2048,
    };
    const next = { ...cur, ...patch };
    if (!next.hostId) next.isolation = "none";
    setError(null);
    client
      .request("placements.set", {
        agentId,
        hostId: next.hostId,
        isolation: next.isolation,
        vcpus: next.vcpus,
        memMib: next.memMib,
      })
      .then(reload)
      .catch(fail);
  };

  const topLevel = agents.filter((a) => !subs.some((s) => s.agentId === a.id));
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className={styles.page}>
      <div>
        <h2 className={styles.title}>Servidores remotos</h2>
        <p className={styles.muted}>
          Execute bots em um VPS Linux por SSH em vez deste computador. O Boto usa o{" "}
          <code>ssh</code> do sistema (chaves de <code>~/.ssh</code> ou do serviço de autenticação
          SSH; nada é armazenado aqui) e envia um pequeno auxiliar para <code>~/.boto</code> no
          servidor. Com KVM e a imagem instalados, cada bot e sub-bot executa em sua própria microVM
          Firecracker.
        </p>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <section className={styles.stack}>
        {hosts.map((h) => (
          <div key={h.id} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.name}>{h.name}</span>
              <code className={styles.muted}>
                {h.target}:{h.port}
              </code>
              <span className={styles.grow} />
              <Button
                type="button"
                disabled={busy === h.id}
                onClick={() => act(h.id, "hosts.install")}
              >
                {busy === h.id ? "Trabalhando…" : h.root ? "Reinstalar" : "Instalar"}
              </Button>
              <Button
                type="button"
                disabled={busy === h.id || !h.root}
                onClick={() => act(h.id, "hosts.check")}
              >
                Verificar
              </Button>
              <Button
                type="button"
                className={styles.action}
                onClick={() =>
                  client.request("hosts.delete", { id: h.id }).then(reload).catch(fail)
                }
              >
                Remover
              </Button>
            </div>
            <Preflight h={h} />
          </div>
        ))}
        <form
          className={styles.hostForm}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            client
              .request("hosts.create", {
                name: form.name || form.target,
                target: form.target,
                port: Number(form.port) || 22,
                identityFile: form.identityFile || null,
              })
              .then(() => {
                setForm({ name: "", target: "", port: "22", identityFile: "" });
                reload();
              })
              .catch(fail);
          }}
        >
          <Field
            label="Nome"
            placeholder="Nome"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Field
            label="Destino SSH"
            placeholder="user@host"
            required
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
          />
          <Field
            label="Porta SSH"
            placeholder="22"
            inputMode="numeric"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
          />
          <Field
            label="Arquivo de identidade (opcional)"
            placeholder="Ex.: ~/.ssh/id_ed25519"
            value={form.identityFile}
            onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
          />
          <Button type="submit">Adicionar servidor</Button>
        </form>
      </section>

      <section className={styles.stack}>
        <h3 className={styles.subtitle}>Onde os bots são executados</h3>
        {topLevel.map((a) => {
          const p = placements.find((x) => x.agentId === a.id);
          const host = hosts.find((h) => h.id === p?.hostId);
          return (
            <div key={a.id} className={styles.row}>
              <span className={styles.botName}>{a.name}</span>
              <Select
                aria-label={`Servidor de ${a.name}`}
                value={p?.hostId ?? ""}
                onChange={(e) => place(a.id, { hostId: e.target.value || null })}
              >
                <option value="">Este computador</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id} disabled={!h.root}>
                    {h.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`Isolamento de ${a.name}`}
                value={p?.isolation ?? "none"}
                disabled={!p?.hostId}
                onChange={(e) =>
                  place(a.id, { isolation: e.target.value as AgentPlacement["isolation"] })
                }
              >
                <option value="none">Processo</option>
                <option value="firecracker" disabled={!host?.preflight?.firecrackerReady}>
                  Firecracker microVM
                </option>
              </Select>
              {p?.isolation === "firecracker" && (
                <span className={styles.muted}>
                  {p.vcpus} vCPU · {p.memMib} MiB
                </span>
              )}
            </div>
          );
        })}
      </section>

      <VmCredentials client={client} onError={fail} />

      {subs.length > 0 && (
        <section className={styles.stack}>
          <h3 className={styles.subtitle}>Sub-bots</h3>
          {subs
            .slice(-30)
            .reverse()
            .map((s) => (
              <div key={s.agentId} className={styles.row}>
                <Tag>{subStatus[s.status]}</Tag>
                <span className={styles.muted}>{nameOf(s.parentId)} →</span>
                <span className={styles.truncate}>{s.task}</span>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
