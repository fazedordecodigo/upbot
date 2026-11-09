import type { MarketplaceItem } from "@boto/protocol";
import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
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
  const toast = useToast();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(item.installed);
  const [confirm, setConfirm] = useState(false);
  const skills = useDaemonQuery(
    client,
    "marketplace.list",
    { kind: "skill" },
    { enabled: item.kind === "plugin" },
  );

  async function install() {
    setPending(true);
    setError(null);
    try {
      await client.request("marketplace.install", { source: item.source, id: item.id, secrets });
      setInstalled(true);
      setSecrets({});
      onChanged();
      toast(`${item.name} instalado.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
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
      toast(`${item.name} removido.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
      setConfirm(false);
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
              <a href={item.homepage} target="_blank" rel="noreferrer">
                Ver documentação
                <Icon name="arrow-up-right" />
              </a>
            )}
            <p className="mk-permission">
              Na primeira vez que um agente usa uma ferramenta numa sessão, ele pede sua permissão.
            </p>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            {installed ? (
              <div className="od-stack">
                <InstalledBadge />
                {item.kind === "agent" ? (
                  <p>Gerencie este item em Agentes.</p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-destructive"
                    disabled={pending || (item.kind === "plugin" && !skills.data)}
                    onClick={() => setConfirm(true)}
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
      <Dialog
        open={confirm}
        onClose={() => {
          if (!pending) setConfirm(false);
        }}
        id="confirm"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
      >
        <div className="dialog-body">
          <div className="dialog-header">
            <h2 className="dialog-title" id="confirm-title">
              Remover {item.name}?
            </h2>
            <p className="dialog-description" id="confirm-desc">
              Este item deixará de ficar disponível para os agentes.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="btn btn-outline"
              id="confirm-cancel"
              disabled={pending}
              onClick={() => setConfirm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              id="confirm-ok"
              disabled={pending}
              onClick={() => void remove()}
            >
              {pending ? "Removendo…" : "Remover"}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
