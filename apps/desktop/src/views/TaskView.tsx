import "./TaskView.css";

export function TaskView() {
  return (
    <section className="view task" id="view-task" aria-labelledby="task-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            {/* biome-ignore lint/a11y/useHeadingContent: task title remains empty until a real task is selected. */}
            <h1 className="task-title od-truncate" id="task-title" tabIndex={-1}></h1>
          </div>
        </div>
      </div>
    </section>
  );
}
