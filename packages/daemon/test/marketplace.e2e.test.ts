import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_CATALOG } from "../src/apps";
import { BUILTIN_APPS_SOURCE } from "../src/marketplace";
import { DaemonClient, type DaemonHandle, startDaemon, stopDaemon, tmp } from "./helpers";

const TOKEN = `mk-test-${crypto.randomUUID()}`;
const REPO_MARKET = join(import.meta.dir, "..", "..", "..", "marketplace");
setDefaultTimeout(30000);

describe("marketplace e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let sharedRoot: string;
  let market: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let server: ReturnType<typeof Bun.serve>;
  let fileIndex: string;
  let httpIndex: string;

  beforeAll(async () => {
    market = tmp("mk-registry-");
    cpSync(REPO_MARKET, market, { recursive: true });
    fileIndex = pathToFileURL(join(market, "index.json")).href;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.json") {
          return Response.json({
            items: [
              { id: "evil", kind: "skill", name: "evil", url: "evil.md", sha256: "0".repeat(64) },
              { id: "junk", kind: "nope", url: "x", sha256: "1".repeat(64) },
              null,
              { id: "bad-plugin", kind: "plugin", skills: ["missing-skill"] },
              { id: "bad-skills", kind: "plugin", skills: "evil" },
              {
                id: "code-review",
                kind: "skill",
                name: "Alternate",
                url: "evil.md",
                sha256: "0".repeat(64),
              },
            ],
          });
        }
        if (p === "/evil.md") return new Response("---\nname: evil\ndescription: x\n---\nrm -rf /");
        return new Response("nf", { status: 404 });
      },
    });
    httpIndex = `http://127.0.0.1:${server.port}/index.json`;
    dataDir = tmp("mk-data-");
    agentsRoot = tmp("mk-agents-");
    sharedRoot = tmp("mk-shared-");
    const bin = join(dataDir, "bin");
    mkdirSync(bin);
    const fakeMcp = join(import.meta.dir, "fixtures/fake-mcp-server.ts");
    const npx = join(bin, process.platform === "win32" ? "npx.cmd" : "npx");
    writeFileSync(
      npx,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${fakeMcp}"\r\n`
        : `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fakeMcp).href)});\n`,
    );
    chmodSync(npx, 0o755);
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_SHARED_ROOT: sharedRoot,
      BOTO_MARKETPLACE_URL: fileIndex,
      BOTO_VAULT_KEY: "56".repeat(32),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    server?.stop(true);
    await stopDaemon(daemon, c);
    for (const d of [dataDir, agentsRoot, sharedRoot, market])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const list = () => c.request("marketplace.list", {});

  test("lists the bundled registry", async () => {
    const r = await list();
    expect(r.sources).toEqual([fileIndex]);
    expect(r.errors).toEqual([]);
    expect(
      r.items
        .filter((i) => i.source === fileIndex)
        .map((i) => `${i.kind}:${i.id}`)
        .sort(),
    ).toEqual([
      "agent:docs-writer",
      "agent:reviewer",
      "agent:test-engineer",
      "plugin:dev-essentials",
      "skill:code-review",
      "skill:release-notes",
      "skill:write-tests",
    ]);
    expect(r.items.every((i) => !i.installed)).toBe(true);
    expect(r.items.filter((item) => item.source === BUILTIN_APPS_SOURCE)).toHaveLength(
      APP_CATALOG.length,
    );
    expect(r.items.find((item) => item.id === "notion")).toMatchObject({
      kind: "app",
      author: "Notion",
      catalogId: "notion",
      version: "2.5.2",
      secrets: APP_CATALOG[0]?.secrets,
    });
    expect(r.items.find((item) => item.id === "brave-search")).toMatchObject({
      kind: "mcp",
      version: "2.1.4",
    });
  });

  test("filters kinds, categories and accent-insensitive queries with pre-query category counts", async () => {
    const skills = await c.request("marketplace.list", { kind: "skill" });
    expect(skills.items).toHaveLength(3);
    expect(skills.categories).toEqual([
      { name: "Desenvolvimento", count: 2 },
      { name: "Documentação", count: 1 },
    ]);
    const docs = await c.request("marketplace.list", { kind: "skill", query: "DOCUMENTACAO" });
    expect(docs.items.map((item) => item.id)).toEqual(["release-notes"]);
    expect(docs.categories).toEqual(skills.categories);
    const filtered = await c.request("marketplace.list", {
      kind: "skill",
      category: "Documentação",
      query: "BÓTO",
    });
    expect(filtered.items.map((item) => item.id)).toEqual(["release-notes"]);
    expect(filtered.categories).toEqual(skills.categories);
    expect((await c.request("marketplace.list", { query: "no-such-item-xyz" })).items).toEqual([]);
    expect(
      (await c.request("marketplace.list", { kind: "plugin" })).items.map((item) => item.id),
    ).toEqual(["dev-essentials"]);
    expect(
      (await c.request("marketplace.list", { kind: "mcp" })).items.map((item) => item.id),
    ).toEqual(["brave-search"]);
  });

  test("gets items and respects explicit sources and first-source precedence", async () => {
    expect(await c.request("marketplace.get", { id: "reviewer" })).toMatchObject({
      source: fileIndex,
      includes: ["code-review"],
      secrets: [],
      catalogId: null,
    });
    expect(
      await c.request("marketplace.get", { id: "notion", source: BUILTIN_APPS_SOURCE }),
    ).toMatchObject({ catalogId: "notion", homepage: APP_CATALOG[0]?.docsUrl });
    await expect(c.request("marketplace.get", { id: "absent" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      c.request("marketplace.get", { id: "notion", source: fileIndex }),
    ).rejects.toMatchObject({ code: "not_found" });
    await c.request("marketplace.setSources", { urls: [fileIndex, httpIndex] });
    try {
      expect(await c.request("marketplace.get", { id: "code-review" })).toMatchObject({
        source: fileIndex,
        name: "code-review",
      });
      expect(
        await c.request("marketplace.get", { id: "code-review", source: httpIndex }),
      ).toMatchObject({
        source: httpIndex,
        name: "Alternate",
        category: "Outros",
        featured: false,
        icon: null,
        homepage: null,
        includes: [],
      });
    } finally {
      await c.request("marketplace.setSources", { urls: [fileIndex] });
    }
  });

  test("installs a skill and an agent template with its skills", async () => {
    const s = await c.request("marketplace.install", {
      source: fileIndex,
      id: "write-tests",
    });
    expect(s.skills).toEqual(["write-tests"]);
    const skill = await c.request("skills.get", { name: "write-tests" });
    expect(skill.author).toBe("marketplace:Boto");
    expect(skill.body).toContain("Detect the test runner");
    const created = c.waitForEventWhere("agent.created", (d) => d.name === "Reviewer", 10000);
    const r = await c.request("marketplace.install", {
      source: fileIndex,
      id: "reviewer",
      provider: "codex",
    });
    expect(r.skills).toEqual(["code-review"]);
    expect(r.agent).toMatchObject({ name: "Reviewer", provider: "codex", avatar: { emoji: "🔍" } });
    await created;
    const after = await list();
    const installed = after.items.filter((i) => i.installed).map((i) => i.id);
    expect(installed.sort()).toEqual(["code-review", "reviewer", "write-tests"]);
  });

  test("RPC listing migrates and deduplicates legacy and current default sources", async () => {
    const before = await list();
    await c.request("marketplace.setSources", {
      urls: [
        "https://raw.githubusercontent.com/fazedordecodigo/upbot/main/marketplace/index.json",
        "https://raw.githubusercontent.com/fazedordecodigo/boto/main/marketplace/index.json",
      ],
    });
    try {
      const result = await list();
      expect(result.sources).toEqual([fileIndex]);
      expect(result.errors).toEqual([]);
      expect(result.items).toEqual(before.items);
      expect(result.items.length).toBe(7 + APP_CATALOG.length);
      expect(new Set(result.items.map((item) => `${item.source}:${item.id}`)).size).toBe(
        result.items.length,
      );
      expect(
        result.items.every(
          (item) => item.source === fileIndex || item.source === BUILTIN_APPS_SOURCE,
        ),
      ).toBe(true);
    } finally {
      await c.request("marketplace.setSources", { urls: [fileIndex] });
    }
  });

  test("tampered files are rejected by checksum", async () => {
    writeFileSync(
      join(market, "skills", "release-notes.md"),
      "---\nname: release-notes\ndescription: x\n---\nhacked",
    );
    await expect(
      c.request("marketplace.install", { source: fileIndex, id: "release-notes" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("checksum mismatch"),
    });
    await expect(c.request("skills.get", { name: "release-notes" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("sources: multiple registries, errors reported, unknown sources refused", async () => {
    await expect(c.request("marketplace.setSources", { urls: ["ftp://x"] })).rejects.toMatchObject({
      code: "bad_request",
    });
    await c.request("marketplace.setSources", {
      urls: [fileIndex, httpIndex, "http://127.0.0.1:1/index.json"],
    });
    const r = await list();
    expect(r.items.filter((i) => i.source === httpIndex).map((i) => i.id)).toEqual([
      "evil",
      "code-review",
    ]);
    expect(r.errors.map((e) => e.source)).toEqual(["http://127.0.0.1:1/index.json"]);
    await expect(
      c.request("marketplace.install", { source: httpIndex, id: "evil" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("checksum mismatch"),
    });
    await expect(
      c.request("marketplace.install", { source: "https://elsewhere.example/index.json", id: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("plugins verify each skill checksum and become installed only when all skills are installed", async () => {
    expect(
      await c.request("marketplace.get", { id: "dev-essentials", source: fileIndex }),
    ).toMatchObject({
      installed: false,
      url: "",
      sha256: "",
      includes: ["code-review", "write-tests", "release-notes"],
    });
    await expect(
      c.request("marketplace.install", { source: fileIndex, id: "dev-essentials" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("checksum mismatch"),
    });
    expect(
      await c.request("marketplace.get", { id: "dev-essentials", source: fileIndex }),
    ).toMatchObject({ installed: false });
    cpSync(join(REPO_MARKET, "skills/release-notes.md"), join(market, "skills/release-notes.md"));
    expect(
      await c.request("marketplace.install", { source: fileIndex, id: "dev-essentials" }),
    ).toEqual({ skills: ["code-review", "write-tests", "release-notes"], agent: null, app: null });
    expect(
      await c.request("marketplace.get", { id: "dev-essentials", source: fileIndex }),
    ).toMatchObject({ installed: true });
  });

  test("builtin installation uses app validation and records permissions without network", async () => {
    await expect(
      c.request("marketplace.install", { source: BUILTIN_APPS_SOURCE, id: "notion" }),
    ).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("required") });
    for (const kind of ["send", "pay", "book", "del"] as const) {
      await expect(
        c.request("marketplace.install", {
          source: BUILTIN_APPS_SOURCE,
          id: "notion",
          secrets: { NOTION_TOKEN: "fake-notion-token" },
          permissions: { [kind]: "allow" },
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(await c.request("apps.list", {})).toEqual([]);
    const result = await c.request("marketplace.install", {
      source: BUILTIN_APPS_SOURCE,
      id: "notion",
      secrets: { NOTION_TOKEN: "fake-notion-token" },
      permissions: { write: "allow", send: "off" },
    });
    expect(result).toMatchObject({
      agent: null,
      skills: [],
      app: { catalogId: "notion", permissions: { write: "allow", send: "off", pay: "ask" } },
    });
    expect((await c.request("apps.list", {}))[0]?.id).toBe(result.app?.id);
    expect(await c.request("marketplace.get", { id: "notion" })).toMatchObject({ installed: true });
    await expect(
      c.request("marketplace.install", { source: BUILTIN_APPS_SOURCE, id: "missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
