import { createRoot } from "react-dom/client";
import { ConfirmProvider } from "../../src/dialogs/ConfirmDialog";
import { DaemonProvider } from "../../src/shell/daemon";
import { RouterProvider } from "../../src/shell/router";
import { ToastProvider } from "../../src/ui/Toast";
import { TaskView } from "../../src/views/TaskView";
import "../../src/styles/tokens.css";
import "../../src/styles/layout.css";
import "../../src/styles/ui.css";

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <RouterProvider>
      <DaemonProvider>
        <ConfirmProvider>
          <main id="main">
            <TaskView />
          </main>
        </ConfirmProvider>
      </DaemonProvider>
    </RouterProvider>
  </ToastProvider>,
);
