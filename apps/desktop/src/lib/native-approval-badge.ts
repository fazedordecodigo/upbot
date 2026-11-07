import { useEffect } from "react";
import { ApprovalBadge } from "./approval-badge";
import type { DaemonClient } from "./daemon";
import { nativeCommand } from "./native";

export function useApprovalBadge(client: DaemonClient, ready: boolean) {
  useEffect(() => {
    if (!ready || !("__TAURI_INTERNALS__" in window)) return;
    const badge = new ApprovalBadge(client, (count) =>
      nativeCommand("set_approval_badge", { count }),
    );
    void badge.start();
    return () => badge.stop();
  }, [client, ready]);
}
