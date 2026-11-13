import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

export type ViewName =
  | "home"
  | "agents"
  | "new"
  | "newTable"
  | "templates"
  | "task"
  | "collaboration"
  | "routines"
  | "marketplace"
  | "settings";
export type RouteParams = Record<string, string>;
type Router = {
  view: ViewName;
  params: RouteParams;
  navigate: (view: ViewName, params?: RouteParams) => void;
};
const RouterContext = createContext<Router | null>(null);
export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<{ view: ViewName; params: RouteParams; revision: number }>(
    () => {
      const taskId = new URLSearchParams(location.hash.slice(1)).get("task");
      return { view: taskId ? "task" : "home", params: taskId ? { id: taskId } : {}, revision: 0 };
    },
  );
  const navigate = useCallback((view: ViewName, params: RouteParams = {}) => {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (view === "task" && params.id) hash.set("task", params.id);
    else hash.delete("task");
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${hash.size ? `#${hash}` : ""}`,
    );
    setRoute((previous) => ({ view, params, revision: previous.revision + 1 }));
  }, []);
  useEffect(() => {
    if (route.revision > 0) document.querySelector<HTMLElement>("#main h1")?.focus();
  }, [route]);
  return <RouterContext.Provider value={{ ...route, navigate }}>{children}</RouterContext.Provider>;
}
export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Missing router");
  return router;
}
