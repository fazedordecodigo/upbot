import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPlacement } from "@boto/protocol";
import { openDatabase } from "../src/db";
import { VmCredentials } from "../src/remote/credentials";
import { HostStore, remoteLaunch } from "../src/remote/hosts";
import { Vault } from "../src/vault";
import { tmp } from "./helpers";

const placement: AgentPlacement = {
  agentId: "a1",
  hostId: "h-local",
  isolation: "none",
  vcpus: 2,
  memMib: 2048,
};

describe("local VM host", () => {
  const prevSsh = process.env.BOTO_SSH_COMMAND;
  const prevKey = process.env.BOTO_VAULT_KEY;
  process.env.BOTO_VAULT_KEY = "cd".repeat(32);
  const dataDir = tmp("localvm-");
  const db = openDatabase(dataDir);
  const hosts = new HostStore(db);
  const vault = new Vault(db, dataDir);
  const creds = new VmCredentials(vault);
  hosts.credentialEnv = (provider) => creds.env(provider);

  afterAll(() => {
    if (prevSsh === undefined) delete process.env.BOTO_SSH_COMMAND;
    else process.env.BOTO_SSH_COMMAND = prevSsh;
    if (prevKey === undefined) delete process.env.BOTO_VAULT_KEY;
    else process.env.BOTO_VAULT_KEY = prevKey;
  });

  test("upsertLocalVm creates then refreshes the single localvm row", () => {
    const h = hosts.upsertLocalVm({
      instance: "boto-computer",
      name: "VM local",
      target: "lima@127.0.0.1",
      port: 60022,
      identityFile: "~/.lima/_config/user",
    });
    expect(h.kind).toBe("localvm");
    expect(hosts.localVmHost()?.id).toBe(h.id);
    const again = hosts.upsertLocalVm({
      instance: "boto-computer",
      name: "VM local",
      target: "lima@127.0.0.1",
      port: 60099,
      identityFile: "~/.lima/_config/user",
    });
    expect(again.id).toBe(h.id);
    expect(again.port).toBe(60099);
    expect(hosts.list().filter((x) => x.kind === "localvm")).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")(
    "stored provider logins merge into the run spec on the local VM",
    async () => {
      const host = hosts.localVmHost()!;
      db.query("UPDATE hosts SET root = ? WHERE id = ?").run("/home/lima/.boto", host.id);
      const installed = hosts.get(host.id)!;
      creds.set("claude", "oauth_token", "sk-ant-oat01-localvm");
      const out = join(tmp("localvm-ssh-"), "spec.json");
      process.env.BOTO_SSH_COMMAND = JSON.stringify(["sh", "-c", `head -n 1 > ${out}`, "fake-ssh"]);
      const launch = remoteLaunch(installed, placement, 0, creds.env("claude"));
      const child = launch.spawn(["claude", "--verbose"], { NO_COLOR: "1" });
      child.stdin?.end();
      await new Promise((r) => child.on("close", r));
      const spec = JSON.parse(readFileSync(out, "utf8")) as { env: Record<string, string> };
      expect(spec.env).toEqual({
        NO_COLOR: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-localvm",
      });
      // The plain ssh host keeps the old boundary: credentials never merge for "none".
      const ssh = remoteLaunch(
        {
          id: "h2",
          name: "vps",
          target: "me@vps",
          port: 22,
          identityFile: null,
          root: "/home/me/.boto",
          preflight: null,
          createdAt: 0,
          kind: "ssh",
        },
        placement,
        0,
        creds.env("claude"),
      );
      const out2 = join(tmp("localvm-ssh-"), "spec.json");
      process.env.BOTO_SSH_COMMAND = JSON.stringify([
        "sh",
        "-c",
        `head -n 1 > ${out2}`,
        "fake-ssh",
      ]);
      const child2 = ssh.spawn(["claude", "--verbose"], { NO_COLOR: "1" });
      child2.stdin?.end();
      await new Promise((r) => child2.on("close", r));
      const spec2 = JSON.parse(readFileSync(out2, "utf8")) as { env: Record<string, string> };
      expect(spec2.env).toEqual({ NO_COLOR: "1" });
    },
  );
});
