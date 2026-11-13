import type { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { DEFAULT_BOT_INSTRUCTIONS, DEFAULT_BOT_NAME, migrateDefaultBot } from "../src/persona";
import { removeDir } from "./helpers";

// A fresh database applies every migration. On windows-latest run 41279161718
// the first case took 5123ms and bun's 5s default failed it; the same case was
// 195ms on the next green run. Other daemon e2e files use 30s. The handle is
// closed and the temp dirs removed so Windows can drop the lock.
setDefaultTimeout(30_000);

async function withStore(run: (db: Database, store: AgentStore) => void) {
  const data = mkdtempSync(join(tmpdir(), "boto-data-"));
  const root = mkdtempSync(join(tmpdir(), "boto-root-"));
  const db = openDatabase(data);
  try {
    run(db, new AgentStore(db, join(root, "agents")));
  } finally {
    db.close();
    await removeDir(data);
    await removeDir(root);
  }
}

/** Inserts a legacy agent row without adopting `default_bot_id`. */
function insertAgent(
  db: Database,
  fields: {
    name: string;
    provider?: string;
    instructions?: string;
    created_at?: number;
  },
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO agents (id, name, instructions, provider, config_json, workspace_path, avatar_json, created_at, updated_at, role, require_approval, max_instances)
     VALUES (?, ?, ?, ?, '{}', ?, NULL, ?, ?, '', 1, NULL)`,
  ).run(
    id,
    fields.name,
    fields.instructions ?? "",
    fields.provider ?? "claude",
    `/tmp/boto-agent-${id}`,
    fields.created_at ?? now,
    now,
  );
  return id;
}

describe("default bot", () => {
  for (const deletedOldest of [false, true]) {
    test(`backfills the oldest historical legacy bot once (oldest deleted: ${deletedOldest})`, async () => {
      await withStore((db, store) => {
        const oldest = insertAgent(db, {
          name: "Edited assistant",
          instructions: "Edited",
          created_at: 1,
        });
        insertAgent(db, { name: "Another assistant", provider: "codex", created_at: 2 });
        const namesake = insertAgent(db, {
          name: DEFAULT_BOT_NAME,
          instructions: DEFAULT_BOT_INSTRUCTIONS,
          created_at: 3,
        });
        if (deletedOldest) store.softDelete(oldest);
        db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
        migrateDefaultBot(db);
        expect(
          store
            .list()
            .filter((bot) => bot.isDefault)
            .map((bot) => bot.id),
        ).toEqual(deletedOldest ? [] : [oldest]);
        expect(db.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get()).toEqual({
          value: JSON.stringify(oldest),
        });
        expect(db.query("SELECT instructions FROM agents WHERE id = ?").get(oldest)).toEqual({
          instructions: "Edited",
        });
        db.query("UPDATE agents SET created_at = 0 WHERE id = ?").run(namesake);
        migrateDefaultBot(db);
        expect(store.get(oldest)?.isDefault ?? false).toBe(!deletedOldest);
        store.softDelete(oldest);
        migrateDefaultBot(db);
        expect(store.list().some((bot) => bot.isDefault)).toBe(false);
        expect(store.list()).toHaveLength(2);
      });
    });
  }

  for (const deletedHistory of [false, true]) {
    test(`preserves the historical identity when no active bots exist (deleted history: ${deletedHistory})`, async () => {
      await withStore((db, store) => {
        const deleted = deletedHistory ? insertAgent(db, { name: "Deleted assistant" }) : null;
        if (deleted) store.softDelete(deleted);
        db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
        migrateDefaultBot(db);
        expect(store.list()).toEqual([]);
        expect(db.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get()).toEqual({
          value: JSON.stringify(deleted ?? null),
        });
        insertAgent(db, { name: DEFAULT_BOT_NAME, instructions: DEFAULT_BOT_INSTRUCTIONS });
        migrateDefaultBot(db);
        expect(store.list().some((bot) => bot.isDefault)).toBe(false);
        expect(store.list()).toHaveLength(1);
      });
    });
  }

  test("updates an unchanged seeded UpBot without modifying custom bots", async () => {
    await withStore((db, store) => {
      const legacy = insertAgent(db, {
        name: "UpBot",
        instructions: DEFAULT_BOT_INSTRUCTIONS.replace("You are Boto", "You are UpBot"),
        created_at: 0,
      });
      const custom = insertAgent(db, {
        name: "UpBot",
        instructions: "My customized assistant",
      });
      db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
      migrateDefaultBot(db);
      migrateDefaultBot(db);
      expect(store.get(legacy)?.name).toBe("Boto");
      expect(store.get(legacy)?.instructions).toBe(DEFAULT_BOT_INSTRUCTIONS);
      expect(store.get(legacy)?.isDefault).toBe(true);
      expect(store.get(custom)?.isDefault).toBe(false);
      expect(store.get(custom)?.name).toBe("UpBot");
      expect(store.get(custom)?.instructions).toBe("My customized assistant");
    });
  });

  test("creates no bot on a fresh install", async () => {
    await withStore((db, store) => {
      migrateDefaultBot(db);
      expect(store.list()).toEqual([]);
      expect(db.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get()).toBeNull();
    });
  });

  test("leaves an install that never had the seed untouched", async () => {
    await withStore((db, store) => {
      store.create({ name: "Mine", provider: "codex", instructions: "" });
      migrateDefaultBot(db);
      expect(store.list().map((a) => a.name)).toEqual(["Mine"]);
    });
  });

  test("adopts the first created bot as the default and never adopts again", async () => {
    await withStore((_db, store) => {
      const first = store.create({ name: "Mine", provider: "codex" });
      expect(store.get(first.id)?.isDefault).toBe(true);
      const second = store.create({ name: "Other", provider: "claude" });
      expect(store.get(second.id)?.isDefault).toBe(false);
      store.softDelete(first.id);
      const third = store.create({ name: "New", provider: "devin" });
      expect(store.get(third.id)?.isDefault).toBe(false);
    });
  });

  test("adopts the next created bot when the stored default is null", async () => {
    await withStore((db, store) => {
      db.query("INSERT INTO settings (key,value) VALUES ('default_bot_id','null')").run();
      const bot = store.create({ name: "Mine", provider: "claude" });
      expect(store.get(bot.id)?.isDefault).toBe(true);
    });
  });
});
