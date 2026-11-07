import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { Vault } from "../src/vault";
import { DaemonClient, startDaemon, tmp, waitForExit } from "./helpers";

// windows-latest sometimes spends the whole 5s default inside startDaemon
// (run 41275008619). Other daemon e2e files use 30s. The process is published
// before READY so a startup that is still abandoned can be reaped; otherwise
// bun reports "daemon stdout closed before READY" between tests.
setDefaultTimeout(30_000);

test.each([
  ["invalid JSON", "CorruptSecretSentinelJson"],
  [
    "invalid kind",
    JSON.stringify({
      kind: "CorruptSecretSentinelKind",
      value: "CorruptSecretSentinelValue",
    }),
  ],
])("credential RPC safely omits %s without logging secrets", async (_label, corrupt) => {
  const dataDir = tmp("vmcred-e2e-");
  const key = "ab".repeat(32);
  writeFileSync(join(dataDir, "vault.key"), key);
  const db = openDatabase(dataDir);
  try {
    new Vault(db, dataDir).set("vmcred.codex", corrupt, []);
  } finally {
    db.close();
  }

  const token = crypto.randomUUID();
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const pending = startDaemon(
    dataDir,
    tmp("vmcred-agents-"),
    token,
    { BOTO_VAULT_KEY: key },
    false,
    (child) => {
      proc = child;
    },
  );
  let client: DaemonClient | undefined;
  try {
    const daemon = await pending;
    const stderr = new Response(daemon.proc.stderr as ReadableStream<Uint8Array>).text();
    client = await DaemonClient.connect(daemon.port, token);
    expect(await client.request("vmCredentials.list")).toEqual([]);
    expect(await client.request("vault.list")).toEqual([]);
    const saved = await client.request("vmCredentials.set", {
      provider: "claude",
      kind: "api_key",
      value: "CorruptSecretSentinelValidKey",
    });
    expect(await client.request("vmCredentials.list")).toEqual([saved]);
    expect(saved).toMatchObject({ provider: "claude", kind: "api_key" });
    expect(JSON.stringify(saved)).not.toContain("CorruptSecretSentinel");
    for (const provider of ["devin", "grok"] as const) {
      const result = await client.request("vmCredentials.set", {
        provider,
        kind: "api_key",
        value: "CorruptSecretSentinelProviderKey",
      });
      expect(result).toMatchObject({ provider, kind: "api_key" });
      expect(JSON.stringify(await client.request("vmCredentials.list"))).not.toContain(
        "CorruptSecretSentinel",
      );
      await client.request("vmCredentials.delete", { provider });
    }
    await client.request("vmCredentials.delete", { provider: "codex" });
    expect(await client.request("vmCredentials.list")).toEqual([saved]);
    client.close();
    client = undefined;
    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);
    const logs = await stderr;
    expect(logs).not.toContain("CorruptSecretSentinel");
    expect(logs).toContain("Boto could not read");
  } finally {
    client?.close();
    const settled = pending.catch(() => {});
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      await proc.exited;
    }
    await settled;
  }
});
