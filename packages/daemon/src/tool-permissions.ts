import { AppPermissionKind, isSensitivePermission, type ToolPermission } from "@boto/protocol";
import type { ApprovalService } from "./approvals";
import type { AppsService } from "./apps";
import { RpcError } from "./runtime/agent-runtime";

const LABELS: Record<AppPermissionKind, string> = {
  read: "Ler",
  write: "Editar",
  send: "Enviar",
  pay: "Pagar",
  book: "Reservar",
  del: "Excluir",
};

export class ToolPermissions {
  constructor(
    private approvals: Pick<ApprovalService, "rules" | "setRules">,
    private apps: Pick<AppsService, "list" | "update">,
  ) {}

  list(): ToolPermission[] {
    return [
      ...this.approvals.rules().map(
        (rule): ToolPermission => ({
          toolId: `rule:${rule.id}`,
          label: rule.pattern,
          group: "computer",
          level: rule.action,
          levels: ["ask", "allow"],
          sensitive: false,
          agentId: rule.agentId,
          appId: null,
          permission: null,
        }),
      ),
      ...this.apps.list().flatMap((app) =>
        AppPermissionKind.options.map(
          (kind): ToolPermission => ({
            toolId: `app:${app.id}:${kind}`,
            label: `${app.name} · ${LABELS[kind]}`,
            group:
              app.catalogId === "custom-stdio" || app.catalogId === "custom-http" ? "mcp" : "app",
            level: app.permissions[kind],
            levels: isSensitivePermission(kind) ? ["off", "ask"] : ["off", "ask", "allow"],
            sensitive: isSensitivePermission(kind),
            agentId: null,
            appId: app.id,
            permission: kind,
          }),
        ),
      ),
    ];
  }

  async set(toolId: string, level: ToolPermission["level"]): Promise<ToolPermission[]> {
    const entry = this.list().find((permission) => permission.toolId === toolId);
    if (!entry) throw new RpcError("not_found", "tool permission not found");
    if (entry.permission !== null && entry.appId !== null) {
      if (entry.sensitive && level === "allow")
        throw new RpcError(
          "bad_request",
          "Permissões sensíveis aceitam apenas off ou ask; allow não é permitido.",
        );
      await this.apps.update({ id: entry.appId, permissions: { [entry.permission]: level } });
    } else {
      if (level === "off")
        throw new RpcError("bad_request", "Tool rules accept only ask or allow, not off.");
      this.approvals.setRules(
        this.approvals
          .rules()
          .map((rule) => (`rule:${rule.id}` === toolId ? { ...rule, action: level } : rule)),
      );
    }
    return this.list();
  }
}
