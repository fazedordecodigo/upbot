import type { Agent, EmailAccount, EmailDraft, EmailProvider } from "@boto/protocol";
import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { errorFields, logWarn } from "../lib/log";
import { btnCls, inputCls } from "./AgentSettings";
import { Button, Field, Select } from "./ds/controls";
import styles from "./EmailView.module.css";

const PROVIDER_HINTS: Record<EmailProvider, string> = {
  gmail:
    "Gmail: ative a verificação em duas etapas e crie uma senha de app em myaccount.google.com/apppasswords.",
  icloud:
    "iCloud: crie uma senha específica de app em account.apple.com → Início de Sessão e Segurança.",
  outlook: "Outlook / Microsoft 365: use uma senha de app se sua conta permitir IMAP com senhas.",
  custom: "Qualquer servidor IMAP (TLS, geralmente porta 993) + SMTP.",
};

const splitList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function useDrafts(client: DaemonClient, agentId?: string) {
  return useDaemonQuery(
    client,
    "email.drafts.list",
    agentId ? { agentId, pendingOnly: true } : {},
    {
      events: { "email.draft.updated": (d) => !agentId || d.agentId === agentId },
      onError: (e) => logWarn("email.drafts.list_failed", { agentId, ...errorFields(e) }),
    },
  );
}

const draftStatus: Record<EmailDraft["status"], string> = {
  pending: "Pendente",
  sending: "Enviando",
  sent: "Enviado",
  discarded: "Descartado",
  failed: "Falhou",
};

function SettingsDraftInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <Field {...props} label={props["aria-label"] ?? ""} />;
}

function SettingsDraftTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Field {...props} multiline label={props["aria-label"] ?? ""} />;
}

