import "./AgentsView.css";

export function AgentsView() {
  return (
    <section className="view agents-view od-scroll" id="view-agents" aria-labelledby="agents-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="agents-title" tabIndex={-1}>
              Agentes
            </h1>
            <p className="page-sub">
              O quadro de todos os agentes do Boto. Cada agente tem uma especialidade, trabalha em
              instâncias próprias no computador na nuvem e puxa a próxima tarefa da fila quando uma
              instância fica livre.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
