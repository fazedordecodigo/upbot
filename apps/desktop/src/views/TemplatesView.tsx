import type { Template } from "@boto/protocol";
import { useTemplates } from "../hooks/useTemplates";
import { templateMeta } from "../lib/templates";
import { useRouter } from "../shell/router";
import { Icon } from "../ui/icons";
import "./TemplatesView.css";

export function TemplatesView() {
  const { templates, loading, waiting, error, connected, refresh } = useTemplates();
  const { navigate } = useRouter();
  const sections: { kind: Template["kind"]; id: string; title: string; empty: string }[] = [
    {
      kind: "task",
      id: "tpl-now-title",
      title: "Executar uma vez",
      empty: "Nenhum modelo para executar uma vez.",
    },
    {
      kind: "routine",
      id: "tpl-repeat-title",
      title: "Rotinas",
      empty: "Nenhum modelo de rotina.",
    },
  ];
  return (
    <section
      className="view templates-view od-scroll"
      id="view-templates"
      aria-labelledby="templates-title"
    >
      <div className="page-inner">
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
          <button
            type="button"
            className="btn btn-outline"
            data-action="new-task"
            onClick={() => navigate("new")}
          >
            <Icon name="plus" />
            Tarefa em branco
          </button>
        </div>
        {error ? (
          <div className="templates-state od-field" role="alert">
            <p className="od-row">
              <Icon name="circle-alert" />
              Não consegui carregar os modelos.
            </p>
            <button
              type="button"
              className="btn btn-outline"
              disabled={!connected}
              onClick={() => void refresh()}
            >
              <Icon name="refresh-cw" />
              Tentar de novo
            </button>
          </div>
        ) : waiting || loading ? (
          <p className="templates-state od-row" role="status">
            <Icon name={waiting ? "clock" : "loader"} />
            {waiting ? "Aguardando conexão com o Boto." : "Carregando modelos…"}
          </p>
        ) : (
          sections.map((section) => (
            <section key={section.kind} aria-labelledby={section.id}>
              <div className="section-head od-row">
                <h2 className="section-title" id={section.id}>
                  {section.title}
                </h2>
              </div>
              <div className="templates">
                {templates
                  .filter((template) => template.kind === section.kind)
                  .map((template) => (
                    <button
                      type="button"
                      className="template"
                      key={template.id}
                      data-template={template.id}
                      onClick={() => navigate("new", { templateId: template.id })}
                    >
                      <svg className="od-icon" aria-hidden="true">
                        <use
                          href={`/assets/icons.svg#i-${/^[a-z][a-z0-9-]*$/.test(template.icon) ? template.icon : "file-text"}`}
                        />
                      </svg>
                      <span className="od-field od-fill">
                        <span className="template-name">{template.name}</span>
                        <span className="template-desc">{template.description}</span>
                        <span className="template-meta">{templateMeta(template)}</span>
                      </span>
                    </button>
                  ))}
                {!templates.some((template) => template.kind === section.kind) && (
                  <p className="templates-empty" role="status">
                    {section.empty}
                  </p>
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
