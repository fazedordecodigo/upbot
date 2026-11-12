import type {
  Agent,
  Collaboration,
  CollaborationMessage,
  CollaborationPhase,
} from "@boto/protocol";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/icons";
import { useToast } from "../ui/Toast";
import "./CollaborationView.css";

const PHASES: CollaborationPhase[] = ["entender", "investigar", "corrigir", "verificar", "avisar"];
const PHASE_LABELS: Record<CollaborationPhase, string> = {
  entender: "Entender",
  investigar: "Investigar",
  corrigir: "Corrigir",
  verificar: "Verificar",
  avisar: "Avisar",
};
const STATUS_LABELS: Record<Collaboration["status"], string> = {
  active: "Ativa",
  paused: "Pausada",
  done: "Concluída",
  stopped: "Encerrada",
};

function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}min` : ""}`;
}

type GraphNode = { key: string; label: string; x: number; y: number; leader: boolean };
type GraphEdge = { a: string; b: string; count: number };

function ConversationGraph({
  collab,
  messages,
  nameOf,
  selected,
  onSelect,
}: {
  collab: Collaboration;
  messages: CollaborationMessage[];
  nameOf: (agentId: string | null) => string;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const members = collab.members.filter((m) => m.role !== "leader");
  const cx = 160;
  const cy = 120;
  const radius = 78;
  const nodes: GraphNode[] = [
    { key: collab.leaderId, label: nameOf(collab.leaderId), x: cx, y: cy, leader: true },
    ...members.map((m, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(members.length, 1);
      return {
        key: m.agentId,
        label: nameOf(m.agentId),
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        leader: false,
      };
    }),
    { key: "user", label: "Você", x: cx, y: cy + radius + 34, leader: false },
  ];
  const pos = new Map(nodes.map((n) => [n.key, n]));
  const edges = useMemo(() => {
    const counts = new Map<string, GraphEdge>();
    for (const m of messages) {
      if (m.kind !== "message" && m.kind !== "request" && m.kind !== "instruction") continue;
      const a = m.fromAgentId ?? "user";
      const b = m.toAgentId ?? "user";
      const key = [a, b].sort().join("|");
      const edge = counts.get(key) ?? { a, b, count: 0 };
      edge.count += 1;
      counts.set(key, edge);
    }
    return [...counts.values()];
  }, [messages]);
  const byKey = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
  for (const e of edges) {
    const pa = pos.get(e.a);
    const pb = pos.get(e.b);
    if (pa && pb)
      byKey.set([e.a, e.b].sort().join("|"), { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y });
  }
  return (
    <svg
      className="cb-graph"
      viewBox="0 0 320 240"
      role="img"
      aria-label="Grafo da conversa entre os bots da mesa"
    >
      {edges.map((e) => {
        const key = [e.a, e.b].sort().join("|");
        const line = byKey.get(key);
        if (!line) return null;
        const mx = (line.x1 + line.x2) / 2;
        const my = (line.y1 + line.y2) / 2;
        const dim = selected !== null && e.a !== selected && e.b !== selected;
        return (
          <g key={key} className={dim ? "cb-edge dim" : "cb-edge"}>
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
            <text x={mx} y={my - 3} textAnchor="middle">
              {e.count}
            </text>
          </g>
        );
      })}
      {nodes.map((n) => (
        // biome-ignore lint/a11y/useSemanticElements: SVG graph node; button role with keyboard toggle.
        <g
          key={n.key}
          role="button"
          tabIndex={0}
          aria-label={`${n.label}${selected === n.key ? ", filtrando a conversa" : ""}`}
          aria-pressed={selected === n.key}
          className={[
            "cb-node",
            n.leader ? "leader" : "",
            selected === n.key ? "selected" : "",
            selected !== null && selected !== n.key ? "dim" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onSelect(selected === n.key ? null : n.key)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(selected === n.key ? null : n.key);
            }
          }}
        >
          <circle cx={n.x} cy={n.y} r={n.leader ? 22 : 16} />
          <text x={n.x} y={n.y + (n.leader ? 4 : 30)} textAnchor="middle">
            {n.leader ? "★" : n.label.slice(0, 2)}
          </text>
          {!n.leader && (
            <text className="cb-node-label" x={n.x} y={n.y + 42} textAnchor="middle">
              {n.label}
            </text>
          )}
          {n.leader && (
            <text className="cb-node-label" x={n.x} y={n.y + 34} textAnchor="middle">
              {n.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function NewTableDialog({
  open,
  agents,
  onClose,
  onCreate,
}: {
  open: boolean;
  agents: Agent[];
  onClose: () => void;
  onCreate: (
    problem: string,
    memberIds: string[],
    leaderId: string,
    title?: string,
  ) => Promise<void>;
}) {
  const [problem, setProblem] = useState("");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [leaderId, setLeaderId] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!open) {
      setProblem("");
      setTitle("");
      setPicked(new Set());
      setLeaderId("");
      setBusy(false);
    }
  }, [open]);
  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 8) next.add(id);
      return next;
    });
  };
  const submit = async () => {
    setBusy(true);
    try {
      await onCreate(problem.trim(), [...picked], leaderId, title.trim() || undefined);
      onClose();
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const ready = problem.trim().length > 0 && picked.size >= 2 && leaderId && picked.has(leaderId);
  return (
    <Dialog open={open} onClose={onClose} className="cb-new-dialog" aria-labelledby="cb-new-title">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="cb-new-title">Nova mesa</h2>
        <p className="cb-new-sub">
          Um bot líder reúne outros bots para conversar par-a-par e resolver um problema.
        </p>
        <label className="od-field">
          <span>Problema</span>
          <textarea
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            rows={4}
            maxLength={20000}
            placeholder="Descreva o problema que a mesa deve resolver…"
            required
          />
        </label>
        <label className="od-field">
          <span>Título (opcional)</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            placeholder="Nome da mesa"
          />
        </label>
        <fieldset className="cb-new-bots">
          <legend>Bots na mesa (2–8, incluindo o líder)</legend>
          {agents.map((agent) => (
            <label key={agent.id} className="cb-new-bot od-row">
              <input
                type="checkbox"
                checked={picked.has(agent.id)}
                onChange={() => toggle(agent.id)}
              />
              <span className="od-fill">{agent.name}</span>
            </label>
          ))}
          {!agents.length && <p className="cb-new-sub">Crie um bot antes de abrir uma mesa.</p>}
        </fieldset>
        <label className="od-field">
          <span>Líder</span>
          <select value={leaderId} onChange={(event) => setLeaderId(event.target.value)} required>
            <option value="">Escolher…</option>
            {[...picked].map((id) => (
              <option key={id} value={id}>
                {agents.find((a) => a.id === id)?.name ?? id}
              </option>
            ))}
          </select>
        </label>
        <div className="cb-new-actions od-row">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <span className="od-fill" />
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? "Abrindo…" : "Abrir mesa"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TablePanel({ id }: { id: string }) {
  const { client, agents } = useDaemon();
  const toast = useToast();
  const confirm = useConfirm();
  const history = useDaemonQuery(
    client,
    "collaborations.history",
    { id },
    {
      events: {
        "collaboration.updated": (c) => c.id === id,
        "collaboration.message": (m) => m.collaborationId === id,
      },
    },
  );
  const collab = history.data?.collaboration;
  const all = useMemo(() => history.data?.messages ?? [], [history.data]);
  const [filterNode, setFilterNode] = useState<string | null>(null);
  const [replay, setReplay] = useState<null | { speed: 1 | 2; startedAt: number; base: number }>(
    null,
  );
  const [replayNow, setReplayNow] = useState(0);
  const [instruct, setInstruct] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const streamRef = useRef<HTMLDivElement>(null);

  const nameOf = useCallback(
    (agentId: string | null) => {
      if (agentId === null) return "Você";
      return agents.find((a) => a.id === agentId)?.name ?? "bot removido";
    },
    [agents],
  );

  useEffect(() => {
    if (!replay) return;
    const timer = setInterval(() => setReplayNow(Date.now()), 120);
    return () => clearInterval(timer);
  }, [replay]);

  const first = all[0]?.createdAt;
  const messages = useMemo(() => {
    if (!replay || first === undefined) return all;
    const cutoff = first + (replayNow - replay.startedAt) * replay.speed;
    return all.filter((m) => m.createdAt <= cutoff);
  }, [all, replay, replayNow, first]);

  const visible = useMemo(() => {
    if (!filterNode) return messages;
    return messages.filter((m) => {
      const a = m.fromAgentId ?? "user";
      const b = m.toAgentId ?? "user";
      return a === filterNode || b === filterNode;
    });
  }, [messages, filterNode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom whenever the visible set changes.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const pending = messages.filter((m) => m.kind === "request" && m.answeredAt === null);

  const send = async (
    method:
      | "collaborations.pause"
      | "collaborations.resume"
      | "collaborations.stop"
      | "collaborations.instruct"
      | "collaborations.answer",
    params: { id: string; messageId?: string; text?: string },
  ) => {
    try {
      await client.request(method, params as never);
    } catch (error) {
      toast(errorMessage(error));
    }
  };

  if (history.error)
    return (
      <p className="cb-empty">
        Não consegui carregar a mesa. {history.error}{" "}
        <button type="button" className="btn btn-outline btn-sm" onClick={history.reload}>
          Tentar de novo
        </button>
      </p>
    );
  if (!collab) return <p className="cb-empty">Carregando mesa…</p>;

  const live = collab.status === "active";
  const running = collab.status === "active" || collab.status === "paused";

  return (
    <div className="cb-panel">
      <div className="cb-head od-row">
        <div className="od-field od-fill">
          <h2 className="cb-title od-truncate" title={collab.title}>
            {collab.title}
          </h2>
          <p className="cb-problem">{collab.problem}</p>
        </div>
        <div className="cb-controls od-row">
          <span
            className="status"
            data-tone={live ? "run" : collab.status === "done" ? "done" : "muted"}
          >
            {STATUS_LABELS[collab.status]}
          </span>
          {live && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void send("collaborations.pause", { id })}
            >
              <Icon name="pause" /> Pausar
            </button>
          )}
          {collab.status === "paused" && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void send("collaborations.resume", { id })}
            >
              <Icon name="play" /> Retomar
            </button>
          )}
          {running && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Encerrar a mesa?",
                    description:
                      "A mesa para de vez e não pode ser retomada. O que já foi discutido fica no histórico.",
                    action: "Encerrar mesa",
                  })
                )
                  await send("collaborations.stop", { id });
              }}
            >
              <Icon name="circle-slash" /> Encerrar
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm ${replay ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={replay !== null}
            onClick={() =>
              setReplay((r) => (r ? null : { speed: 1, startedAt: Date.now(), base: 0 }))
            }
            data-tip="Rever a conversa na cadência original"
          >
            <Icon name="repeat" /> Replay
          </button>
          {replay && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setReplay({ speed: 2, startedAt: Date.now(), base: 0 })}
                data-tip="Rever em velocidade dupla"
              >
                2x
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setReplay({ speed: 1, startedAt: Date.now(), base: 0 })}
                data-tip="Reiniciar replay"
              >
                <Icon name="refresh-cw" />
              </button>
            </>
          )}
        </div>
      </div>

      <ol className="cb-phases od-row" aria-label="Fase da mesa">
        {PHASES.map((phase, i) => {
          const current = PHASES.indexOf(collab.phase);
          return (
            <li
              key={phase}
              className="cb-phase"
              data-state={i < current ? "done" : i === current ? "current" : "next"}
            >
              {PHASE_LABELS[phase]}
            </li>
          );
        })}
      </ol>

      <dl className="cb-stats od-row">
        <div>
          <dt>Na mesa</dt>
          <dd>{collab.stats.members}</dd>
        </div>
        <div>
          <dt>Mensagens trocadas</dt>
          <dd>{collab.stats.messages}</dd>
        </div>
        <div>
          <dt>Ações no computador</dt>
          <dd>{collab.stats.actions}</dd>
        </div>
        <div>
          <dt>Tempo de discussão</dt>
          <dd>{elapsed(collab.stats.elapsedMs)}</dd>
        </div>
      </dl>

      <div className="cb-body">
        <ConversationGraph
          collab={collab}
          messages={messages}
          nameOf={nameOf}
          selected={filterNode}
          onSelect={setFilterNode}
        />
        <section className="cb-stream-wrap" aria-label="Conversa da mesa">
          <div className="cb-stream" ref={streamRef}>
            {visible.map((m) => {
              if (m.kind === "system" || m.kind === "phase")
                return (
                  <p key={m.id} className="cb-note">
                    {m.text}
                  </p>
                );
              const from = nameOf(m.fromAgentId);
              const to = m.toAgentId === null ? "Você" : nameOf(m.toAgentId);
              const directed = m.kind === "message" || m.kind === "request";
              return (
                <article key={m.id} className={`cb-msg cb-${m.kind}`}>
                  <header>
                    <strong>{from}</strong>
                    {directed && (
                      <>
                        {" → "}
                        <strong>{to}</strong>
                      </>
                    )}
                    <span className="cb-msg-kind">
                      {m.kind === "summary"
                        ? "Resumo"
                        : m.kind === "instruction"
                          ? "Instrução"
                          : m.kind === "request"
                            ? "Pergunta"
                            : ""}
                    </span>
                  </header>
                  <p>{m.text}</p>
                  {m.kind === "request" && m.answeredAt === null && (
                    <form
                      className="cb-answer od-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const text = (answers[m.id] ?? "").trim();
                        if (!text) return;
                        setAnswers((a) => ({ ...a, [m.id]: "" }));
                        void send("collaborations.answer", { id, messageId: m.id, text });
                      }}
                    >
                      <input
                        className="od-fill"
                        value={answers[m.id] ?? ""}
                        onChange={(event) =>
                          setAnswers((a) => ({ ...a, [m.id]: event.target.value }))
                        }
                        placeholder={`Responder para ${from}…`}
                      />
                      <button type="submit" className="btn btn-primary btn-sm">
                        Responder
                      </button>
                    </form>
                  )}
                  {m.kind === "request" && m.answeredAt !== null && (
                    <footer className="cb-answered">Respondida</footer>
                  )}
                </article>
              );
            })}
            {!visible.length && <p className="cb-empty">Nada por aqui ainda.</p>}
          </div>
          {pending.length > 0 && (
            <p className="cb-pending">
              {pending.length} {pending.length === 1 ? "pergunta esperando" : "perguntas esperando"}{" "}
              sua resposta
            </p>
          )}
          <form
            className="cb-instruct od-row"
            onSubmit={(event) => {
              event.preventDefault();
              const text = instruct.trim();
              if (!text) return;
              setInstruct("");
              void send("collaborations.instruct", { id, text });
            }}
          >
            <input
              className="od-fill"
              value={instruct}
              onChange={(event) => setInstruct(event.target.value)}
              placeholder="Instrução para a mesa…"
              disabled={!live}
            />
            <button
              type="submit"
              className="btn btn-outline btn-sm"
              disabled={!live || !instruct.trim()}
            >
              <Icon name="send" />
            </button>
          </form>
          <p className="cb-instruct-hint">O Boto repassa a instrução para o líder da mesa.</p>
        </section>
      </div>
    </div>
  );
}

