import {
  classifyAppTool,
  classifyToolOperation,
  isSensitivePermission,
  type TaskToolMode,
} from "@boto/protocol";

// Pure per-task tool policy shared by the runtime (ACP permission requests) and the
// bridge (tools/list + tools/call). It can only remove tools or add approvals.

/** What the runtime and bridge need to know about the task owning a session. */
export type TaskRuntimeInfo = {
  id: string;
  agentId: string;
  toolMode: TaskToolMode;
  private: boolean;
  requireApproval: boolean;
  sessionId: string | null;
};

export type TaskRuntimeHooks = {
  get(taskId: string): TaskRuntimeInfo | null;
  /** The task's provider session started (or was dropped, with null). */
  setSession(taskId: string, sessionId: string | null): void;
  /** Prompt block prepended to the first prompt of a task's new session. */
  preamble(taskId: string): string;
};

const BROWSER_TOOL = /^(browser_[a-z_]+|request_takeover)$/;
const DESKTOP_TOOL = /^computer_[a-z_]+$/;
/** Built-in tools that read or write workspace files. */
const FILE_TOOLS = new Set(["share_file"]);

/**
 * Whether a bridge tool may be listed/called under a task's tool mode. Browser-only hides
 * file and desktop tools; terminal-only hides browser and desktop tools. Connected-app
 * tools are online services and stay available in every mode.
 */
export function bridgeToolAllowed(mode: TaskToolMode, tool: string, isApp: boolean): boolean {
  if (mode === "both" || isApp) return true;
  if (DESKTOP_TOOL.test(tool)) return false;
  if (mode === "browser") return !FILE_TOOLS.has(tool);
  return !BROWSER_TOOL.test(tool);
}

/** ACP tool kinds a provider asks permission for that a tool mode rejects. */
export function toolKindAllowed(mode: TaskToolMode, toolKind: string | null): boolean {
  if (mode === "both" || toolKind === null) return true;
  if (mode === "browser") return !["execute", "edit", "delete", "move"].includes(toolKind);
  return toolKind !== "fetch";
}

/** Tool calls that act outside the machine (send, publish, pay, book, delete). */
export function isExternalAction(tool: string, args: unknown, isApp: boolean): boolean {
  if (isApp) return isSensitivePermission(classifyAppTool(tool));
  if (tool === "github_api") {
    const method = (args as { method?: unknown } | null)?.method;
    return typeof method === "string" && method.toUpperCase() !== "GET";
  }
  const kind = classifyToolOperation(tool);
  return kind !== null && isSensitivePermission(kind);
}
