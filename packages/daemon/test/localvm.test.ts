import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPlacement } from "@boto/protocol";
import { openDatabase } from "../src/db";
import { VmCredentials } from "../src/remote/credentials";
import { HostStore, remoteLaunch } from "../src/remote/hosts";
import { recipeFor } from "../src/remote/localvm";
import { Vault } from "../src/vault";
import { tmp } from "./helpers";

const placement: AgentPlacement = {
  agentId: "a1",
  hostId: "h-local",
  isolation: "none",
  vcpus: 2,
  memMib: 2048,
};

describe("recipeFor", () => {
  test("macOS keeps the embedded vz recipe verbatim", () => {
    const y = recipeFor({ platform: "darwin" });
    expect(y).toContain("vmType: vz");
    expect(y).toContain("mountType: virtiofs");
    expect(y).toContain('location: "~/Boto/computer/workspace"');
  });

  test("linux swaps vz for qemu and picks the mount type", () => {
    const y = recipeFor({ platform: "linux", linuxMountType: "virtiofs" });
    expect(y).toContain("vmType: qemu");
    expect(y).toContain("mountType: virtiofs");
    expect(recipeFor({ platform: "linux" })).toContain("mountType: reverse-sshfs");
    // mounts keep ~ expansion — limactl resolves it against the same home
    expect(y).toContain('location: "~/Boto/computer/workspace"');
    expect(y).toContain("debian-12-genericcloud-amd64.qcow2");
  });

  test("win32 becomes a wsl2 distro with Windows mount paths and a local rootfs", () => {
    const y = recipeFor({
      platform: "win32",
      windowsDirs: {
        workspace: "C:\\Users\\a b\\Boto\\computer\\workspace",
        shared: "C:\\Users\\a b\\Boto\\computer\\shared",
      },
      image: {
        location: "C:\\botod\\vm\\debian-wsl-amd64.tar.gz",
        arch: "x86_64",
        digest: "abc123",
      },
    });
    expect(y).toContain("vmType: wsl2");
    expect(y).toContain("mountType: wsl2");
    expect(y).toContain('location: "C:/Users/a b/Boto/computer/workspace"');
    expect(y).toContain('location: "C:/Users/a b/Boto/computer/shared"');
    expect(y).toContain('location: "C:/botod/vm/debian-wsl-amd64.tar.gz"');
    expect(y).toContain('digest: "sha256:abc123"');
    expect(y).not.toContain("qcow2");
    // Port forwards tunnel via the guest agent's in-distro dial — loopback stays
    expect(y).toContain("--remote-debugging-address=127.0.0.1");
    expect(y).toContain("guestIP: 127.0.0.1");
    expect(y).not.toContain('location: "~');
  });
});

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
