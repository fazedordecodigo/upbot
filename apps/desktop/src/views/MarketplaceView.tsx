import "./MarketplaceView.css";

export function MarketplaceView() {
  return (
    <section className="view mk-view od-scroll" id="view-marketplace" aria-labelledby="mk-title">
      <div className="page-inner page-wide">
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
      </div>
    </section>
  );
}
