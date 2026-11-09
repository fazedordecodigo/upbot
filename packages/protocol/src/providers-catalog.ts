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
