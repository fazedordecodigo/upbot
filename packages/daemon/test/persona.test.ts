import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { DEFAULT_BOT_INSTRUCTIONS, DEFAULT_BOT_NAME, seedDefaultBot } from "../src/persona";
import { removeDir } from "./helpers";

// A fresh database applies every migration. On windows-latest run 41279161718
// the first case took 5123ms and bun's 5s default failed it; the same case was
// 195ms on the next green run. Other daemon e2e files use 30s. The handle is
// closed and the temp dirs removed so Windows can drop the lock.
setDefaultTimeout(30_000);

const saved = process.env.BOTO_DEFAULT_BOT;
afterEach(() => {
  if (saved === undefined) delete process.env.BOTO_DEFAULT_BOT;
  else process.env.BOTO_DEFAULT_BOT = saved;
});

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

describe("default Boto bot", () => {
  for (const deletedOldest of [false, true]) {
    test(`backfills the oldest historical legacy bot once (oldest deleted: ${deletedOldest})`, async () => {
      await withStore((db, store) => {
        const oldest = store.create({
          name: "Edited assistant",
          provider: "claude",
          instructions: "Edited",
        });
        const next = store.create({ name: "Another assistant", provider: "codex" });
        const namesake = store.create({
          name: DEFAULT_BOT_NAME,
          provider: "claude",
          instructions: DEFAULT_BOT_INSTRUCTIONS,
        });
        for (const [index, bot] of [oldest, next, namesake].entries()) {
          db.query("UPDATE agents SET created_at = ? WHERE id = ?").run(index + 1, bot.id);
        }
        if (deletedOldest) store.softDelete(oldest.id);
        db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
        seedDefaultBot(db, store);
        const adopted = oldest;
        expect(
          store
            .list()
            .filter((bot) => bot.isDefault)
            .map((bot) => bot.id),
        ).toEqual(deletedOldest ? [] : [adopted.id]);
        expect(db.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get()).toEqual({
          value: JSON.stringify(adopted.id),
        });
        expect(db.query("SELECT instructions FROM agents WHERE id = ?").get(oldest.id)).toEqual({
          instructions: "Edited",
        });
        db.query("UPDATE agents SET created_at = 0 WHERE id = ?").run(namesake.id);
        seedDefaultBot(db, store);
        expect(store.get(adopted.id)?.isDefault ?? false).toBe(!deletedOldest);
        store.softDelete(adopted.id);
        seedDefaultBot(db, store);
        expect(store.list().some((bot) => bot.isDefault)).toBe(false);
        expect(store.list()).toHaveLength(2);
      });
    });
  }

  for (const deletedHistory of [false, true]) {
    test(`preserves the historical identity when no active bots exist (deleted history: ${deletedHistory})`, async () => {
      await withStore((db, store) => {
        const deleted = deletedHistory
          ? store.create({ name: "Deleted assistant", provider: "claude" })
          : null;
        if (deleted) store.softDelete(deleted.id);
        db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
        seedDefaultBot(db, store);
        expect(store.list()).toEqual([]);
        expect(db.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get()).toEqual({
          value: JSON.stringify(deleted?.id ?? null),
        });
        store.create({
          name: DEFAULT_BOT_NAME,
          provider: "claude",
          instructions: DEFAULT_BOT_INSTRUCTIONS,
        });
        seedDefaultBot(db, store);
        expect(store.list().some((bot) => bot.isDefault)).toBe(false);
        expect(store.list()).toHaveLength(1);
      });
    });
  }

  test("identifies the seeded bot after rename and restart without choosing older custom bots", async () => {
    delete process.env.BOTO_DEFAULT_BOT;
    await withStore((db, store) => {
      seedDefaultBot(db, store);
      const seeded = store.list()[0]!;
      store.update({ id: seeded.id, name: "My assistant" });
      const custom = store.create({ name: "Boto", provider: "codex" });
      db.query("UPDATE agents SET created_at = 0 WHERE id = ?").run(custom.id);
      seedDefaultBot(db, store);
      expect(
        store
          .list()
          .filter((agent) => agent.isDefault)
          .map((agent) => agent.id),
      ).toEqual([seeded.id]);
      expect(store.get(seeded.id)?.isDefault).toBe(true);
      store.softDelete(seeded.id);
      seedDefaultBot(db, store);
      expect(store.list().some((agent) => agent.isDefault)).toBe(false);
    });
  });

  test("updates an unchanged seeded UpBot without modifying custom bots", async () => {
    await withStore((db, store) => {
      const legacy = store.create({
        name: "UpBot",
        provider: "claude",
        instructions: DEFAULT_BOT_INSTRUCTIONS.replace("You are Boto", "You are UpBot"),
      });
      const custom = store.create({
        name: "UpBot",
        provider: "claude",
        instructions: "My customized assistant",
      });
      db.query("UPDATE agents SET created_at = 0 WHERE id = ?").run(legacy.id);
      db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
      seedDefaultBot(db, store);
      seedDefaultBot(db, store);
      expect(store.get(legacy.id)?.name).toBe("Boto");
      expect(store.get(legacy.id)?.instructions).toBe(DEFAULT_BOT_INSTRUCTIONS);
      expect(store.get(legacy.id)?.isDefault).toBe(true);
      expect(store.get(custom.id)?.isDefault).toBe(false);
      expect(store.get(custom.id)?.name).toBe("UpBot");
      expect(store.get(custom.id)?.instructions).toBe("My customized assistant");
    });
  });
  test("is created once on a fresh install", async () => {
    delete process.env.BOTO_DEFAULT_BOT;
    await withStore((db, store) => {
      seedDefaultBot(db, store);
      expect(store.list().map((a) => a.name)).toEqual([DEFAULT_BOT_NAME]);
      store.softDelete(store.list()[0]!.id);
      seedDefaultBot(db, store);
      expect(store.list()).toEqual([]);
    });
  });

  test("is not added to an install that already has bots", async () => {
    delete process.env.BOTO_DEFAULT_BOT;
    await withStore((db, store) => {
      store.create({ name: "Mine", provider: "codex", instructions: "" });
      seedDefaultBot(db, store);
      expect(store.list().map((a) => a.name)).toEqual(["Mine"]);
      expect(store.list().some((agent) => agent.isDefault)).toBe(false);
    });
  });
});
