import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { migrateLegacyStorage } from "./lib/storage";
import { initializeTheme } from "./lib/theme";
import "./index.css";

migrateLegacyStorage();
initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    {window.location.hash.split("?")[0] === "#/menubar" ? null : <main id="main" />}
  </StrictMode>,
);
