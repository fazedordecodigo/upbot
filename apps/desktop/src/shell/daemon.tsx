import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useDaemonState } from "../hooks/useDaemonState";
import { DaemonClient } from "../lib/daemon";
import { errorFields, logWarn } from "../lib/log";

type DaemonState = ReturnType<typeof useDaemonState> & { client: DaemonClient; connected: boolean };
const DaemonContext = createContext<DaemonState | null>(null);
export function DaemonProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new DaemonClient());
  const state = useDaemonState(client);
  const { refresh, setError } = state;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const offReconnect = client.onReconnect(() => {
      setConnected(true);
      void refresh().catch((error: unknown) =>
        logWarn("app.refresh_after_reconnect_failed", errorFields(error)),
      );
    });
    const offDisconnect = client.onDisconnect(() => setConnected(false));
    const offFailure = client.onFailure((error) => {
      setConnected(false);
      setError(error.message);
    });
    return () => {
      offReconnect();
      offDisconnect();
      offFailure();
    };
  }, [client, refresh, setError]);
  useEffect(() => {
    if (state.ready) setConnected(true);
  }, [state.ready]);
  return (
    <DaemonContext.Provider value={{ ...state, client, connected }}>
      {children}
    </DaemonContext.Provider>
  );
}
export function useDaemon() {
  const daemon = useContext(DaemonContext);
  if (!daemon) throw new Error("Missing daemon");
  return daemon;
}
