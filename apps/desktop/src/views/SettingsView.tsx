import "./SettingsView.css";

export function SettingsView() {
  return (
    <section className="view st-view od-scroll" id="view-settings" aria-labelledby="settings-title">
      <div className="page-inner page-wide">
        <div className="page-head">
          <div className="od-field od-fill">
            <h1 className="page-title" id="settings-title" tabIndex={-1}>
              Configurações
            </h1>
            <p className="page-sub">
              Escolha o provedor de IA que os agentes usam e ajuste a memória, a aparência e a
              privacidade. Não tem conta no Boto: tudo fica neste navegador.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
