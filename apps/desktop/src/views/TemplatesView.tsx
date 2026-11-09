import "./TemplatesView.css";

export function TemplatesView() {
  return (
    <section
      className="view templates-view od-scroll"
      id="view-templates"
      aria-labelledby="templates-title"
    >
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="templates-title" tabIndex={-1}>
              Modelos
            </h1>
            <p className="page-sub">
              Tarefas prontas para começar. Escolha um modelo: ele abre uma nova tarefa já
              preenchida, e você ajusta o texto e as opções antes de delegar.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
