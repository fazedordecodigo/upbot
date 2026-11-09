import type { Agent, MethodResult } from "@boto/protocol";
import { useCallback, useEffect, useState } from "react";
import { useDaemon } from "../shell/daemon";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import { BlockHead, QueryState } from "./QueryState";

function MemoryRow({
  memory,
  agent,
  reload,
}: {
  memory: MethodResult<"memories.list">[number];
  agent: Agent;
  reload: () => void;
}) {
  const { client } = useDaemon();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutate = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (remove) await client.request("memories.delete", { id: memory.id });
      else await client.request("memories.update", { id: memory.id, text });
      setConfirm(false);
      setEditing(false);
      reload();
    } catch {
      setError("Não foi possível atualizar a memória.");
      toast("Não foi possível atualizar a memória.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="st-row od-row" aria-busy={busy}>
      <div className="od-field od-fill">
        {editing ? (
          <textarea
            className="textarea"
            aria-label="Texto da memória"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        ) : (
          <span>{memory.text}</span>
        )}
        <span className="st-row-help">{agent.name}</span>
        {error && (
          <p className="st-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {editing ? (
        <>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={busy || !text.trim()}
            onClick={() => void mutate(false)}
          >
            Salvar
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setText(memory.text);
              setEditing(false);
            }}
          >
            Cancelar
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Editar"
            onClick={() => setEditing(true)}
          >
            <Icon name="file-text" />
            Editar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Apagar"
            onClick={() => setConfirm(true)}
          >
            <Icon name="trash" />
            Apagar
          </button>
        </>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        aria-labelledby={`delete-${memory.id}`}
      >
        <div className="dialog-header">
          <h2 id={`delete-${memory.id}`}>Apagar memória?</h2>
          <p>Esta memória será apagada das próximas sessões do agente.</p>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-outline" onClick={() => setConfirm(false)}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-destructive"
            disabled={busy}
            onClick={() => void mutate(true)}
          >
            Apagar
          </button>
        </div>
      </Dialog>
    </li>
  );
}

export function Memories() {
  const { agents, client, ready } = useDaemon();
  const [rows, setRows] = useState<{ agent: Agent; memories: MethodResult<"memories.list"> }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates the collection after a memory event or mutation.
  useEffect(() => {
    let active = true;
    if (!ready) {
      setLoaded(false);
      return;
    }
    void Promise.all(
      agents.map(async (agent) => ({
        agent,
        memories: await client.request("memories.list", { agentId: agent.id }),
      })),
    )
      .then((result) => {
        if (active) {
          setRows(result);
          setLoaded(true);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError("Não foi possível carregar as memórias.");
      });
    return () => {
      active = false;
    };
  }, [agents, client, ready, revision]);
  useEffect(() => {
    const off = client.on("memories.changed", (event) => {
      if (agents.some((agent) => agent.id === event.agentId)) reload();
    });
    const reconnect = client.onReconnect(reload);
    return () => {
      off();
      reconnect();
    };
  }, [client, agents, reload]);
  return (
    <div className="st-block">
      <BlockHead
        title="Memórias dos agentes"
        description="O que cada agente guardou para lembrar nas próximas sessões. Edite ou apague o que não estiver certo."
      />
      <div id="st-memories" aria-busy={!loaded && !error}>
        <QueryState query={{ loaded, error, reload }}>
          {rows.some((row) => row.memories.length) ? (
            <ul className="st-list">
              {rows.flatMap(({ agent, memories }) =>
                memories.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} agent={agent} reload={reload} />
                )),
              )}
            </ul>
          ) : (
            <p className="st-empty">Nenhum agente guardou memórias ainda.</p>
          )}
        </QueryState>
      </div>
    </div>
  );
}
