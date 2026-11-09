import { createRoot } from "react-dom/client";
import { RouterProvider, useRouter } from "../../src/shell/router";

function Probe() {
  const { view, params, navigate } = useRouter();
  return (
    <main id="main">
      <h1 tabIndex={-1}>
        {view}:{params.id ?? "none"}
      </h1>
      <button type="button" onClick={() => navigate("task", { id: "private-task" })}>
        Open task
      </button>
      <button type="button" onClick={() => navigate("home")}>
        Leave task
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <RouterProvider>
    <Probe />
  </RouterProvider>,
);
