import type { ReactNode } from "react";
import { Icon } from "../ui/icons";

export function QueryState({
  query,
  children,
}: {
  query: { error: string | null; loaded: boolean; reload: () => void };
  children: ReactNode;
}) {
  if (query.error)
    return (
      <p className="st-error od-row" role="alert">
        <Icon name="circle-alert" />
        {query.error}
        <button type="button" className="btn btn-link" onClick={query.reload}>
          Tentar de novo
        </button>
      </p>
    );
  if (!query.loaded)
    return (
      <p className="st-empty" aria-busy="true">
        <Icon name="loader" />
        Carregando…
      </p>
    );
  return children;
}

export function BlockHead({
  title,
  description,
  id,
  children,
}: {
  title: string;
  description: string;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <div className="st-block-head">
      <div className="od-field od-fill">
        <h2 className="st-title" id={id}>
          {title}
        </h2>
        <p className="st-desc">{description}</p>
      </div>
      {children}
    </div>
  );
}