export function DraftCard({
  client,
  draft,
  accounts,
  botName,
  settings = false,
}: {
  client: DaemonClient;
  draft: EmailDraft;
  accounts: EmailAccount[];
  botName?: string;
  settings?: boolean;
}) {
  const Input = settings ? SettingsDraftInput : "input";
  const Textarea = settings ? SettingsDraftTextarea : "textarea";
  const Action = settings ? Button : "button";
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const editable = draft.status === "pending" || draft.status === "failed";
  const from =
    accounts.find((a) => a.id === draft.accountId)?.address ??
    (settings ? "conta desconhecida" : "unknown account");
  const save = () =>
    client.request("email.drafts.update", {
      id: draft.id,
      to: splitList(to),
      cc: splitList(cc),
      subject,
      body,
    });
  const fail = (scope: string) => (e: unknown) => {
    logWarn(scope, errorFields(e));
    setError(errorMessage(e));
  };
  return (
    <div
      className={
        settings
          ? styles.card
          : "space-y-2 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-sm"
      }
      data-testid="email-draft"
    >
      <div className={settings ? styles.row : "flex items-center gap-2 text-xs text-zinc-400"}>
        <span className={settings ? styles.name : "font-semibold text-sky-300"}>
          {settings ? "Rascunho de e-mail" : "Email draft"}
        </span>
        {botName && (
          <span>
            {settings ? "por" : "by"} {botName}
          </span>
        )}
        <span>
          {settings ? "de" : "from"} {from}
        </span>
        <span className={settings ? styles.status : "ml-auto rounded bg-zinc-800 px-1.5 py-0.5"}>
          {settings ? draftStatus[draft.status] : draft.status}
        </span>
      </div>
      <Input
        className={settings ? undefined : inputCls}
        value={to}
        disabled={!editable}
        onChange={(e) => setTo(e.target.value)}
        placeholder={settings ? "Para" : "To"}
        aria-label={settings ? "Para" : "To"}
      />
      <Input
        className={settings ? undefined : inputCls}
        value={cc}
        disabled={!editable}
        onChange={(e) => setCc(e.target.value)}
        placeholder="Cc"
        aria-label="Cc"
      />
      <Input
        className={settings ? undefined : inputCls}
        value={subject}
        disabled={!editable}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={settings ? "Assunto" : "Subject"}
        aria-label={settings ? "Assunto" : "Subject"}
      />
      <Textarea
        className={settings ? styles.body : `${inputCls} min-h-28`}
        value={body}
        disabled={!editable}
        onChange={(e) => setBody(e.target.value)}
        aria-label={settings ? "Mensagem" : "Body"}
      />
      {(error || draft.error) && (
        <div
          className={settings ? styles.error : "text-xs text-red-400"}
          role={settings ? "alert" : undefined}
        >
          {error || draft.error}
        </div>
      )}
      {editable && (
        <div className={settings ? styles.row : "flex gap-2"}>
          <Action
            type="button"
            className={settings ? undefined : `${btnCls} bg-sky-600 hover:bg-sky-500`}
            onClick={() => {
              setError(null);
              save().then(
                () =>
                  client
                    .request("email.drafts.send", { id: draft.id })
                    .catch(fail("email.drafts.send_failed")),
                fail("email.drafts.update_failed"),
              );
            }}
          >
            {settings ? "Enviar" : "Send"}
          </Action>
          <Action
            type="button"
            className={settings ? undefined : `${btnCls} bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => {
              setError(null);
              save().catch(fail("email.drafts.update_failed"));
            }}
          >
            {settings ? "Salvar" : "Save"}
          </Action>
          <Action
            type="button"
            className={settings ? styles.push : `${btnCls} ml-auto bg-zinc-800 hover:bg-red-900`}
            onClick={() =>
              client
                .request("email.drafts.discard", { id: draft.id })
                .catch(fail("email.drafts.discard_failed"))
            }
          >
            {settings ? "Descartar" : "Discard"}
          </Action>
        </div>
      )}
    </div>
  );
}

function useAccounts(client: DaemonClient) {
  return useDaemonQuery(
    client,
    "email.accounts.list",
    {},
    {
      events: { "email.accounts.changed": true },
      onError: (e) => logWarn("email.accounts.list_failed", errorFields(e)),
    },
  );
}

/** Pending drafts of one bot, shown above the composer. */
export function DraftCards({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const { data: drafts = [], error } = useDrafts(client, agentId);
  const { data: accounts = [] } = useAccounts(client);
  if (error && !drafts.length)
    return <div className="border-t border-zinc-800 px-4 py-2 text-xs text-red-400">{error}</div>;
  if (!drafts.length) return null;
  return (
    <div className="max-h-[50vh] space-y-2 overflow-y-auto border-t border-zinc-800 px-4 py-2">
      {error && <p className="px-4 py-1 text-xs text-red-400">{error}</p>}
      {drafts.map((d) => (
        <DraftCard key={`${d.id}:${d.updatedAt}`} client={client} draft={d} accounts={accounts} />
      ))}
    </div>
  );
}

export function EmailView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const providerId = useId();
  const { data: accounts = [], error: accountsError } = useAccounts(client);
  const { data: drafts = [], error: draftsError } = useDrafts(client);
  const [provider, setProvider] = useState<EmailProvider>("gmail");
  const [form, setForm] = useState({
    address: "",
    password: "",
    label: "",
    imapHost: "",
    imapPort: "993",
    smtpHost: "",
    smtpPort: "465",
  });
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const fail = (scope: string) => (e: unknown) => {
    logWarn(scope, errorFields(e));
    setError(errorMessage(e));
  };
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "bot excluído";
  return (
    <div className={styles.page}>
      <h2 className={styles.title}>E-mail</h2>
      <p className={styles.muted}>
        Os bots podem pesquisar e ler as caixas de e-mail conectadas e preparar rascunhos. Nada é
        enviado até você revisar um rascunho e clicar em Enviar. As senhas de app são criptografadas
        no cofre e nunca são mostradas aos bots.
      </p>
      <ul className={styles.stack}>
        {accounts.map((a) => (
          <li key={a.id} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.name}>{a.label}</span>
              <span className={styles.muted}>
                {a.address} · {a.provider}
              </span>
              <Button
                type="button"
                className={styles.push}
                onClick={() => {
                  setTests((t) => ({ ...t, [a.id]: "Testando…" }));
                  client
                    .request("email.accounts.test", { id: a.id })
                    .then((r) =>
                      setTests((t) => ({
                        ...t,
                        [a.id]: r.ok
                          ? "Conectado"
                          : [r.imap, r.smtp].filter((x) => x !== "ok").join(" · "),
                      })),
                    )
                    .catch(fail("email.accounts.test_failed"));
                }}
              >
                Testar
              </Button>
              <Button
                type="button"
                className={styles.action}
                onClick={() =>
                  client
                    .request("email.accounts.delete", { id: a.id })
                    .catch(fail("email.accounts.delete_failed"))
                }
              >
                Remover
              </Button>
            </div>
            {tests[a.id] && <div className={styles.muted}>{tests[a.id]}</div>}
            <div className={styles.row}>
              <span>Bots:</span>
              {agents.map((b) => {
                const all = a.agentIds.length === 0;
                const on = all || a.agentIds.includes(b.id);
                return (
                  <label key={b.id} className={styles.checkLabel}>
                    <input
                      className={styles.checkbox}
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const cur = all ? agents.map((x) => x.id) : a.agentIds;
                        const next = e.target.checked
                          ? [...cur, b.id]
                          : cur.filter((x) => x !== b.id);
                        const agentIds = next.length === agents.length ? [] : next;
                        client
                          .request("email.accounts.save", {
                            id: a.id,
                            provider: a.provider,
                            address: a.address,
                            agentIds,
                          })
                          .catch(fail("email.accounts.save_failed"));
                      }}
                    />
                    {b.name}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
        {accounts.length === 0 && <li className={styles.muted}>Nenhuma conta de e-mail ainda.</li>}
      </ul>
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const custom = provider === "custom";
          client
            .request("email.accounts.save", {
              provider,
              address: form.address,
              password: form.password,
              ...(form.label ? { label: form.label } : {}),
              ...(custom
                ? {
                    imapHost: form.imapHost,
                    imapPort: Number(form.imapPort),
                    smtpHost: form.smtpHost,
                    smtpPort: Number(form.smtpPort),
                    smtpSecure: Number(form.smtpPort) === 465,
                  }
                : {}),
            })
            .then(() => setForm({ ...form, address: "", password: "", label: "" }))
            .catch(fail("email.accounts.save_failed"));
        }}
      >
        <h3 className={styles.subtitle}>Conectar uma conta</h3>
        <div className={styles.formRow}>
          <div className={styles.selectField}>
            <label htmlFor={providerId}>Provedor</label>
            <Select
              id={providerId}
              value={provider}
              onChange={(e) => setProvider(e.target.value as EmailProvider)}
              aria-label="Provedor de e-mail"
            >
              <option value="gmail">Gmail</option>
              <option value="icloud">iCloud Mail</option>
              <option value="outlook">Outlook</option>
              <option value="custom">Outro (IMAP/SMTP)</option>
            </Select>
          </div>
          <Field
            label="Nome (opcional)"
            placeholder="Nome (opcional)"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </div>
        <Field
          type="email"
          required
          label="Endereço de e-mail"
          placeholder="Endereço de e-mail"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
        <Field
          type="password"
          required
          autoComplete="off"
          label="Senha de app"
          placeholder="Senha de app"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {provider === "custom" && (
          <div className={styles.serverFields}>
            <Field
              required
              label="Servidor IMAP"
              placeholder="Servidor IMAP"
              value={form.imapHost}
              onChange={(e) => setForm({ ...form, imapHost: e.target.value })}
            />
            <Field
              label="Porta IMAP"
              placeholder="993"
              value={form.imapPort}
              onChange={(e) => setForm({ ...form, imapPort: e.target.value })}
            />
            <Field
              required
              label="Servidor SMTP"
              placeholder="Servidor SMTP"
              value={form.smtpHost}
              onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
            />
            <Field
              label="Porta SMTP"
              placeholder="465 ou 587"
              value={form.smtpPort}
              onChange={(e) => setForm({ ...form, smtpPort: e.target.value })}
            />
          </div>
        )}
        <p className={styles.muted}>{PROVIDER_HINTS[provider]}</p>
        {(error || accountsError || draftsError) && (
          <div className={styles.error} role="alert">
            {error ?? accountsError ?? draftsError}
          </div>
        )}
        <Button type="submit" variant="primary">
          Conectar
        </Button>
      </form>
      <h3 className={styles.subtitle}>Rascunhos</h3>
      <div className={styles.stack}>
        {drafts.map((d) => (
          <DraftCard
            settings
            key={`${d.id}:${d.updatedAt}`}
            client={client}
            draft={d}
            accounts={accounts}
            botName={nameOf(d.agentId)}
          />
        ))}
        {drafts.length === 0 && <p className={styles.muted}>Nenhum rascunho ainda.</p>}
      </div>
    </div>
  );
}
