import { z } from "zod";
import type { AgentsCreateParams } from "./index";

export function providersCreateParams(schema: typeof AgentsCreateParams) {
  return schema.extend({ provider: CatalogProvider.optional() });
}

const CatalogProvider = z.enum([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "cursor",
  "devin",
  "grok",
  "openai-compatible",
]);
const KeyProvider = CatalogProvider.exclude(["opencode", "openai-compatible"]);
export const DefaultProvider = CatalogProvider.nullable();
export const ProviderInfo = z.object({
  id: CatalogProvider,
  name: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  installHint: z.string(),
  loggedIn: z.boolean().nullable(),
  hasApiKey: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  loginRunning: z.boolean(),
  ready: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;
const empty = z.object({}).strict();
const PermissionLevel = z.enum(["ask", "allow", "off"]);
export const ToolPermission = z.object({
  toolId: z.string(),
  label: z.string(),
  group: z.enum(["computer", "app", "mcp"]),
  level: PermissionLevel,
  levels: z.array(PermissionLevel),
  sensitive: z.boolean(),
  agentId: z.string().nullable(),
  appId: z.string().nullable(),
  permission: z.enum(["read", "write", "send", "pay", "book", "del"]).nullable(),
});
export type ToolPermission = z.infer<typeof ToolPermission>;
export const toolPermissionMethods = {
  "tools.permissions.list": { params: empty, result: z.array(ToolPermission) },
  "tools.permissions.set": {
    params: z.object({ toolId: z.string(), level: PermissionLevel }).strict(),
    result: z.array(ToolPermission),
  },
};
const provider = z.object({ provider: CatalogProvider }).strict();
export const providersCatalogMethods = {
  "providers.list": { params: empty, result: z.array(ProviderInfo) },
  "providers.scan": { params: empty, result: z.array(ProviderInfo) },
  "providers.login": { params: provider, result: ProviderInfo },
  "providers.setApiKey": {
    params: z.object({ provider: KeyProvider, value: z.string().trim().min(8).max(4096) }).strict(),
    result: ProviderInfo,
  },
  "providers.deleteApiKey": {
    params: z.object({ provider: KeyProvider }).strict(),
    result: ProviderInfo,
  },
  "providers.getDefault": { params: empty, result: z.object({ provider: DefaultProvider }) },
  "providers.setDefault": { params: provider, result: provider },
};
