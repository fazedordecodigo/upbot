import { expect, test } from "bun:test";
import { join } from "node:path";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

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
