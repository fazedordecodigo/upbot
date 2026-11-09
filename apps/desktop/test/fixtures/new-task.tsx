import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DaemonProvider } from "../../src/shell/daemon";
import { RouterProvider, useRouter } from "../../src/shell/router";
import { PrivateModeProvider, Topbar } from "../../src/shell/Topbar";
import { ToastProvider } from "../../src/ui/Toast";
import { NewTaskView } from "../../src/views/NewTaskView";
import "../../src/styles/tokens.css";
import "../../src/styles/layout.css";
import "../../src/styles/ui.css";
import "../../src/shell/shell.css";

// Exercises router params before the independently built Modelos screen is merged.
function Harness() {
  const { navigate, view, params } = useRouter();
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const templateId = query.get("templateId");
    const agentId = query.get("agentId");
    navigate("new", { ...(templateId ? { templateId } : {}), ...(agentId ? { agentId } : {}) });
  }, [navigate]);
  return (
    <main id="main" data-view={view} data-route-id={params.id}>
      <button
        type="button"
        onClick={() =>
          navigate("new", {
            agentId: new URLSearchParams(location.search).get("nextAgentId") ?? "",
          })
        }
      >
        Switch route agent
      </button>
      <Topbar collapsed={false} expand={() => {}} openMenu={() => {}} />
      {view === "new" ? <NewTaskView /> : <h1 tabIndex={-1}>{view}</h1>}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <RouterProvider>
      <DaemonProvider>
        <PrivateModeProvider>
          <Harness />
        </PrivateModeProvider>
      </DaemonProvider>
    </RouterProvider>
  </ToastProvider>,
);
