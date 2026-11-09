import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Agent,
  AgentAvatar,
  type ConnectedApp,
  type MarketplaceFilters,
  type MarketplaceItem,
  MarketplaceRegistryEntry,
  ProviderId,
} from "@boto/protocol";
import { z } from "zod";
import type { AgentStore } from "./agents";
import { APP_CATALOG, APP_MARKETPLACE, type AppsService } from "./apps";
import { getSetting, setSetting } from "./db/settings";
import type { ProvidersService } from "./providers-service";
import { RpcError } from "./runtime/agent-runtime";
import { type SkillLibrary, skillSlug } from "./skills";

// Marketplace: JSON registries (http(s) or file URLs) listing skills and agent templates.
// Every file is verified against the sha256 in the index before it is installed.

export const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/fazedordecodigo/boto/main/marketplace/index.json";
const LEGACY_REGISTRIES = [
  "https://raw.githubusercontent.com/fazedordecodigo/bobagent/main/marketplace/index.json",
  "https://raw.githubusercontent.com/fazedordecodigo/upbot/main/marketplace/index.json",
];
const MAX_BYTES = 1024 * 1024;

const sourcesSchema = z.array(z.string()).nullable();

export class MarketplaceFetchError extends Error {
  constructor(
    readonly code: "unsupported_url" | "http_status" | "too_large" | "invalid_index",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketplaceFetchError";
  }
}

type IndexItem = z.infer<typeof MarketplaceRegistryEntry>;
type Artifact = { kind: "skill" | "agent"; name: string; hash: string; created: number };
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export const BUILTIN_APPS_SOURCE = "builtin:apps";
type Template = {
  name: string;
  instructions: string;
  avatar?: unknown;
  provider?: string;
  skills?: string[];
};

