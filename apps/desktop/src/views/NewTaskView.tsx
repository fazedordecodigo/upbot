import "./NewTaskView.css";

export function NewTaskView() {
  return (
    <section className="view chat" id="view-new" aria-labelledby="chat-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="chat-title" id="chat-title" tabIndex={-1}>
              O que eu devo fazer hoje?
            </h1>
          </div>
        </div>
      </div>
    </section>
  );
}
