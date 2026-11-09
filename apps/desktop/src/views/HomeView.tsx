import "./HomeView.css";

export function HomeView() {
  return (
    <section className="view home od-scroll" id="view-home" aria-labelledby="home-title">
      <div className="home-inner">
        <div className="home-head">
          <div className="od-field od-fill">
            <h1 className="home-title" id="home-title" tabIndex={-1}>
              O trabalho do Boto hoje
            </h1>
          </div>
        </div>
      </div>
    </section>
  );
}
