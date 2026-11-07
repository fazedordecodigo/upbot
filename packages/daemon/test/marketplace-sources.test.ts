import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentStore } from "../src/agents";
import { setSetting } from "../src/db/settings";
import { DEFAULT_REGISTRY, Marketplace } from "../src/marketplace";
import type { SkillLibrary } from "../src/skills";

describe("marketplace source migration", () => {
  test("uses the configured default when no sources are saved", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    try {
      const marketplace = new Marketplace(db, {} as SkillLibrary, {} as AgentStore);
      expect(DEFAULT_REGISTRY).toBe(
        "https://raw.githubusercontent.com/fazedordecodigo/boto/main/marketplace/index.json",
      );
      expect(marketplace.sources()).toEqual([process.env.BOTO_MARKETPLACE_URL ?? DEFAULT_REGISTRY]);
      marketplace.setSources([]);
      expect(marketplace.sources()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("migrates both old registries without changing custom sources", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    try {
      const marketplace = new Marketplace(db, {} as SkillLibrary, {} as AgentStore);
      const custom = "https://example.com/marketplace/index.json";
      marketplace.setSources([
        "https://raw.githubusercontent.com/fazedordecodigo/upbot/main/marketplace/index.json",
        "https://raw.githubusercontent.com/fazedordecodigo/bobagent/main/marketplace/index.json",
        custom,
      ]);
      expect(marketplace.sources()).toEqual([DEFAULT_REGISTRY, DEFAULT_REGISTRY, custom]);
      expect(() => marketplace.setSources(["ftp://example.com/index.json"])).toThrow(
        "unsupported URL",
      );
      expect(marketplace.sources()).toEqual([DEFAULT_REGISTRY, DEFAULT_REGISTRY, custom]);
      setSetting(db, "marketplace_sources", { invalid: true });
      expect(() => marketplace.sources()).toThrow("settings.marketplace_sources");
    } finally {
      db.close();
    }
  });
});
