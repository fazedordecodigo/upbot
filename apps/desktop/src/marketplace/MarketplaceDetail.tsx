import type { MarketplaceItem } from "@boto/protocol";
import { useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { openExternalLink } from "../lib/external-link";
import { marketplaceError } from "../lib/marketplace";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import { InstalledBadge, MarketplaceLogo } from "./MarketplaceCard";

export function MarketplaceDetail({
  item,
  onClose,
  onChanged,
}: {
  item: MarketplaceItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useDaemon();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [installed, setInstalled] = useState(item.installed);
  const confirm = useConfirm();
  const skills = useDaemonQuery(
    client,
    "marketplace.list",
    { kind: "skill" },
    { enabled: item.kind === "plugin" },
  );

  async function install() {
    setPending(true);
    setError(null);
    setStatus("");
    try {
      await client.request("marketplace.install", { source: item.source, id: item.id, secrets });
      setInstalled(true);
      setSecrets({});
      onChanged();
      setStatus(`${item.name} instalado.`);
    } catch (e) {
      setError(marketplaceError(e, `Não foi possível instalar ${item.name}. Tente de novo.`));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
    setStatus("");
    try {
      if (item.kind === "app" || item.kind === "mcp") {
        const apps = await client.request("apps.list", {});
        const app = apps.find((app) => app.catalogId === item.catalogId);
        if (!app)
          throw new Error("App instalado não encontrado. Atualize a lista e tente de novo.");
        await client.request("apps.delete", { id: app.id });
      } else {
        const installedSkills = await client.request("skills.list", {});
        const names =
          item.kind === "plugin"
            ? (skills.data?.items ?? [])
                .filter((skill) => skill.source === item.source && item.includes.includes(skill.id))
                .map((skill) => skill.name)
            : [item.name];
        if (item.kind === "plugin" && !skills.data)
          throw new Error("Não foi possível carregar as skills. Tente de novo.");
        for (const name of names) {
          if (installedSkills.some((skill) => skill.name === name))
            await client.request("skills.delete", { name });
        }
      }
      setInstalled(false);
      onChanged();
      setStatus(`${item.name} removido.`);
    } catch (e) {
      setError(
        e instanceof Error && e.message.startsWith("App instalado não encontrado")
          ? e.message
          : marketplaceError(e, `Não foi possível remover ${item.name}. Tente de novo.`),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        className="agent-panel mk-panel"
        id="mk-panel"
        aria-labelledby="mkp-title"
      >
        <div className="ap">
          <header className="ap-head">
            <div className="ap-head-main od-field" id="mkp-head">
              <MarketplaceLogo item={item} />
              <h2 id="mkp-title">{item.name}</h2>
              <p className="mk-author">
                {item.author} · <span className="mk-version">{item.version}</span>
              </p>
              <div className="od-cluster">
                <span className="badge badge-secondary">
                  {
                    {
                      app: "App",
                      mcp: "Servidor MCP",
                      skill: "Skill",
                      plugin: "Plugin",
                      agent: "Agente",
                    }[item.kind]
                  }
                </span>
                <span className="badge badge-outline">{item.category}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm ap-close"
              aria-label="Fechar detalhes"
              data-tip="Fechar detalhes"
              title="Fechar detalhes"
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          </header>
          <div className="ap-body od-scroll" id="mkp-body">
            <p>{item.description}</p>
            {item.kind === "plugin" && (
              <section>
                <h3>Inclui</h3>
                <ul>
                  {item.includes.map((id) => (
                    <li key={id}>
                      {skills.data?.items.find(
                        (skill) => skill.source === item.source && skill.id === id,
                      )?.name ?? id}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {item.homepage && (
              <a
                href={item.homepage}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  if (item.homepage) void openExternalLink(item.homepage);
                }}
              >
                Ver documentação
                <Icon name="arrow-up-right" />
              </a>
            )}
            <p className="mk-permission">
              Na primeira vez que um agente usa uma ferramenta numa sessão, ele pede sua permissão.
            </p>
            <p className="mk-status" role="status">
              {status}
            </p>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            {installed ? (
              <div className="od-stack mk-installed">
                <InstalledBadge />
                {item.kind === "agent" ? (
                  <p>Gerencie este item em Agentes.</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-destructive"
                    disabled={pending || (item.kind === "plugin" && !skills.data)}
                    onClick={() =>
                      void confirm({
                        title: `Remover ${item.name}?`,
                        description: "Este item deixará de ficar disponível para os agentes.",
                        action: "Remover",
                        pendingAction: "Removendo…",
                        onConfirm: remove,
                      })
                    }
                  >
                    Remover
                  </button>
                )}
              </div>
            ) : (
              <form
                className="od-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  void install();
                }}
              >
                {(item.kind === "app" || item.kind === "mcp") &&
                  item.secrets.map((secret) => (
                    <div className="od-field" key={secret.key}>
                      <label className="label" htmlFor={`mk-secret-${secret.key}`}>
                        {secret.label}
                      </label>
                      <input
                        className="input"
                        id={`mk-secret-${secret.key}`}
                        type="password"
                        autoComplete="new-password"
                        required
                        value={secrets[secret.key] ?? ""}
                        onChange={(event) =>
                          setSecrets((values) => ({ ...values, [secret.key]: event.target.value }))
                        }
                        aria-describedby={`mk-hint-${secret.key}`}
                        disabled={pending}
                      />
                      <p className="mk-hint" id={`mk-hint-${secret.key}`}>
                        {secret.hint}
                      </p>
                    </div>
                  ))}
                <button className="btn btn-primary" type="submit" disabled={pending}>
                  {pending ? "Instalando…" : "Instalar"}
                </button>
              </form>
            )}
          </div>
        </div>
      </Sheet>
    </>
  );
}
