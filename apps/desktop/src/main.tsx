import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { migrateLegacyStorage } from "./lib/storage";
import { initializeTheme } from "./lib/theme";
import App from "./shell/App";
import "./index.css";

migrateLegacyStorage();
initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function Root() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  return hash.split("?")[0] === "#/menubar" ? null : <App />;
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
