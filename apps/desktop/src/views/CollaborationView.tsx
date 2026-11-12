import type {
  Agent,
  Approval,
  Collaboration,
  CollaborationMessage,
  CollaborationPhase,
} from "@boto/protocol";
import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "../dialogs/ConfirmDialog";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import {
  filterTables,
  isLiveTable,
  type TableFilter,
  type TablePending,
  tablePendencies,
} from "../lib/collaboration-tables";
import { mergeTimeline } from "../lib/collaboration-timeline";
import { errorMessage } from "../lib/errors";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Dropdown, DropdownItem } from "../ui/Dropdown";
import { Icon, type IconName } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
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
const FILTERS: { key: TableFilter; label: string }[] = [
  { key: "todas", label: "Todas" },
  { key: "aguardando", label: "Aguardando você" },
  { key: "discussao", label: "Em discussão" },
  { key: "resolvidas", label: "Resolvidas" },
];

function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}min` : ""}`;
}

/** Compact mark for avatars: emoji text, a sprite icon, mono letters or "you". */
type Mark =
  | { t: "emoji"; s: string; c: string | null }
  | { t: "icon"; n: IconName }
  | { t: "mono"; s: string }
  | { t: "user" };

const AGENT_ICON_MARK: Record<string, IconName> = {
  sym: "monitor",
  mail: "mail",
  receipt: "file-text",
  plane: "globe",
  chart: "list-checks",
  cal: "calendar",
  sheet: "file-text",
};

function agentMark(agents: Agent[], agentId: string | null, fallback: string): Mark {
  if (agentId === null) return { t: "user" };
  const avatar = agents.find((a) => a.id === agentId)?.avatar ?? null;
  if (avatar && "emoji" in avatar) return { t: "emoji", s: avatar.emoji, c: avatar.color };
  if (avatar && "icon" in avatar)
    return { t: "icon", n: AGENT_ICON_MARK[avatar.icon] ?? "monitor" };
  return { t: "mono", s: fallback.slice(0, 2) };
}

/** Person glyph used for "Você" inside SVG graphs and the rail avatar marks. */
function PersonGlyph() {
  return (
    <svg className="cb-person" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5" r="2.7" />
      <path d="M2.8 13.4c.3-2.9 2.4-4.5 5.2-4.5s4.9 1.6 5.2 4.5" />
    </svg>
  );
}

/** Small avatar chip used in the rail header stack and message headers. */
function AvatarChip({ mark, title }: { mark: Mark; title: string }) {
  return (
    <span
      className={`cb-av${mark.t === "user" ? " cb-av-user" : ""}`}
      title={title}
      role="img"
      aria-label={title}
      style={mark.t === "emoji" && mark.c ? { background: mark.c } : undefined}
    >
      {mark.t === "emoji" || mark.t === "mono" ? (
        mark.s
      ) : mark.t === "icon" ? (
        <Icon name={mark.n} />
      ) : (
        <PersonGlyph />
      )}
    </span>
  );
}

type GraphNode = {
  key: string;
  label: string;
  sub: string;
  alert: boolean;
  mark: Mark;
  x: number;
  y: number;
  r: number;
  leader: boolean;
  user: boolean;
};
/** "request" = pedido para você; "you" = troca com você; "bots" = bot↔bot. */
type GraphEdge = { a: string; b: string; count: number; kind: "bots" | "you" | "request" };

/** Posições dos membros em graus (sentido horário a partir do alto à esquerda);
 * o setor de baixo fica livre para o "Você". */
const MEMBER_ANGLES: Record<number, readonly number[]> = {
  1: [-90],
  2: [-135, -45],
  3: [-90, 15, 165],
  4: [-147, -33, 21, 159],
  5: [-158, -90, -22, 22, 158],
  6: [-158, -110, -62, -20, 28, 152],
  7: [-160, -120, -80, -40, -5, 30, 155],
  8: [-162, -130, -98, -66, -34, -2, 30, 158],
};
/** Anéis decorativos atrás do grafo, centrados no líder. */
const ORBITS: readonly { rx: number; ry: number }[] = [
  { rx: 88, ry: 46 },
  { rx: 152, ry: 94 },
  { rx: 213, ry: 131 },
];
/** Janela em ms em que uma conexão fica "viva" depois de passar mensagem. */
const EDGE_LIVE_MS = 2800;
const BOTO_MARK_D =
  "M20 43C14 34 20 6 40 6C52 6 60 16 60 28C60 41 50 50 38 50L28 50C21 50 14 54 8 57.6C6.4 58.5 5.2 56.6 6.6 55.5C10.5 52.5 15.5 47.5 20 43ZM26.2 38a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0-5.6 0Z";