export function CollaborationView() {
  const { client, ready, agents } = useDaemon();
  const toast = useToast();
  const list = useDaemonQuery(
    client,
    "collaborations.list",
    {},
    {
      enabled: ready,
      events: {
        "collaboration.created": true,
        "collaboration.updated": true,
      },
    },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const done = list.data ?? [];
  const current = selectedId ?? done.find((c) => c.status === "active")?.id ?? done[0]?.id ?? null;
  const seenDone = useRef<Set<string>>(new Set());

  // Conclusion notification: a table transitioning to done posts a native
  // notification once per table per app session.
  useEffect(() => {
    const off = client.on("collaboration.updated", (c) => {
      if (c.status !== "done" || seenDone.current.has(c.id)) return;
      seenDone.current.add(c.id);
      const body = `A mesa “${c.title}” concluiu a discussão.`;
      if ("__TAURI_INTERNALS__" in window) {
        void invoke("notifications_post", {
          notification: {
            id: `collab-${c.id}`,
            title: "Mesa concluída",
            body,
            actions: [],
            muted: false,
          },
        }).catch(() => {});
      }
      toast(body);
    });
    return off;
  }, [client, toast]);

  const create = async (problem: string, memberIds: string[], leaderId: string, title?: string) => {
    const c = await client.request("collaborations.create", {
      problem,
      memberIds,
      leaderId,
      ...(title ? { title } : {}),
    });
    setSelectedId(c.id);
  };

  return (
    <section
      className="view collaboration od-scroll"
      id="view-collaboration"
      aria-labelledby="collaboration-title"
    >
      <div className="page-inner">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="collaboration-title" tabIndex={-1}>
              Colaboração
            </h1>
            <p className="page-sub">
              Mesas onde um bot líder reúne outros bots para conversar par-a-par e resolver um
              problema.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            data-action="new-collaboration"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
            Nova mesa
          </button>
        </div>

        {list.loaded && done.length > 1 && (
          <div className="cb-chips od-row" role="tablist" aria-label="Mesas">
            {done.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === current}
                className="cb-chip"
                data-tone={c.status}
                onClick={() => setSelectedId(c.id)}
              >
                {c.title}
              </button>
            ))}
          </div>
        )}

        {list.error && (
          <p className="cb-empty">
            Não consegui carregar as mesas. {list.error}{" "}
            <button type="button" className="btn btn-outline btn-sm" onClick={list.reload}>
              Tentar de novo
            </button>
          </p>
        )}
        {!list.error && !list.loaded && <p className="cb-empty">Carregando…</p>}
        {!list.error && list.loaded && !done.length && (
          <div className="cb-empty-state">
            <Icon name="network" />
            <p>
              Nenhuma mesa ainda. Abra uma <strong>Nova mesa</strong> ou peça para um bot reunir a
              equipe.
            </p>
          </div>
        )}
        {current && <TablePanel key={current} id={current} />}
      </div>

      <NewTableDialog
        open={creating}
        agents={agents}
        onClose={() => setCreating(false)}
        onCreate={create}
      />
    </section>
  );
}
