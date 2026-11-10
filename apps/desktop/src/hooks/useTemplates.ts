import type { Template } from "@boto/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorFields, logWarn } from "../lib/log";
import { useDaemon } from "../shell/daemon";

export function useTemplates() {
  const { client, connected, error: connectionError } = useDaemon();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!connected) return;
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const next = await client.request("templates.list", {});
      if (current === generation.current) setTemplates(next.filter((template) => !template.hidden));
    } catch (error) {
      if (current === generation.current) {
        setError(true);
        logWarn("templates.list_failed", errorFields(error));
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, connected]);

  useEffect(() => {
    void refresh();
    const off = client.on("templates.changed", () => void refresh());
    return () => {
      generation.current++;
      off();
    };
  }, [client, refresh]);

  return {
    templates,
    loading: connected && loading,
    waiting: !connected && !connectionError,
    error: error || (!connected && Boolean(connectionError)),
    connected,
    refresh,
  };
}
