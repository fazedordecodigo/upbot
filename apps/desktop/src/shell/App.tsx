import { type CSSProperties, useEffect, useState } from "react";
import { OnboardingDialog } from "../dialogs/OnboardingDialog";
import { ShortcutsDialog } from "../dialogs/ShortcutsDialog";
import { useMediaQuery } from "../hooks/useLayerFocus";
import { readSidebarWidth, setSidebarWidth } from "../lib/sidebar-width";
import { readStorage, writeStorage } from "../lib/storage";
import { Sheet } from "../ui/Sheet";
import { ToastProvider } from "../ui/Toast";
import { TooltipLayer } from "../ui/Tooltip";
import { CommandPalette } from "./CommandPalette";
import { DaemonProvider } from "./daemon";
import { RouterProvider, useRouter } from "./router";
import { Sidebar } from "./Sidebar";
import { PrivateModeProvider, Topbar } from "./Topbar";
import { useNativeIntegration } from "./useNativeIntegration";
import { views } from "./views";

function Shell() {
  const { view, params, navigate } = useRouter();
  const [sheet, setSheet] = useState(false);
  const [command, setCommand] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => readStorage("boto.sidebar-collapsed") === "true",
  );
  const [width, setWidth] = useState(readSidebarWidth);
  useEffect(() => {
    const update = () => setWidth(readSidebarWidth());
    window.addEventListener("boto:sidebar-width", update);
    return () => window.removeEventListener("boto:sidebar-width", update);
  }, []);
  const narrow = useMediaQuery("(max-width: 1023px)");
  useNativeIntegration();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the sheet on every route change.
  useEffect(() => {
    setSheet(false);
  }, [view, params]);
  useEffect(() => {
    if (!narrow) setSheet(false);
  }, [narrow]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSheet(false);
        setCommand((value) => !value);
      } else if (event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setCommand(false);
        navigate("new");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [navigate]);
  const resize = (value: number) => {
    const next = Math.min(400, Math.max(220, value));
    setWidth(next);
    setSidebarWidth(next);
  };
  const collapse = (value: boolean) => {
    setCollapsed(value);
    writeStorage("boto.sidebar-collapsed", String(value));
  };
  const sidebarProps = {
    collapse: () => collapse(true),
    close: () => setSheet(false),
    openCommand: () => {
      setSheet(false);
      setCommand(true);
    },
    openShortcuts: () => {
      setSheet(false);
      setShortcuts(true);
    },
    openOnboarding: () => {
      setSheet(false);
      setOnboarding(true);
    },
  };
  const View = views[view];
  return (
    <>
      {/* biome-ignore lint/a11y/useValidAnchor: preserve the daemon credentials in the location hash. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Pular para o conteúdo
      </a>
      <div
        className="app"
        id="app"
        data-collapsed={collapsed}
        style={{ "--sidebar-w-live": `${width}px` } as CSSProperties}
      >
        <aside className="sidebar" id="sidebar" aria-label="Barra lateral">
          <Sidebar variant="rail" {...sidebarProps} />
          {/* biome-ignore lint/a11y/useSemanticElements: interactive vertical resizer, not a horizontal rule. */}
          <div
            className="sb-resizer"
            id="sb-resizer"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-controls="sidebar"
            aria-label="Largura da barra lateral"
            aria-valuemin={220}
            aria-valuemax={400}
            aria-valuenow={width}
            data-tip="Arraste para ajustar. Duplo clique volta ao padrão."
            onDoubleClick={() => resize(272)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowLeft"
                  ? width - 8
                  : event.key === "ArrowRight"
                    ? width + 8
                    : event.key === "Home"
                      ? 220
                      : event.key === "End"
                        ? 400
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                resize(next);
              }
            }}
          />
        </aside>
        <main className="main" id="main" tabIndex={-1} data-view={view}>
          <Topbar
            collapsed={collapsed}
            expand={() => collapse(false)}
            openMenu={() => setSheet(true)}
          />
          <View />
        </main>
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} id="sheet" aria-label="Menu">
        {sheet && <Sidebar variant="sheet" {...sidebarProps} />}
      </Sheet>
      {command && (
        <CommandPalette
          open
          onClose={() => setCommand(false)}
          openShortcuts={() => setShortcuts(true)}
        />
      )}
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <OnboardingDialog open={onboarding} onClose={() => setOnboarding(false)} />
      <TooltipLayer />
    </>
  );
}
export default function App() {
  return (
    <ToastProvider>
      <RouterProvider>
        <DaemonProvider>
          <PrivateModeProvider>
            <Shell />
          </PrivateModeProvider>
        </DaemonProvider>
      </RouterProvider>
    </ToastProvider>
  );
}
