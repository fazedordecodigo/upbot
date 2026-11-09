import "./MarketplaceView.css";
import type { MarketplaceItem } from "@boto/protocol";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { marketplaceTabs, sortMarketplace } from "../lib/marketplace";
import { MarketplaceCard } from "../marketplace/MarketplaceCard";
import { MarketplaceDetail } from "../marketplace/MarketplaceDetail";
import { useDaemon } from "../shell/daemon";
import { Icon } from "../ui/icons";

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index +
            (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) +
            buttons.length) %
          buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
  buttons[next]?.click();
}

export function MarketplaceView() {
  const { client } = useDaemon();
  const [tab, setTab] = useState<(typeof marketplaceTabs)[number]>(marketplaceTabs[0]);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<MarketplaceItem | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, error, loaded, reload } = useDaemonQuery(
    client,
    "marketplace.list",
    { kind: tab.kind, category: category || undefined, query: debounced || undefined },
    {
      events: {
        "apps.changed": true,
        "skills.changed": true,
      },
    },
  );
  const items = sortMarketplace(data?.items ?? []);
  const featured = !query.trim() && !category ? items.filter((item) => item.featured) : [];
  const categories = [
    { name: "", count: data?.categories.reduce((sum, cat) => sum + cat.count, 0) ?? "a definir" },
    ...(data?.categories ?? []),
  ];
  const clear = () => {
    setQuery("");
    setCategory("");
  };
  return (
    <section className="view mk-view od-scroll" id="view-marketplace" aria-labelledby="mk-title">
      <div className="page-inner page-wide mk-inner">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="mk-title" tabIndex={-1}>
              Marketplace
            </h1>
            <p className="page-sub">
              Novas ferramentas para os seus agentes: apps, plugins, skills e servidores MCP. O que
              você instala aqui fica disponível no computador do Boto para todos os agentes. Na
              primeira vez que um agente usa uma ferramenta numa sessão, ele pede sua permissão.
            </p>
          </div>
        </div>
        <div className="mk-toolbar">
          <div
            className="tabs-list mk-tabs"
            id="mk-tabs"
            role="tablist"
            aria-label="Tipo de item"
            onKeyDown={moveFocus}
          >
            {marketplaceTabs.map((entry) => (
              <button
                type="button"
                className="tabs-trigger"
                key={entry.value}
                id={`mk-tab-${entry.value}`}
                role="tab"
                aria-selected={tab.value === entry.value}
                aria-controls="mk-results"
                tabIndex={tab.value === entry.value ? 0 : -1}
                onClick={() => {
                  setTab(entry);
                  setCategory("");
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="mk-search od-row">
            <Icon name="search" />
            <input
              className="mk-search-input od-fill"
              id="mk-search"
              type="search"
              placeholder="Buscar por nome ou função"
              aria-label="Buscar no marketplace"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div
          className="mk-cats od-rail"
          id="mk-cats"
          role="radiogroup"
          aria-label="Categoria"
          onKeyDown={moveFocus}
        >
          {categories.map((cat) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented category controls use roving button focus.
            <button
              type="button"
              className="btn btn-sm mk-category"
              key={cat.name}
              role="radio"
              aria-checked={category === cat.name}
              tabIndex={category === cat.name ? 0 : -1}
              onClick={() => setCategory(cat.name)}
            >
              {cat.name || "Todas"}
              <span className="badge badge-secondary">{cat.count}</span>
            </button>
          ))}
        </div>
        <div
          className="mk-results"
          id="mk-results"
          role="tabpanel"
          aria-labelledby={`mk-tab-${tab.value}`}
          aria-busy={!loaded && !error}
        >
          {!loaded && !error && <p role="status">Carregando…</p>}
          {error && (
            <div role="alert">
              <p>Não foi possível carregar o marketplace.</p>
              <button className="btn btn-outline" type="button" onClick={reload}>
                Tentar de novo
              </button>
            </div>
          )}
          {data?.errors.map((failure) => (
            <p className="mk-notice" role="status" key={failure.source}>
              Não foi possível carregar {failure.source}.
            </p>
          ))}
          {featured.length > 0 && (
            <section className="mk-featured-wrap" id="mk-featured" aria-labelledby="mk-feat-title">
              <h2 className="section-title" id="mk-feat-title">
                Em destaque
              </h2>
              <div className="mk-featured-grid">
                {featured.map((item) => (
                  <MarketplaceCard
                    key={`${item.source}:${item.id}`}
                    item={item}
                    onOpen={setSelected}
                    featured
                  />
                ))}
              </div>
            </section>
          )}
          <section aria-labelledby="mk-grid-title">
            <div className="section-head od-row">
              <h2 className="section-title" id="mk-grid-title">
                {tab.label}
              </h2>
              <span className="badge badge-secondary" id="mk-grid-count">
                {data ? items.length : "a definir"}
              </span>
            </div>
            <div id="mk-grid">
              {items.map((item) => (
                <MarketplaceCard
                  key={`${item.source}:${item.id}`}
                  item={item}
                  onOpen={setSelected}
                />
              ))}
            </div>
            {loaded &&
              !items.length &&
              (query.trim() || category ? (
                <div className="mk-empty">
                  <h3>Nada encontrado</h3>
                  <p>Tente outro nome ou escolha outra categoria.</p>
                  <button className="btn btn-outline" type="button" onClick={clear}>
                    Limpar filtros
                  </button>
                </div>
              ) : (
                <p>Nenhum item neste tipo ainda.</p>
              ))}
          </section>
        </div>
      </div>
      {selected && (
        <MarketplaceDetail
          key={`${selected.source}:${selected.id}`}
          item={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </section>
  );
}
