import { useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useDaemon } from "../shell/daemon";
import { useToast } from "../ui/Toast";
import { QueryState } from "./QueryState";

export function Permissions() {
  const { client, ready, agents } = useDaemon();
  const query = useDaemonQuery(
    client,
    "tools.permissions.list",
    {},
    { enabled: ready, events: { "approvals.rulesChanged": true, "apps.changed": true } },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();
  const allowed = query.data?.filter((p) => p.level === "allow") ?? [];
  return (
    <div id="st-perms" aria-busy={!query.loaded && !query.error}>
      <QueryState query={query}>
        {allowed.length ? (
          allowed.map((p) => (
            <div className="st-row od-row" key={p.toolId}>
              <span className="od-field od-fill">
                <span className="st-row-name">{p.label}</span>
                <span className="st-row-help">
                  {{ computer: "Computador", app: "App", mcp: "Servidor MCP" }[p.group]} ·{" "}
                  {p.agentId
                    ? (agents.find((agent) => agent.id === p.agentId)?.name ?? p.agentId)
                    : "Todos os bots"}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy === p.toolId}
                onClick={async () => {
                  setBusy(p.toolId);
                  setError("");
                  try {
                    query.setData(
                      await client.request("tools.permissions.set", {
                        toolId: p.toolId,
                        level: "ask",
                      }),
                    );
                  } catch {
                    setError("Não foi possível revogar a permissão.");
                    toast("Não foi possível revogar a permissão.");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Revogar
              </button>
            </div>
          ))
        ) : (
          <p className="st-empty">Nenhuma ferramenta liberada em todas as sessões ainda.</p>
        )}
      </QueryState>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