async function fetchBytes(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol === "file:") return readFileSync(fileURLToPath(u));
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new MarketplaceFetchError("unsupported_url", `unsupported URL ${url}`);
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok)
    throw new MarketplaceFetchError("http_status", `${url}: HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES)
    throw new MarketplaceFetchError("too_large", `${url} is larger than 1 MB`);
  return buf;
}

export class Marketplace {
  constructor(
    private db: Database,
    private skills: SkillLibrary,
    private agents: AgentStore,
    private apps: AppsService,
    private providers?: Pick<ProvidersService, "getDefault">,
  ) {}

  sources(): string[] {
    const saved = getSetting(this.db, "marketplace_sources", sourcesSchema, null);
    const registry = process.env.BOTO_MARKETPLACE_URL ?? DEFAULT_REGISTRY;
    if (!saved) return [registry];
    return [
      ...new Set(
        saved.map((u) => (u === DEFAULT_REGISTRY || LEGACY_REGISTRIES.includes(u) ? registry : u)),
      ),
    ];
  }

  setSources(urls: string[]): void {
    for (const u of urls) {
      let p: string;
      try {
        p = new URL(u).protocol;
      } catch {
        throw new RpcError("bad_request", `invalid URL: ${u}`);
      }
      if (!["https:", "http:", "file:"].includes(p))
        throw new RpcError("bad_request", `unsupported URL: ${u}`);
    }
    setSetting(this.db, "marketplace_sources", [...new Set(urls)]);
  }

  private async index(source: string): Promise<IndexItem[]> {
    const raw = JSON.parse((await fetchBytes(source)).toString("utf8")) as { items?: unknown[] };
    if (!Array.isArray(raw.items))
      throw new MarketplaceFetchError("invalid_index", `${source} is not a marketplace index`);
    const items = raw.items.flatMap((rawItem) => {
      const result = MarketplaceRegistryEntry.safeParse(rawItem);
      return result.success ? [result.data] : [];
    });
    return items.filter(
      (item) =>
        item.kind !== "plugin" ||
        item.skills?.every((id) =>
          items.some((skill) => skill.id === id && skill.kind === "skill"),
        ),
    );
  }

  private installed(item: IndexItem, source: string): boolean {
    if (item.kind === "plugin")
      return (
        !!this.db
          .query("SELECT 1 FROM marketplace_installations WHERE source = ? AND item_id = ?")
          .get(source, item.id) &&
        (
          this.db
            .query(
              "SELECT name FROM marketplace_artifacts WHERE source = ? AND item_id = ? AND kind = 'skill'",
            )
            .all(source, item.id) as { name: string }[]
        ).every((artifact) => this.skills.get(artifact.name) !== null)
      );
    if (item.kind === "skill") return this.skills.get(item.name ?? item.id) !== null;
    return this.agents.list().some((a) => a.name === (item.name ?? item.id));
  }

  private builtinItems(): MarketplaceItem[] {
    const connected = this.apps.list();
    return APP_CATALOG.filter(
      (entry) => entry.id !== "custom-stdio" && entry.id !== "custom-http",
    ).map((entry) => {
      const metadata = APP_MARKETPLACE[entry.id];
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        kind: metadata?.kind ?? "app",
        category: metadata?.category ?? "Outros",
        featured: metadata?.featured ?? false,
        icon: metadata?.icon ?? null,
        author: metadata?.author ?? entry.name,
        homepage: entry.docsUrl,
        catalogId: entry.id,
        secrets: entry.secrets,
        includes: [],
        source: BUILTIN_APPS_SOURCE,
        installed: connected.some((app) => app.catalogId === entry.id),
        version:
          entry.command
            ?.map((arg) => arg.match(/@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1])
            .find(Boolean) ?? "",
        url: "",
        sha256: "",
      };
    });
  }

  async list(filters: MarketplaceFilters = {}): Promise<{
    items: MarketplaceItem[];
    errors: { source: string; error: string }[];
    categories: { name: string; count: number }[];
  }> {
    const items: MarketplaceItem[] = [];
    const errors: { source: string; error: string }[] = [];
    for (const source of this.sources()) {
      try {
        const all = await this.index(source);
        for (const i of all) {
          items.push({
            id: i.id,
            kind: i.kind,
            name: String(i.name ?? i.id),
            description: String(i.description ?? ""),
            author: String(i.author ?? ""),
            version: String(i.version ?? ""),
            url: i.url,
            sha256: i.sha256,
            category: i.category,
            featured: i.featured,
            icon: i.icon,
            homepage: i.homepage,
            catalogId: null,
            secrets: [],
            includes: i.kind === "skill" ? [] : (i.skills ?? []),
            source,
            installed: this.installed(i, source),
          });
        }
      } catch (e) {
        errors.push({ source, error: (e as Error).message });
      }
    }
    items.push(...this.builtinItems());
    const byKind = items.filter((item) => !filters.kind || item.kind === filters.kind);
    const counts = new Map<string, number>();
    for (const item of byKind) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    const normalize = (value: string) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const query = normalize(filters.query ?? "");
    return {
      items: byKind.filter(
        (item) =>
          (!filters.category || item.category === filters.category) &&
          [item.name, item.description, item.category, item.author].some((value) =>
            normalize(value).includes(query),
          ),
      ),
      errors,
      categories: [...counts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    };
  }

  async get(id: string, source?: string): Promise<MarketplaceItem> {
    const item = (await this.list()).items.find(
      (item) => item.id === id && (!source || item.source === source),
    );
    if (!item) throw new RpcError("not_found", "marketplace item not found");
    return item;
  }

  private async download(source: string, item: IndexItem): Promise<string> {
    const buf = await fetchBytes(new URL(item.url, source).href);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== item.sha256)
      throw new RpcError("bad_request", `checksum mismatch for ${item.id}; not installed`);
    return buf.toString("utf8");
  }

  private remember(
    source: string,
    owner: string,
    kind: Artifact["kind"],
    name: string,
    raw: string,
    created: boolean,
  ) {
    const hash = fingerprint(raw);
    const previous = this.db
      .query(
        "SELECT hash, created FROM marketplace_artifacts WHERE source = ? AND item_id = ? AND kind = ? AND name = ?",
      )
      .get(source, owner, kind, name) as Pick<Artifact, "hash" | "created"> | null;
    this.db
      .query(
        "INSERT OR REPLACE INTO marketplace_artifacts (source, item_id, kind, name, hash, created) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        source,
        owner,
        kind,
        name,
        hash,
        created || (previous?.created && previous.hash === hash) ? 1 : 0,
      );
  }

  uninstall(source: string, id: string) {
    const artifacts = this.db
      .query(
        "SELECT kind, name, hash, created FROM marketplace_artifacts WHERE source = ? AND item_id = ?",
      )
      .all(source, id) as Artifact[];
    const removed: string[] = [];
    const preserved: string[] = [];
    const agents: string[] = [];
    for (const artifact of artifacts) {
      const skill = artifact.kind === "skill" ? this.skills.get(artifact.name) : null;
      const agent = artifact.kind === "agent" ? this.agents.get(artifact.name) : null;
      const raw = skill?.raw ?? (agent ? JSON.stringify(agent) : null);
      if (raw === null) continue;
      const referenced = this.db
        .query(
          "SELECT 1 FROM marketplace_artifacts WHERE kind = ? AND name = ? AND NOT (source = ? AND item_id = ?) LIMIT 1",
        )
        .get(artifact.kind, artifact.name, source, id);
      if (!artifact.created || fingerprint(raw) !== artifact.hash || referenced) {
        preserved.push(artifact.name);
        continue;
      }
      if (artifact.kind === "skill") this.skills.removeUnmodified(artifact.name, raw);
      else if (this.agents.softDelete(artifact.name)) agents.push(artifact.name);
      removed.push(artifact.name);
    }
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM marketplace_artifacts WHERE source = ? AND item_id = ?")
        .run(source, id);
      this.db
        .query("DELETE FROM marketplace_installations WHERE source = ? AND item_id = ?")
        .run(source, id);
    })();
    return { ok: true as const, removed, preserved, agents };
  }

  private async installSkill(source: string, item: IndexItem, owner: string) {
    const text = await this.download(source, item);
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const meta: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const name = skillSlug(meta.name ?? item.name ?? item.id);
    const existing = this.skills.get(name);
    const skill =
      existing ??
      this.skills.save(
        {
          name,
          description: meta.description ?? item.description ?? "",
          body: m ? (m[2] ?? "") : text,
          author: `marketplace:${item.author || "unknown"}`,
        },
        "create",
      );
    this.remember(source, owner, "skill", skill.name, this.skills.get(skill.name)!.raw, !existing);
    return skill;
  }

  async install(
    source: string,
    id: string,
    provider?: string,
    options: Pick<Parameters<AppsService["connect"]>[0], "permissions" | "secrets"> = {
      secrets: {},
    },
  ): Promise<{ skills: string[]; agent: Agent | null; app: ConnectedApp | null }> {
    if (source === BUILTIN_APPS_SOURCE) {
      const item = this.builtinItems().find((item) => item.id === id);
      if (!item?.catalogId) throw new RpcError("not_found", "marketplace app not found");
      return {
        skills: [],
        agent: null,
        app: this.apps.connect({ catalogId: item.catalogId, ...options }),
      };
    }
    if (!this.sources().includes(source))
      throw new RpcError("bad_request", "unknown marketplace source");
    const all = await this.index(source);
    const item = all.find((i) => i.id === id);
    if (!item) throw new RpcError("not_found", `no item "${id}" in ${source}`);
    const finish = <T>(result: T): T => {
      this.db
        .query("INSERT OR IGNORE INTO marketplace_installations (source, item_id) VALUES (?, ?)")
        .run(source, id);
      return result;
    };
    if (item.kind === "skill")
      return finish({
        skills: [(await this.installSkill(source, item, id)).name],
        agent: null,
        app: null,
      });
    if (item.kind === "plugin") {
      const skills: string[] = [];
      for (const skillId of item.skills ?? []) {
        const skill = all.find((entry) => entry.kind === "skill" && entry.id === skillId);
        if (!skill) throw new RpcError("bad_request", "plugin skill not found");
        skills.push((await this.installSkill(source, skill, id)).name);
      }
      return finish({ skills, agent: null, app: null });
    }
    const t = JSON.parse(await this.download(source, item)) as Template;
    if (typeof t.name !== "string" || typeof t.instructions !== "string") {
      throw new RpcError("bad_request", "invalid agent template");
    }
    const prov = ProviderId.safeParse(
      provider ?? t.provider ?? this.providers?.getDefault().provider ?? "claude",
    );
    if (!prov.success) throw new RpcError("bad_request", "unknown provider");
    const skills: string[] = [];
    for (const sid of t.skills ?? []) {
      const s = all.find((i) => i.id === sid && i.kind === "skill");
      if (s) skills.push((await this.installSkill(source, s, id)).name);
    }
    const avatar = AgentAvatar.safeParse(t.avatar);
    const agent = this.agents.create({
      name: t.name.slice(0, 80),
      instructions: t.instructions,
      provider: prov.data,
      avatar: avatar.success ? avatar.data : null,
    });
    this.remember(source, id, "agent", agent.id, JSON.stringify(agent), true);
    return finish({ skills, agent, app: null });
  }
}
