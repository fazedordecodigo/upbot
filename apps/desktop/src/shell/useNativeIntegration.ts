import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { errorMessage } from "../lib/errors";
import { nativeCommand } from "../lib/native";
import { useApprovalBadge } from "../lib/native-approval-badge";
import { useNativeNotifications } from "../lib/native-notifications";
import { useToast } from "../ui/Toast";
import { useDaemon } from "./daemon";
import { useRouter } from "./router";

export function useNativeIntegration() {
  const { client, ready, agents, setError } = useDaemon();
  const { navigate } = useRouter();
  const toast = useToast();
  const review = useCallback(
    (target: string, message?: string) => {
      if (message) toast(message);
      if (target === "apps" || target === "approvals" || target === "settings")
        navigate("settings");
      else if (agents.some((agent) => agent.id === target)) navigate("agents", { agentId: target });
      else navigate("home");
    },
    [agents, navigate, toast],
  );
  useNativeNotifications(client, ready, agents, review, setError);
  useApprovalBadge(client, ready);
  const approvals = useDaemonQuery(
    client,
    "approvals.list",
    {},
    { enabled: ready, events: { "approval.updated": true } },
  );
  const approvalCount = approvals.data?.filter((item) => item.status === "pending").length;
  useEffect(() => {
    if (approvalCount === undefined) return;
    void nativeCommand("set_tray_count", { count: approvalCount }).catch(
      (error: unknown) => setError(errorMessage(error)),
    );
  }, [approvalCount, setError]);
  useEffect(() => {
    if (!ready || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("boto://navigate", ({ payload }) => review(payload))
      .then((off) => {
        if (disposed) off();
        else {
          unlisten = off;
          return nativeCommand("main_ready");
        }
      })
      .catch((error: unknown) => setError(errorMessage(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ready, review, setError]);
}
