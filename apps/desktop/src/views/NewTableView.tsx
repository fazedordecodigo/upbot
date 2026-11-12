import type { Agent } from "@boto/protocol";
import { useMemo, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { suggestedBots } from "../lib/mesa-suggest";
import { mono } from "../lib/ui";
import { useDaemon } from "../shell/daemon";
import { useRouter } from "../shell/router";
import { Icon } from "../ui/icons";
import { Switch } from "../ui/Switch";
import { MiniGraph } from "./CollaborationView";
import "./NewTableView.css";

function BotAvatar({ agent }: { agent: Agent }) {
  return (
    <span className="avatar" aria-hidden="true">
      {agent.avatar && "emoji" in agent.avatar ? agent.avatar.emoji : mono(agent.name)}
    </span>
  );
}

export function NewTableView() {
  const { client, ready, agents } = useDaemon();
  const { navigate } = useRouter();
  const overview = useDaemonQuery(
    client,
    "agents.overview",
    {},
    {
      enabled: ready,
      events: { "agents.overviewChanged": true },
    },
  );
  const recent = useDaemonQuery(
    client,
    "collaborations.list",
    {},
    {
      enabled: ready,
      events: { "collaboration.created": true, "collaboration.updated": true },
    },
  );

  const coordinator = agents.find((a) => a.isDefault) ?? null;
  const others = useMemo(
    () => agents.filter((a) => a.id !== coordinator?.id),
    [agents, coordinator],
  );
  const freeOf = (id: string): number | null => {
    const o = overview.data?.agents.find((a) => a.agentId === id);
    return o ? o.instances.capacity - o.instances.active : null;
  };

  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [topology, setTopology] = useState<"mesh" | "hub">("mesh");
  const [askExternal, setAskExternal] = useState(false);
  const [checkpointPhases, setCheckpointPhases] = useState(false);
  const [useMemory, setUseMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = useMemo(
    () =>
      new Set(
        suggestedBots(
          problem,
          others.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            description: a.instructions,
          })),
        ),
      ),
    [problem, others],
  );
  const unselectedSuggested = useMemo(
    () => [...suggested].filter((id) => !picked.has(id)),
    [suggested, picked],
  );
  const examples = useMemo(
    () =>
      (recent.data ?? [])
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3),
    [recent.data],
  );

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 7) next.add(id);
      return next;
    });
  };

  const canCreate =
    Boolean(coordinator) &&
    title.trim().length > 0 &&
    problem.trim().length > 0 &&
    picked.size >= 2;

  const submit = async () => {
    if (!coordinator || !canCreate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await client.request("collaborations.create", {
        title: title.trim(),
        problem: problem.trim(),
        memberIds: [coordinator.id, ...picked],
        leaderId: coordinator.id,
        topology,
        askExternal,
        checkpointPhases,
        useMemory,
      });
      navigate("collaboration", { id: c.id });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const nameOf = (agentId: string | null) =>
    agentId === null ? "Você" : (agents.find((a) => a.id === agentId)?.name ?? "bot removido");

  const pickedAgents = [...picked]
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => a !== undefined);

  return (
    <section
      className="view new-table od-scroll"
      id="view-new-table"
      aria-labelledby="new-table-title"
    >
      <div className="page-inner">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="new-table-title" tabIndex={-1}>
              Nova mesa
            </h1>
            <p className="page-sub">
              Um bot coordenador reúne outros bots para conversar par-a-par e resolver um problema.
            </p>
          </div>
        </div>

        <div className="nt-grid">
          <div className="od-stack">
            <section className="nt-section" aria-labelledby="nt-problem">
              <h2 id="nt-problem">
                <span className="nt-num">1</span> O problema
              </h2>
              <label className="od-field">
                <span>Nome da mesa</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={80}
                  placeholder="Ex.: Erro no checkout"
                  required
                />
              </label>
              <label className="od-field">
                <span>O que a mesa deve resolver</span>
                <textarea
                  value={problem}
                  onChange={(event) => setProblem(event.target.value)}
                  rows={5}
                  maxLength={20000}
                  placeholder="Descreva o problema, o contexto e o resultado esperado…"
                  required
                />
              </label>
              {examples.length > 0 && (
                <div className="nt-examples od-row">
                  <span className="nt-examples-label">Começar de um exemplo:</span>
                  {examples.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="nt-example-chip"
                      onClick={() => {
                        setTitle(c.title);
                        setProblem(c.problem);
                      }}
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="nt-section" aria-labelledby="nt-people">
              <h2 id="nt-people">
                <span className="nt-num">2</span> Quem participa
              </h2>
              {!coordinator ? (
                <p className="nt-hint">
                  A mesa precisa de um bot coordenador.{" "}
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate("agents")}
                  >
                    Criar um bot primeiro
                  </button>
                </p>
              ) : (
                <>
                  <div className="nt-coord od-row">
                    <BotAvatar agent={coordinator} />
                    <div className="od-fill">
                      <strong>{coordinator.name}</strong>
                      <p className="nt-hint">Coordena a mesa — sempre participa</p>
                    </div>
                    <span className="status" data-tone="run">
                      Coordenador
                    </span>
                  </div>
                  <div className="nt-bots">
                    {others.map((agent) => {
                      const free = freeOf(agent.id);
                      const on = picked.has(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          className="nt-bot"
                          data-picked={on}
                          aria-pressed={on}
                          onClick={() => toggle(agent.id)}
                        >
                          <span className="nt-bot-head od-row">
                            <BotAvatar agent={agent} />
                            <strong className="od-fill od-truncate">{agent.name}</strong>
                            {suggested.has(agent.id) && (
                              <span className="nt-suggested">sugerido</span>
                            )}
                          </span>
                          <span className="nt-bot-role od-clamp-2">
                            {agent.role || "Bot de uso geral"}
                          </span>
                          <span className="nt-bot-free">
                            {free === null
                              ? ""
                              : free > 0
                                ? `${free} ${free === 1 ? "instância livre" : "instâncias livres"}`
                                : "Lotado — entra na mesa quando uma liberar"}
                          </span>
                        </button>
                      );
                    })}
                    {!others.length && (
                      <p className="nt-hint">Crie outros bots para convidar à mesa.</p>
                    )}
                  </div>
                  {unselectedSuggested.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm nt-suggest-action"
                      onClick={() =>
                        setPicked((current) => new Set([...current, ...unselectedSuggested]))
                      }
                    >
                      <Icon name="circle-check" /> Selecionar sugeridos (
                      {unselectedSuggested.length})
                    </button>
                  )}
                  <p className="nt-hint">
                    Escolha pelo menos 2 bots além do coordenador.
                    {picked.size > 0 ? ` ${picked.size} escolhidos.` : ""}
                  </p>
                </>
              )}
            </section>

            <section className="nt-section" aria-labelledby="nt-mode">
              <h2 id="nt-mode">
                <span className="nt-num">3</span> Como a mesa trabalha
              </h2>
              <fieldset className="nt-topology">
                <legend>Jeito de conversar</legend>
                <label className="nt-option" data-on={topology === "mesh"}>
                  <input
                    type="radio"
                    name="topology"
                    checked={topology === "mesh"}
                    onChange={() => setTopology("mesh")}
                  />
                  <span>
                    <strong>Todos conversam com todos</strong>
                    <small>Qualquer bot pode falar direto com qualquer outro.</small>
                  </span>
                </label>
                <label className="nt-option" data-on={topology === "hub"}>
                  <input
                    type="radio"
                    name="topology"
                    checked={topology === "hub"}
                    onChange={() => setTopology("hub")}
                  />
                  <span>
                    <strong>Tudo passa pelo coordenador</strong>
                    <small>Mensagens entre bots sempre chegam primeiro ao coordenador.</small>
                  </span>
                </label>
              </fieldset>
              <div className="nt-toggle od-row">
                <span className="od-fill">
                  <strong>Aprovar ações fora do Boto</strong>
                  <small>
                    Publicar, pagar e apps que escrevem pedem seu ok — de qualquer bot da mesa.
                  </small>
                </span>
                <Switch
                  checked={askExternal}
                  onCheckedChange={setAskExternal}
                  aria-label="Aprovar ações fora do Boto"
                />
              </div>
              <div className="nt-toggle od-row">
                <span className="od-fill">
                  <strong>Parar antes de virar a etapa</strong>
                  <small>A mesa só avança de etapa quando você libera.</small>
                </span>
                <Switch
                  checked={checkpointPhases}
                  onCheckedChange={setCheckpointPhases}
                  aria-label="Parar antes de virar a etapa"
                />
              </div>
              <div className="nt-toggle od-row">
                <span className="od-fill">
                  <strong>Lembrar de você na mesa</strong>
                  <small>As sessões dos bots veem seu perfil; desligado, ele não sai daqui.</small>
                </span>
                <Switch
                  checked={useMemory}
                  onCheckedChange={setUseMemory}
                  aria-label="Lembrar de você na mesa"
                />
              </div>
            </section>

            <div className="nt-actions od-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => navigate("collaboration")}
                disabled={busy}
              >
                Cancelar
              </button>
              <span className="od-fill" />
              {error && <p className="nt-error">{error}</p>}
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canCreate || busy}
                onClick={() => void submit()}
                data-action="create-table"
              >
                {busy ? "Abrindo…" : "Abrir mesa"}
              </button>
            </div>
          </div>

          <aside className="nt-preview" aria-label="Prévia da mesa">
            <div className="nt-preview-card">
              <header className="od-row">
                <strong className="od-fill od-truncate">{title.trim() || "Nome da mesa"}</strong>
                <span className="status" data-tone="run">
                  Ativa
                </span>
              </header>
              <MiniGraph
                title={title.trim() || "Nova mesa"}
                leaderId={coordinator?.id ?? ""}
                memberIds={[coordinator?.id ?? "", ...picked]}
                pending={false}
                nameOf={nameOf}
              />
              <p className="nt-preview-meta">
                Etapa 1 de 5 · {(coordinator ? 1 : 0) + picked.size} bots · 0 mensagens
              </p>
              <ul className="nt-preview-mode">
                <li>
                  {topology === "mesh"
                    ? "Todos conversam com todos"
                    : "Tudo passa pelo coordenador"}
                </li>
                <li>{askExternal ? "Ações externas pedem aprovação" : "Ações externas livres"}</li>
                <li>
                  {checkpointPhases
                    ? "Para ao fim de cada etapa"
                    : "Etapas avançam com o coordenador"}
                </li>
                <li>
                  {useMemory ? "Os bots veem seu perfil" : "Seu perfil não entra nas sessões"}
                </li>
              </ul>
              {problem.trim() && <p className="nt-preview-problem">{problem.trim()}</p>}
              {pickedAgents.length > 0 && (
                <p className="nt-preview-members">
                  {coordinator ? `${coordinator.name} coordena` : ""}
                  {pickedAgents.map((a) => a.name).join(", ")}
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