function GraphMark({ node }: { node: GraphNode }) {
  const m = node.mark;
  if (m.t === "icon")
    return (
      <use
        href={`/assets/icons.svg#i-${m.n}`}
        width={node.leader ? 22 : 18}
        height={node.leader ? 22 : 18}
        x={node.x - (node.leader ? 11 : 9)}
        y={node.y - (node.leader ? 11 : 9)}
      />
    );
  if (m.t === "user")
    return (
      <g className="cb-node-person" transform={`translate(${node.x - 8}, ${node.y - 8}) scale(1)`}>
        <circle cx="8" cy="5" r="2.7" />
        <path d="M2.8 13.4c.3-2.9 2.4-4.5 5.2-4.5s4.9 1.6 5.2 4.5" />
      </g>
    );
  if (node.leader && m.t === "mono")
    return (
      <path
        className="cb-boto-mark"
        fillRule="evenodd"
        transform={`translate(${node.x - 16}, ${node.y - 16}) scale(0.5)`}
        d={BOTO_MARK_D}
      />
    );
  return (
    <text className="cb-node-mark" x={node.x} y={node.y + 5} textAnchor="middle">
      {m.s}
    </text>
  );
}

function ConversationGraph({
  collab,
  messages,
  agents,
  nameOf,
  selected,
  onSelect,
  waiting,
  pendingApprovals,
  onShowPendency,
}: {
  collab: Collaboration;
  messages: CollaborationMessage[];
  agents: Agent[];
  nameOf: (agentId: string | null) => string;
  selected: string | null;
  onSelect: (key: string | null) => void;
  waiting: boolean;
  pendingApprovals: Approval[];
  onShowPendency: () => void;
}) {
  const members = collab.members.filter((m) => m.role !== "leader");
  const cx = 280;
  const cy = 190;
  const orbit = 176;
  const angles =
    MEMBER_ANGLES[members.length] ??
    members.map((_, i) => -90 - 180 / Math.max(members.length, 1) + (360 / members.length) * i);
  const nodes: GraphNode[] = [
    {
      key: collab.leaderId,
      label: nameOf(collab.leaderId),
      sub: waiting ? "esperando você" : "coordena a mesa",
      alert: waiting,
      mark: agentMark(agents, collab.leaderId, "★"),
      x: cx,
      y: cy,
      r: 28,
      leader: true,
      user: false,
    },
    ...members.map((m, i) => {
      const angle = ((angles[i] ?? -90) * Math.PI) / 180;
      const label = nameOf(m.agentId);
      return {
        key: m.agentId,
        label,
        sub: "na mesa",
        alert: false,
        mark: agentMark(agents, m.agentId, label),
        x: cx + orbit * Math.cos(angle),
        y: cy + orbit * Math.sin(angle),
        r: 22,
        leader: false,
        user: false,
      };
    }),
    {
      key: "user",
      label: "Você",
      sub: waiting ? "sua vez" : "na mesa",
      alert: waiting,
      mark: { t: "user" },
      x: cx,
      y: cy + 170,
      r: 17,
      leader: false,
      user: true,
    },
  ];
  const pos = new Map(nodes.map((n) => [n.key, n]));
  const { edges, lastByEdge } = useMemo(() => {
    const counts = new Map<string, GraphEdge & { requests: number; yours: number }>();
    const last = new Map<string, { id: string; seq: number; from: string; to: string }>();
    for (const m of messages) {
      if (m.kind !== "message" && m.kind !== "request" && m.kind !== "instruction") continue;
      const a = m.fromAgentId ?? "user";
      const b = m.toAgentId ?? "user";
      const key = [a, b].sort().join("|");
      const edge = counts.get(key) ?? { a, b, count: 0, requests: 0, yours: 0, kind: "bots" };
      edge.count += 1;
      if (m.kind === "request") edge.requests += 1;
      if (a === "user" || b === "user") edge.yours += 1;
      counts.set(key, edge);
      const prev = last.get(key);
      if (!prev || m.seq >= prev.seq) last.set(key, { id: m.id, seq: m.seq, from: a, to: b });
    }
    return {
      edges: [...counts.values()].map(({ requests, yours, ...e }) => ({
        ...e,
        kind: requests > 0 ? "request" : yours > 0 ? "you" : "bots",
      })),
      lastByEdge: last,
    };
  }, [messages]);
  // Conexões "vivas": arestas que receberam mensagem nos últimos EDGE_LIVE_MS.
  // O primeiro render só semeia os ids — o histórico não pisca ao abrir a mesa.
  const seenRef = useRef(new Map<string, { id: string; seenAt: number }>());
  const seededRef = useRef(false);
  const liveByEdge = useMemo(() => {
    const now = Date.now();
    const seeding = !seededRef.current;
    seededRef.current = true;
    const seen = seenRef.current;
    const live = new Map<string, { id: string; from: string; to: string }>();
    for (const [key, v] of lastByEdge) {
      if (seen.get(key)?.id !== v.id) seen.set(key, { id: v.id, seenAt: seeding ? 0 : now });
      if (seeding) continue;
      if (now - (seen.get(key)?.seenAt ?? 0) <= EDGE_LIVE_MS) live.set(key, v);
    }
    return live;
  }, [lastByEdge]);
  const maxCount = Math.max(1, ...edges.map((e) => e.count));
  const byKey = new Map<string, { x1: number; y1: number; x2: number; y2: number }>();
  for (const e of edges) {
    const pa = pos.get(e.a);
    const pb = pos.get(e.b);
    if (pa && pb)
      byKey.set([e.a, e.b].sort().join("|"), { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y });
  }
  const chipEdgeCount = new Map<string, number>();
  const chips = pendingApprovals.flatMap((a) => {
    const requester = pos.has(a.agentId) ? a.agentId : collab.leaderId;
    const toKey = requester === collab.leaderId ? "user" : collab.leaderId;
    const from = pos.get(requester);
    const to = pos.get(toKey);
    if (!from || !to) return [];
    const edgeKey = `${requester}|${toKey}`;
    const n = chipEdgeCount.get(edgeKey) ?? 0;
    chipEdgeCount.set(edgeKey, n + 1);
    const t = Math.min(0.42 + n * 0.24, 0.85);
    const label = a.title.length > 18 ? `${a.title.slice(0, 17)}…` : a.title;
    return [
      {
        key: a.id,
        from: requester,
        to: toKey,
        label,
        w: label.length * 5.2 + 14,
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      },
    ];
  });
  return (
    <figure className="cb-graph-wrap">
      <svg
        className="cb-graph"
        viewBox="0 0 560 430"
        role="img"
        aria-label="Grafo da conversa entre os bots da mesa"
      >
        <g className="cb-orbits">
          {ORBITS.map((o) => (
            <ellipse key={`${o.rx}x${o.ry}`} cx={cx} cy={cy} rx={o.rx} ry={o.ry} />
          ))}
        </g>
        {edges.map((e) => {
          const key = [e.a, e.b].sort().join("|");
          const line = byKey.get(key);
          if (!line) return null;
          const dim = selected !== null && e.a !== selected && e.b !== selected;
          const live = dim ? undefined : liveByEdge.get(key);
          const from = live ? pos.get(live.from) : undefined;
          const to = live ? pos.get(live.to) : undefined;
          const width = 1 + (e.count / maxCount) * 3.2;
          return (
            <g key={key} className={`cb-edge cb-edge-${e.kind}${dim ? " dim" : ""}`}>
              <line
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                strokeWidth={width}
                style={{ opacity: dim ? undefined : 0.3 + 0.7 * (e.count / maxCount) }}
              />
              {live && from && to ? (
                <g className="cb-edge-anim" key={live.id}>
                  <line
                    className="cb-edge-boost"
                    x1={line.x1}
                    y1={line.y1}
                    x2={line.x2}
                    y2={line.y2}
                    strokeWidth={width + 3}
                  />
                  <line
                    className="cb-edge-flow"
                    x1={line.x1}
                    y1={line.y1}
                    x2={line.x2}
                    y2={line.y2}
                  />
                  <circle className="cb-edge-pulse" r={3.4}>
                    <animateMotion
                      dur="0.9s"
                      repeatCount="1"
                      fill="freeze"
                      path={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
                    />
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.12;0.7;1"
                      dur="0.9s"
                      repeatCount="1"
                      fill="freeze"
                    />
                  </circle>
                </g>
              ) : null}
            </g>
          );
        })}
        {chips.map((chip) => {
          const dim = selected !== null && selected !== chip.from && selected !== chip.to;
          return (
            <g
              key={chip.key}
              className={`cb-edge-chip${dim ? " dim" : ""}`}
              transform={`translate(${chip.x}, ${chip.y})`}
            >
              <rect x={-chip.w / 2} y={-9} width={chip.w} height={18} rx={9} />
              <text y={3.2} textAnchor="middle">
                {chip.label}
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
              n.user ? "user" : "",
              n.alert ? "alert" : "",
              waiting && n.user ? "waiting" : "",
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
            {n.leader || (n.user && waiting) ? (
              <circle className="cb-node-halo" cx={n.x} cy={n.y} r={n.r + 6} />
            ) : null}
            <circle className="cb-node-disc" cx={n.x} cy={n.y} r={n.r} />
            <GraphMark node={n} />
            <text
              className="cb-node-label"
              x={n.x}
              y={n.y + n.r + (n.user ? 24 : 15)}
              textAnchor="middle"
            >
              {n.label}
            </text>
            <text
              className="cb-node-sub"
              x={n.x}
              y={n.y + n.r + (n.user ? 38 : 29)}
              textAnchor="middle"
            >
              {n.sub}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="cb-legend">
        <div className="cb-legend-note od-row">
          <span className={waiting ? "cb-legend-alert" : undefined}>
            <Icon name={waiting ? "circle-alert" : "info"} />
            {waiting
              ? pendingApprovals.length > 0
                ? "A mesa espera a sua resposta ao pedido de aprovação."
                : "A mesa espera a sua resposta."
              : "A conversa avança por conta própria — você entra quando é chamado."}
          </span>
          {waiting && (
            <button type="button" className="cb-legend-link" onClick={onShowPendency}>
              Ver o pedido
            </button>
          )}
        </div>
        <div className="cb-legend-items od-row">
          <span className="cb-legend-item">
            <i className="cb-legend-line cb-legend-thick" /> Linha mais grossa: mais mensagens entre
            os dois
          </span>
          <span className="cb-legend-item">
            <i className="cb-legend-line cb-edge-bots" /> Mensagem entre agentes
          </span>
          <span className="cb-legend-item">
            <i className="cb-legend-line cb-edge-request" /> Pedido para você
          </span>
        </div>
      </figcaption>
    </figure>
  );
}

const APPROVAL_STATUS_LABELS: Record<Exclude<Approval["status"], "pending">, string> = {
  approved: "Aprovado",
  denied: "Recusado",
  expired: "Expirou",
  done: "Concluída",
  interrupted: "Interrompida",
};

function TablePanel({
  id,
  focus,
  tabs,
}: {
  id: string;
  focus?: string | undefined;
  tabs?: ReactNode;
}) {
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
  const approvalsQuery = useDaemonQuery(
    client,
    "approvals.list",
    {},
    {
      events: { "approval.updated": true },
    },
  );
  const collab = history.data?.collaboration;
  const all = useMemo(() => history.data?.messages ?? [], [history.data]);
  const approvals = useMemo(() => approvalsQuery.data ?? [], [approvalsQuery.data]);
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
  const cutoff =
    replay && first !== undefined
      ? first + (replayNow - replay.startedAt) * replay.speed
      : Infinity;
  const messages = useMemo(() => all.filter((m) => m.createdAt <= cutoff), [all, cutoff]);
  const timeline = useMemo(
    () => mergeTimeline(messages, approvals, id).filter((i) => i.at <= cutoff),
    [messages, approvals, id, cutoff],
  );

  const visible = useMemo(() => {
    if (!filterNode) return timeline;
    return timeline.filter((item) => {
      if (item.kind === "approval") return item.approval.agentId === filterNode;
      const m = item.message;
      const a = m.fromAgentId ?? "user";
      const b = m.toAgentId ?? "user";
      return a === filterNode || b === filterNode;
    });
  }, [timeline, filterNode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom whenever the visible set changes.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  // "Ver o pedido" on a grid card lands here anchored at the pendency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor when the rendered set settles.
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`cb-item-${CSS.escape(focus)}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("cb-focused");
    return () => el.classList.remove("cb-focused");
  }, [focus, visible.length]);

  const pending = messages.filter((m) => m.kind === "request" && m.answeredAt === null);
  const pendingApprovals = approvals.filter(
    (a) => a.collaborationId === id && a.status === "pending",
  );

  const showPendency = () => {
    const first = timeline.find((item) => {
      if (item.kind === "approval") return item.approval.status === "pending";
      return item.message.kind === "request" && item.message.answeredAt === null;
    });
    if (!first) return;
    const el = document.getElementById(`cb-item-${CSS.escape(first.key)}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("cb-focused");
    setTimeout(() => el.classList.remove("cb-focused"), 2400);
  };

  const markOf = useCallback(
    (agentId: string | null, name: string) => agentMark(agents, agentId, name),
    [agents],
  );

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

  const respondApproval = async (approval: Approval, decision: "approve" | "deny") => {
    try {
      await client.request("approvals.respond", { id: approval.id, decision });
    } catch (error) {
      toast(errorMessage(error));
    }
  };

  if (history.error || !collab)
    return (
      <div className="cb-detail">
        <div className="cb-main">
          {tabs}
          <div className="cb-main-scroll od-scroll">
            <p className="cb-empty">
              {history.error ? (
                <>
                  Não consegui carregar a mesa. {history.error}{" "}
                  <button type="button" className="btn btn-outline btn-sm" onClick={history.reload}>
                    Tentar de novo
                  </button>
                </>
              ) : (
                "Carregando mesa…"
              )}
            </p>
          </div>
        </div>
      </div>
    );

  const live = collab.status === "active";
  const running = collab.status === "active" || collab.status === "paused";
  const phaseIndex = Math.max(0, PHASES.indexOf(collab.phase));
  const openedAt = new Date(collab.createdAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const modeMeta = [
    `${nameOf(collab.leaderId)} e ${collab.stats.members - 1} bots`,
    collab.topology === "hub" ? "Tudo passa pelo líder" : "Conversam direto entre si",
    collab.askExternal ? "Pede aprovação fora do Boto" : "Ações externas livres",
    collab.checkpointPhases ? "Etapas sob seu controle" : "Etapas seguem direto",
    collab.useMemory ? "Lembra de você" : "Não usa seu perfil",
    `Aberta às ${openedAt}`,
  ];

  const waiting = pending.length > 0 || pendingApprovals.length > 0 || collab.phasePending !== null;
  const timeStr = (at: number) =>
    new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const railMembers = collab.members;

  return (
    <div className="cb-detail">
      <div className="cb-main">
        {tabs}
        <div className="cb-main-scroll od-scroll">
          <div className="cb-panel">
            <header className="cb-head od-row">
              <div className="od-field od-fill">
                <p className="cb-eyebrow">Mesa de colaboração</p>
                <h2 className="cb-title" id="collaboration-title" title={collab.title}>
                  {collab.title}
                </h2>
                <p className="cb-mode">{modeMeta.join(" · ")}</p>
              </div>
              <div className="cb-controls od-row">
                {!live && (
                  <span className="status" data-tone={collab.status === "done" ? "done" : "muted"}>
                    {STATUS_LABELS[collab.status]}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  aria-pressed={replay?.speed === 1}
                  onClick={() =>
                    setReplay((r) =>
                      r?.speed === 1 ? null : { speed: 1, startedAt: Date.now(), base: 0 },
                    )
                  }
                  data-tip="Rever a conversa na cadência original"
                >
                  1x
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  aria-pressed={replay?.speed === 2}
                  onClick={() =>
                    setReplay((r) =>
                      r?.speed === 2 ? null : { speed: 2, startedAt: Date.now(), base: 0 },
                    )
                  }
                  data-tip="Rever a conversa em velocidade dupla"
                >
                  2x
                </button>
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
                  <Dropdown
                    align="end"
                    label="Mais ações da mesa"
                    trigger={
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label="Mais ações"
                      >
                        <Icon name="chevron-down" />
                      </button>
                    }
                  >
                    <DropdownItem
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
                      <Icon name="circle-slash" /> Encerrar a mesa
                    </DropdownItem>
                  </Dropdown>
                )}
              </div>
            </header>

            <section className="cb-problem" aria-labelledby={`cb-problem-${id}`}>
              <header className="od-row">
                <span className="cb-label" id={`cb-problem-${id}`}>
                  Problema
                </span>
                {waiting && (
                  <span className="cb-waiting">
                    <Icon name="circle-alert" /> Aguardando você
                  </span>
                )}
              </header>
              <p className="cb-problem-text">{collab.problem}</p>
              <div className="cb-phase-row od-row">
                <ol className="cb-phases od-row" aria-label="Fase da mesa">
                  {PHASES.map((phase, i) => (
                    <li
                      key={phase}
                      className="cb-phase"
                      data-state={i < phaseIndex ? "done" : i === phaseIndex ? "current" : "next"}
                    >
                      {PHASE_LABELS[phase]}
                    </li>
                  ))}
                </ol>
                <span className="cb-phase-n od-fill">
                  Etapa {phaseIndex + 1} de {PHASES.length}
                  {collab.phasePending ? " — aguardando você liberar" : ""}
                </span>
              </div>
            </section>

            <dl className="cb-stats">
              <div className="cb-stat">
                <dt>Na mesa</dt>
                <dd>{collab.stats.members}</dd>
              </div>
              <div className="cb-stat">
                <dt>Mensagens trocadas</dt>
                <dd>{collab.stats.messages}</dd>
              </div>
              <div className="cb-stat">
                <dt>Ações em andamento</dt>
                <dd>{collab.stats.actions}</dd>
              </div>
              <div className="cb-stat">
                <dt>Tempo de mesa</dt>
                <dd>{elapsed(collab.stats.elapsedMs)}</dd>
              </div>
            </dl>

            <section className="cb-graph-section" aria-labelledby={`cb-graph-${id}`}>
              <header className="cb-section-head od-row">
                <h3 id={`cb-graph-${id}`}>Grafo da conversa</h3>
                <span className="cb-hint">Selecione um agente para ver só as mensagens dele.</span>
              </header>
              <ConversationGraph
                collab={collab}
                messages={messages}
                agents={agents}
                nameOf={nameOf}
                selected={filterNode}
                onSelect={setFilterNode}
                waiting={waiting}
                pendingApprovals={pendingApprovals}
                onShowPendency={showPendency}
              />
            </section>
          </div>
        </div>
      </div>

      <aside className="cb-rail" aria-label="Conversa da mesa">
        <header className="cb-rail-head od-row">
          <h3 className="od-fill">Conversa</h3>
          <div className="cb-rail-stack" role="img" aria-label="Participantes da mesa">
            {railMembers.slice(0, 4).map((m) => {
              const name = nameOf(m.agentId);
              return <AvatarChip key={m.agentId} mark={markOf(m.agentId, name)} title={name} />;
            })}
            {railMembers.length > 4 && (
              <span className="cb-av cb-av-more">+{railMembers.length - 4}</span>
            )}
          </div>
        </header>
        <div className="cb-stream" ref={streamRef}>
          {visible.map((item) => {
            if (item.kind === "approval") {
              const a = item.approval;
              const aname = nameOf(a.agentId);
              return (
                <article
                  key={item.key}
                  id={`cb-item-${item.key}`}
                  className="cb-msg cb-approval"
                  data-status={a.status}
                >
                  <header className="cb-msg-head">
                    <AvatarChip mark={markOf(a.agentId, aname)} title={aname} />
                    <strong>{aname}</strong>
                    <time className="cb-msg-time" dateTime={new Date(a.createdAt).toISOString()}>
                      {timeStr(a.createdAt)}
                    </time>
                  </header>
                  <p className="cb-msg-kind">
                    {a.status === "pending" ? "Esperando sua aprovação" : "Aprovação"}
                  </p>
                  <p>
                    <strong>{a.title}</strong>
                  </p>
                  {a.detail && a.detail !== a.title && <p>{a.detail}</p>}
                  {a.status === "pending" ? (
                    <div className="cb-answer od-row">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void respondApproval(a, "approve")}
                      >
                        Aprovar
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void respondApproval(a, "deny")}
                      >
                        Agora não
                      </button>
                    </div>
                  ) : (
                    <footer className="cb-answered">
                      {APPROVAL_STATUS_LABELS[a.status as Exclude<Approval["status"], "pending">]}
                    </footer>
                  )}
                </article>
              );
            }
            const m = item.message;
            if (m.kind === "system" || m.kind === "phase")
              return (
                <p key={m.id} className="cb-note">
                  {m.text}
                </p>
              );
            const from = nameOf(m.fromAgentId);
            const to = m.toAgentId === null ? "Você" : nameOf(m.toAgentId);
            const directed = m.kind === "message" || m.kind === "request";
            const kindLabel =
              m.kind === "summary"
                ? "Resumo"
                : m.kind === "instruction"
                  ? "Instrução"
                  : m.kind === "request"
                    ? "Pergunta"
                    : m.fromAgentId !== null && m.toAgentId !== null
                      ? "Interna"
                      : null;
            return (
              <article key={m.id} id={`cb-item-${m.id}`} className={`cb-msg cb-${m.kind}`}>
                <header className="cb-msg-head">
                  <AvatarChip mark={markOf(m.fromAgentId, from)} title={from} />
                  <strong>{from}</strong>
                  {directed && (
                    <>
                      <span className="cb-msg-arrow" aria-hidden="true">
                        →
                      </span>
                      <AvatarChip mark={markOf(m.toAgentId, to)} title={to} />
                      <strong>{to}</strong>
                    </>
                  )}
                  <time className="cb-msg-time" dateTime={new Date(m.createdAt).toISOString()}>
                    {timeStr(m.createdAt)}
                  </time>
                </header>
                {kindLabel && <p className="cb-msg-kind">{kindLabel}</p>}
                {m.kind === "instruction" ? (
                  <p>{m.text}</p>
                ) : (
                  <div className="md">
                    <Markdown text={m.text} />
                  </div>
                )}
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
        <div className="cb-compose">
          <form
            className="cb-composer od-row"
            onSubmit={(event) => {
              event.preventDefault();
              const text = instruct.trim();
              if (!text) return;
              setInstruct("");
              void send("collaborations.instruct", { id, text });
            }}
          >
            <input
              className="cb-composer-input od-fill"
              value={instruct}
              onChange={(event) => setInstruct(event.target.value)}
              placeholder="Escreva para a mesa ou peça um resumo…"
              disabled={!live}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!live || !instruct.trim()}
              aria-label="Enviar instrução para a mesa"
            >
              <Icon name="send" />
            </button>
          </form>
          <p className="cb-instruct-hint">O Boto repassa a instrução para o líder da mesa.</p>
        </div>
      </aside>
    </div>
  );
}

/** Structural mini graph for a card: leader↔member spokes plus the user; no weights. */
export function MiniGraph({
  title,
  leaderId,
  memberIds,
  pending,
  nameOf,
}: {
  title: string;
  leaderId: string;
  memberIds: string[];
  pending: boolean;
  nameOf: (agentId: string | null) => string;
}) {
  const members = memberIds.filter((id) => id !== leaderId);
  const cx = 110;
  const cy = 52;
  const radius = 34;
  const user = { key: "user", label: "Você", x: cx, y: cy + radius * 0.95 };
  const nodes = [
    { key: leaderId, label: nameOf(leaderId), x: cx, y: cy, leader: true },
    ...members.map((id, i) => {
      const angle = ((-160 + (140 * i) / Math.max(members.length - 1, 1)) * Math.PI) / 180;
      return {
        key: id,
        label: nameOf(id),
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        leader: false,
      };
    }),
    { ...user, leader: false },
  ];
  const spokes = nodes.filter((n) => !n.leader).map((n) => ({ to: n }));
  return (
    <svg
      className="cb-mini"
      viewBox="0 0 220 112"
      data-pending={pending}
      role="img"
      aria-label={`Mini-grafo da mesa ${title}`}
    >
      {spokes.map(({ to }) => (
        <g key={to.key} className={to.key === "user" ? "cb-mini-user" : undefined}>
          <line x1={cx} y1={cy} x2={to.x} y2={to.y} />
        </g>
      ))}
      {nodes.map((n) => (
        <g key={n.key} className={n.leader ? "cb-mini-leader" : undefined}>
          <circle cx={n.x} cy={n.y} r={n.leader ? 10 : n.key === "user" ? 8 : 6} />
          <text x={n.x} y={n.y + (n.leader ? 24 : n.key === "user" ? 20 : -10)} textAnchor="middle">
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function TableCard({
  collab,
  pending,
  nameOf,
  onOpen,
  onOpenPending,
}: {
  collab: Collaboration;
  pending: TablePending | undefined;
  nameOf: (agentId: string | null) => string;
  onOpen: () => void;
  onOpenPending: () => void;
}) {
  const step = PHASES.indexOf(collab.phase) + 1;
  const pendingText =
    pending?.kind === "approval"
      ? (pending.approval.title ?? pending.approval.tool ?? "aprovação")
      : pending?.kind === "request"
        ? pending.request.text
        : null;
  return (
    <div className="cb-card" data-status={collab.status}>
      <button type="button" className="cb-card-main" onClick={onOpen}>
        <span className="cb-card-head od-row">
          <strong className="cb-card-title od-fill od-truncate">{collab.title}</strong>
          <span
            className="status"
            data-tone={
              collab.status === "active" ? "run" : collab.status === "done" ? "done" : "muted"
            }
          >
            {STATUS_LABELS[collab.status]}
          </span>
        </span>
        <MiniGraph
          title={collab.title}
          leaderId={collab.leaderId}
          memberIds={collab.members.map((m) => m.agentId)}
          pending={pending !== undefined}
          nameOf={nameOf}
        />
        <span className="cb-card-meta">
          Etapa {step} de {PHASES.length} · {collab.stats.members} bots · {collab.stats.messages}{" "}
          mensagens
        </span>
      </button>
      {pendingText !== null && (
        <button
          type="button"
          className="cb-card-pending"
          onClick={onOpenPending}
          title="Abrir a mesa direto na pendência"
        >
          <Icon name="clock" /> Aguardando você: <span className="od-truncate">{pendingText}</span>
          <span className="cb-card-pending-go">Ver o pedido</span>
        </button>
      )}
    </div>
  );
}

export function CollaborationView() {
  const { client, ready, agents } = useDaemon();
  const { params, navigate } = useRouter();
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
  const [filter, setFilter] = useState<TableFilter>("todas");
  const [pendencies, setPendencies] = useState<Map<string, TablePending>>(new Map());
  // In-memory set of open table tabs for the session — intentionally not
  // persisted; a reload starts with the grid only.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const collabs = useMemo(() => list.data ?? [], [list.data]);
  const current = params.id ?? null;
  const seenDone = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (current) setOpenTabs((t) => (t.includes(current) ? t : [...t, current]));
  }, [current]);
  const tabIds = current ? [...new Set([...openTabs, current])] : openTabs;

  const nameOf = useCallback(
    (agentId: string | null) => {
      if (agentId === null) return "Você";
      return agents.find((a) => a.id === agentId)?.name ?? "bot removido";
    },
    [agents],
  );

  // A table's pendency is an approval joined by collaborationId or an
  // unanswered request in its transcript — derived in lib/, refreshed on events.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const refresh = () => {
      void tablePendencies(client, collabs)
        .then((map) => {
          if (!cancelled) setPendencies(map);
        })
        .catch(() => {});
    };
    refresh();
    const offs = [
      client.on("collaboration.message", refresh),
      client.on("collaboration.updated", refresh),
      client.on("collaboration.created", refresh),
      client.on("approval.updated", refresh),
      client.onReconnect(refresh),
    ];
    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, [client, ready, collabs]);

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

  const closeTab = (id: string) => {
    const remaining = tabIds.filter((t) => t !== id);
    setOpenTabs(remaining);
    if (id === current) {
      const last = remaining[remaining.length - 1];
      last ? navigate("collaboration", { id: last }) : navigate("collaboration");
    }
  };
  const titleOf = (id: string) => collabs.find((c) => c.id === id)?.title ?? "Mesa";

  const shown = filterTables(collabs, filter, pendencies);
  const counts: Record<TableFilter, number> = {
    todas: collabs.length,
    aguardando: collabs.filter((c) => isLiveTable(c) && pendencies.has(c.id)).length,
    discussao: collabs.filter((c) => isLiveTable(c) && !pendencies.has(c.id)).length,
    resolvidas: collabs.filter((c) => c.status === "done").length,
  };

  const tabsRow =
    tabIds.length > 0 ? (
      <div className="cb-tabs od-row" role="tablist" aria-label="Mesas abertas">
        <button
          type="button"
          role="tab"
          aria-selected={current === null}
          className="cb-tab cb-tab-mesas"
          onClick={() => navigate("collaboration")}
        >
          <Icon name="arrow-left" /> Mesas
        </button>
        {tabIds.map((id) => (
          <span key={id} className="cb-tab" data-active={id === current}>
            <button
              type="button"
              role="tab"
              aria-selected={id === current}
              className="cb-tab-btn od-truncate"
              onClick={() => navigate("collaboration", { id })}
            >
              {pendencies.has(id) && (
                <i className="cb-tab-dot" role="img" aria-label="Aguardando você" />
              )}
              {titleOf(id)}
            </button>
            <button
              type="button"
              className="cb-tab-x"
              aria-label={`Fechar a aba ${titleOf(id)}`}
              onClick={() => closeTab(id)}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="cb-tab cb-tab-new"
          aria-label="Nova mesa"
          onClick={() => navigate("newTable")}
        >
          <Icon name="plus" />
        </button>
      </div>
    ) : null;

  if (current)
    return (
      <section
        className="view collaboration cb-open"
        id="view-collaboration"
        aria-labelledby="collaboration-title"
      >
        <TablePanel key={current} id={current} focus={params.focus} tabs={tabsRow} />
      </section>
    );

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
              Mesas
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
            onClick={() => navigate("newTable")}
          >
            <Icon name="plus" />
            Nova mesa
          </button>
        </div>

        {tabsRow}

        {list.error && (
          <p className="cb-empty">
            Não consegui carregar as mesas. {list.error}{" "}
            <button type="button" className="btn btn-outline btn-sm" onClick={list.reload}>
              Tentar de novo
            </button>
          </p>
        )}
        {!list.error && !list.loaded && <p className="cb-empty">Carregando…</p>}
        {!list.error && list.loaded && !collabs.length && (
          <div className="cb-empty-state">
            <Icon name="network" />
            <p>
              Nenhuma mesa ainda. Abra uma <strong>Nova mesa</strong> ou peça para um bot reunir a
              equipe.
            </p>
          </div>
        )}
        {collabs.length > 0 && (
          <>
            <div className="cb-chips od-row" role="tablist" aria-label="Filtrar mesas">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  className="cb-chip"
                  onClick={() => setFilter(f.key)}
                >
                  {f.label} {counts[f.key] > 0 ? counts[f.key] : ""}
                </button>
              ))}
            </div>
            <div className="cb-grid">
              {shown.map((c) => (
                <TableCard
                  key={c.id}
                  collab={c}
                  pending={pendencies.get(c.id)}
                  nameOf={nameOf}
                  onOpen={() => navigate("collaboration", { id: c.id })}
                  onOpenPending={() => {
                    const p = pendencies.get(c.id);
                    const focus =
                      p?.kind === "approval"
                        ? `ap-${p.approval.id}`
                        : p?.kind === "request"
                          ? p.request.id
                          : undefined;
                    navigate("collaboration", { id: c.id, ...(focus ? { focus } : {}) });
                  }}
                />
              ))}
              {!shown.length && <p className="cb-empty">Nenhuma mesa neste filtro.</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
