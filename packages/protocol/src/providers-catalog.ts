import { z } from "zod";
import type { Agent, AgentsCreateParams, AppPermissions, ConnectedApp } from "./index";

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
  "aider",
]);
export const DefaultProvider = CatalogProvider.nullable();
export const ProviderInfo = z.object({
  id: CatalogProvider,
  name: z.string(),
  vendor: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  installHint: z.string(),
  installRunning: z.boolean(),
  installError: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  hasApiKey: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  canLogin: z.boolean(),
  loginRunning: z.boolean(),
  ready: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;
/** Provider logins injected into Firecracker microVM sessions (values never leave the daemon). */
export const VmCredentialProvider = z.enum([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "grok",
  "openrouter",
  "openai-compatible",
]);
export type VmCredentialProvider = z.infer<typeof VmCredentialProvider>;
export const VmCredentialKind = z.enum(["oauth_token", "api_key"]);
export type VmCredentialKind = z.infer<typeof VmCredentialKind>;
export const VmCredential = z.object({
  provider: VmCredentialProvider,
  kind: VmCredentialKind,
  updatedAt: z.number(),
});
export type VmCredential = z.infer<typeof VmCredential>;
/** Saved-key status for one credential provider; `endpoint` is the configured
 * OpenAI-compatible base URL and stays null for every other provider. */
export const ProviderKeyInfo = z.object({
  provider: VmCredentialProvider,
  hasApiKey: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  endpoint: z.string().nullable(),
});
export type ProviderKeyInfo = z.infer<typeof ProviderKeyInfo>;
export const OpenAiCompatibleEndpoint = z.string().trim().max(2048);
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
const apiKey = z.string().trim().min(8).max(4096);
export const providersCatalogMethods = {
  "providers.list": { params: empty, result: z.array(ProviderInfo) },
  "providers.scan": { params: empty, result: z.array(ProviderInfo) },
  "providers.login": { params: provider, result: ProviderInfo },
  "providers.install": { params: provider, result: ProviderInfo },
  "providers.listApiKeys": { params: empty, result: z.array(ProviderKeyInfo) },
  "providers.setApiKey": {
    params: z.object({ provider: VmCredentialProvider, value: apiKey }).strict(),
    result: z.union([ProviderInfo, ProviderKeyInfo]),
  },
  "providers.deleteApiKey": {
    params: z.object({ provider: VmCredentialProvider }).strict(),
    result: z.union([ProviderInfo, ProviderKeyInfo]),
  },
  "providers.setEndpoint": {
    params: z.object({ url: OpenAiCompatibleEndpoint.min(8), apiKey: apiKey.optional() }).strict(),
    result: ProviderKeyInfo,
  },
  "providers.getDefault": { params: empty, result: z.object({ provider: DefaultProvider }) },
  "providers.setDefault": { params: provider, result: provider },
};

export const AppSecretSpec = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  header: z.string().nullable(),
});
const MarketplaceKind = z.enum(["app", "plugin", "skill", "mcp", "agent"]);
export const MarketplaceItem = z.object({
  id: z.string(),
  kind: MarketplaceKind,
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  url: z.string(),
  sha256: z.string(),
  source: z.string(),
  installed: z.boolean(),
  category: z.string(),
  featured: z.boolean(),
  icon: z.string().nullable(),
  homepage: z.string().nullable(),
  catalogId: z.string().nullable(),
  secrets: z.array(AppSecretSpec),
  includes: z.array(z.string()),
});
export type MarketplaceItem = z.infer<typeof MarketplaceItem>;
export const MarketplaceFilters = z
  .object({
    kind: MarketplaceKind.optional(),
    category: z.string().optional(),
    query: z.string().optional(),
  })
  .strict();
export type MarketplaceFilters = z.infer<typeof MarketplaceFilters>;
export const MarketplaceRegistryEntry = z
  .object({
    id: z.string(),
    kind: z.enum(["skill", "agent", "plugin"]),
    name: z.string().optional(),
    description: z.string().default(""),
    author: z.string().default(""),
    version: z.string().default(""),
    url: z.string().default(""),
    sha256: z.string().default(""),
    category: z.string().default("Outros"),
    featured: z.boolean().default(false),
    icon: z.string().nullable().default(null),
    homepage: z.string().nullable().default(null),
    skills: z.array(z.string()).optional(),
  })
  .refine((item) =>
    item.kind === "plugin"
      ? item.skills !== undefined
      : /^[0-9a-f]{64}$/.test(item.sha256) && item.url.length > 0,
  );

export function marketplaceMethods(
  agent: typeof Agent,
  app: typeof ConnectedApp,
  permissions: typeof AppPermissions,
) {
  return {
    "marketplace.list": {
      params: MarketplaceFilters,
      result: z.object({
        sources: z.array(z.string()),
        items: z.array(MarketplaceItem),
        errors: z.array(z.object({ source: z.string(), error: z.string() })),
        categories: z.array(z.object({ name: z.string(), count: z.number() })),
      }),
    },
    "marketplace.get": {
      params: z.object({ id: z.string(), source: z.string().optional() }).strict(),
      result: MarketplaceItem,
    },
    "marketplace.uninstall": {
      params: z.object({ source: z.string(), id: z.string() }).strict(),
      result: z.object({
        ok: z.literal(true),
        removed: z.array(z.string()),
        preserved: z.array(z.string()),
        agents: z.array(z.string()),
      }),
    },
    "marketplace.install": {
      params: z
        .object({
          source: z.string(),
          id: z.string(),
          provider: CatalogProvider.optional(),
          secrets: z.record(z.string().max(64), z.string().max(20_000)).optional(),
          permissions: permissions.partial().optional(),
        })
        .strict(),
      result: z.object({
        skills: z.array(z.string()),
        agent: agent.nullable(),
        app: app.nullable(),
      }),
    },
  };
}
