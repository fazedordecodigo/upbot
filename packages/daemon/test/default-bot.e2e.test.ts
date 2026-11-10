import { expect, test } from "bun:test";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

for (const history of ["active", "deleted", "empty"] as const) {
  test(`legacy ${history} identity survives boot and agents.list without reassignment`, async () => {
    const root = tmp("legacy-default-rpc-");
    const agentsRoot = join(root, "agents");
    const db = openDatabase(root);
    const store = new AgentStore(db, agentsRoot);
    const oldest =
      history === "empty"
        ? null
        : store.create({ name: "Edited default", provider: "claude", instructions: "Edited" });
    if (oldest) {
      db.query("UPDATE agents SET created_at = 1 WHERE id = ?").run(oldest.id);
      store.create({ name: "Surviving custom", provider: "claude" });
      if (history === "deleted") store.softDelete(oldest.id);
    }
    db.query("INSERT INTO settings (key,value) VALUES ('default_bot_seeded','1')").run();
    db.close();
    const token = crypto.randomUUID();
    const daemon = await startDaemon(root, agentsRoot, token, { BOTO_DEFAULT_BOT: "on" });
    const client = await DaemonClient.connect(daemon.port, token);
    try {
      const bots = await client.request("agents.list", {});
      expect(bots.filter((bot) => bot.isDefault).map((bot) => bot.id)).toEqual(
        history === "active" ? [oldest!.id] : [],
      );
      expect(bots).toHaveLength(history === "active" ? 2 : history === "deleted" ? 1 : 0);
    } finally {
      await stopDaemon(daemon, client);
      const persisted = openDatabase(root);
      try {
        expect(
          persisted.query("SELECT value FROM settings WHERE key = 'default_bot_id'").get(),
        ).toEqual({
          value: JSON.stringify(oldest?.id ?? null),
        });
      } finally {
        persisted.close();
        await removeDir(root);
      }
    }
  }, 30_000);
}

test("default identity survives RPC rename, instructions, restart and deletion without selecting a namesake", async () => {
  const root = tmp("default-bot-rpc-");
  const token = crypto.randomUUID();
  const env = { BOTO_DEFAULT_BOT: "on" };
  let daemon = await startDaemon(root, join(root, "agents"), token, env);
  let client = await DaemonClient.connect(daemon.port, token);
  try {
    const seeded = (await client.request("agents.list", {})).find((agent) => agent.isDefault)!;
    expect(seeded.name).toBe("Boto");
    expect(
      await client.request("agents.update", {
        id: seeded.id,
        name: "My assistant",
        instructions: "Customized instructions",
      }),
    ).toMatchObject({ isDefault: true });
    const custom = await client.request("agents.create", { name: "Boto", provider: "devin" });
    expect(custom.isDefault).toBe(false);
    await stopDaemon(daemon, client);
    daemon = await startDaemon(root, join(root, "agents"), token, env);
    client = await DaemonClient.connect(daemon.port, token);
    expect(
      (await client.request("agents.list", {}))
        .filter((agent) => agent.isDefault)
        .map((agent) => agent.id),
    ).toEqual([seeded.id]);
    expect(
      (await client.request("agents.list", {})).find((agent) => agent.id === seeded.id),
    ).toMatchObject({
      name: "My assistant",
      instructions: "Customized instructions",
      isDefault: true,
    });
    await client.request("agents.delete", { id: seeded.id });
    await stopDaemon(daemon, client);
    daemon = await startDaemon(root, join(root, "agents"), token, env);
    client = await DaemonClient.connect(daemon.port, token);
    expect((await client.request("agents.list", {})).some((agent) => agent.isDefault)).toBe(false);
  } finally {
    await stopDaemon(daemon, client);
    await removeDir(root);
  }
}, 30_000);
