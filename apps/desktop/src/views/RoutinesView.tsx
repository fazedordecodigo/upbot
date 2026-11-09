import "./RoutinesView.css";

export function RoutinesView() {
  return (
    <section
      className="view routines od-scroll"
      id="view-routines"
      aria-labelledby="routines-title"
    >
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="routines-title" tabIndex={-1}>
              Rotinas
            </h1>
            <p className="page-sub">
              Tarefas que o Boto executa sozinho no horário marcado, no computador dele na nuvem.
              Você recebe a entrega quando ficar pronta.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
