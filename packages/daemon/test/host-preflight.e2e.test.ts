import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type Agent, type HostPreflight, RemoteHost } from "@boto/protocol";
import { DaemonClient, type DaemonHandle, removeDirAfterExit, startDaemon, tmp } from "./helpers";

const FAKE_SSH = join(import.meta.dir, "fixtures/fake-preflight-ssh.ts");
const TOKEN = `host-preflight-${crypto.randomUUID()}`;

// `bun build --compile` plus daemon startup exceeds bun's 5s default on a busy
// Windows runner (the same file already spends ~4s without compiling). Other
// daemon e2e files use 30s. The timeout is not a substitute for reaping the
// child: a startup abandoned at the limit still holds the temp directory.
setDefaultTimeout(30_000);

type Spawned = ReturnType<typeof Bun.spawn>;

describe("temp directory cleanup", () => {
  test("removes the directory only after the process has exited", async () => {
    const dir = tmp("host-preflight-cleanup-");
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const order: string[] = [];
    void exited.then(() => order.push("exit"));
    const proc = {
      kill() {
        resolveExit(0);
      },
      exited,
    };
    try {
      await removeDirAfterExit(proc, dir, () => {
        order.push("rm");
      });
      expect(order).toEqual(["exit", "rm"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reaps a live process before deleting its directory", async () => {
    const dir = tmp("host-preflight-cleanup-live-");
    const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: dir });
    await removeDirAfterExit(proc, dir);
    expect(existsSync(dir)).toBe(false);
    expect(proc.killed).toBe(true);
    expect(typeof (await proc.exited)).toBe("number");
  });

  test("startDaemon publishes the process before READY", async () => {
    const data = tmp("host-preflight-spawn-");
    const agents = tmp("host-preflight-spawn-agents-");
    let proc: Spawned | undefined;
    try {
      const pending = startDaemon(
        data,
        agents,
        `spawn-${crypto.randomUUID()}`,
        {},
        false,
        (child) => {
          proc = child;
          try {
            child.kill("SIGKILL");
          } catch {}
        },
      );
      await expect(pending).rejects.toThrow();
      expect(proc?.pid).toBeGreaterThan(0);
      await proc?.exited;
    } finally {
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await proc.exited;
      }
      await removeDirAfterExit(undefined, data);
      await removeDirAfterExit(undefined, agents);
    }
  });
});

describe("host preflight RPC validation", () => {
  let root: string;
  let daemon: DaemonHandle | undefined;
  let spawned: Spawned | undefined;
  let startup: Promise<DaemonHandle> | undefined;
  let c: DaemonClient | undefined;
  let preflight: HostPreflight;

  beforeEach(() => {
    root = tmp("host-preflight-");
    preflight = {
      root: join(root, "remote"),
      os: "linux",
      arch: "x64",
      kernelRelease: "test-kernel",
      bun: "test-bun",
      kvm: false,
      firecracker: null,
      kernelImage: null,
      rootfs: null,
      mkfsExt4: null,
      guestHelperCurrent: null,
      providers: { claude: null },
      firecrackerReady: false,
      futureField: "retained",
    };
    writeFileSync(join(root, "output"), `${JSON.stringify(preflight)}\n`);
  });

  afterEach(async () => {
    c?.close();
    c = undefined;
    const proc = spawned;
    const pending = startup;
    spawned = undefined;
    startup = undefined;
    daemon = undefined;
    // Attach before the kill. A startup still waiting for READY rejects once
    // stdout closes, and that rejection is otherwise unhandled after a timeout.
    const settled = pending?.catch(() => {});
    try {
      await removeDirAfterExit(proc, root);
    } finally {
      await settled;
    }
  });

  async function connect(env: Record<string, string> = {}) {
    const pending = startDaemon(
      join(root, "data"),
      join(root, "agents"),
      TOKEN,
      {
        BOTO_SSH_COMMAND: JSON.stringify([process.execPath, FAKE_SSH]),
        FAKE_PREFLIGHT_OUTPUT: join(root, "output"),
        FAKE_PREFLIGHT_SSH_LOG: join(root, "ssh.jsonl"),
        ...env,
      },
      false,
      (proc) => {
        spawned = proc;
      },
    );
    startup = pending;
    daemon = await pending;
    c = await DaemonClient.connect(daemon.port, TOKEN);
    return c;
  }

  function stored(id: string) {
    const db = new Database(join(root, "data/boto.db"), { readonly: true });
    try {
      return db.query("SELECT root, preflight_json FROM hosts WHERE id = ?").get(id);
    } finally {
      db.close();
    }
  }

  test("rejects invalid SSH preflight output without persisting or broadcasting it", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "invalid", target: "fixture.invalid" }),
    );
    const changes = client.events.filter((e) => e.event === "hosts.changed").length;
    for (const output of [
      JSON.stringify({ root: preflight.root, firecrackerReady: true }),
      JSON.stringify({ ...preflight, root: 42 }),
      JSON.stringify({ ...preflight, firecrackerReady: "true" }),
      JSON.stringify({ ...preflight, providers: { claude: 42 } }),
      "not-json",
      "null",
    ]) {
      writeFileSync(join(root, "output"), `${output}\n`);
      await expect(client.request("hosts.check", { id: host.id })).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("unexpected preflight output"),
      });
      expect(await client.request("hosts.list")).toEqual([host]);
      expect(stored(host.id)).toEqual({ root: null, preflight_json: null });
      expect(client.events.filter((e) => e.event === "hosts.changed")).toHaveLength(changes);
    }
  });

  test("install persists valid preflight and failed rechecks retain the last valid state", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "valid", target: "fixture.invalid" }),
    );
    const installed = RemoteHost.parse(await client.request("hosts.install", { id: host.id }));
    expect(installed).toEqual({ ...host, root: preflight.root, preflight });
    expect(stored(host.id)).toEqual({
      root: preflight.root,
      preflight_json: JSON.stringify(preflight),
    });
    const calls = readFileSync(join(root, "ssh.jsonl"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(JSON.parse(call)).toContain(host.target);
    const changes = client.events.filter((e) => e.event === "hosts.changed").length;
    writeFileSync(
      join(root, "output"),
      JSON.stringify({ root: "untrusted", firecrackerReady: true }),
    );
    await expect(client.request("hosts.check", { id: host.id })).rejects.toThrow(
      /unexpected preflight output/,
    );
    expect(await client.request("hosts.list")).toEqual([installed]);
    expect(stored(host.id)).toEqual({
      root: preflight.root,
      preflight_json: JSON.stringify(preflight),
    });
    expect(client.events.filter((e) => e.event === "hosts.changed")).toHaveLength(changes);
  });

  test("invalid cached preflight is null over RPC and cannot authorize Firecracker placement", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "cached", target: "fixture.invalid" }),
    );
    const agent = (await client.request("agents.create", {
      name: "bot",
      provider: "devin",
    })) as Agent;
    for (const cached of [
      JSON.stringify({ root: preflight.root, firecrackerReady: true }),
      "not-json",
    ]) {
      const db = new Database(join(root, "data/boto.db"));
      try {
        db.query("UPDATE hosts SET root = ?, preflight_json = ? WHERE id = ?").run(
          preflight.root,
          cached,
          host.id,
        );
      } finally {
        db.close();
      }
      expect(await client.request("hosts.list")).toEqual([{ ...host, root: preflight.root }]);
      await expect(
        client.request("placements.set", {
          agentId: agent.id,
          hostId: host.id,
          isolation: "firecracker",
        }),
      ).rejects.toThrow(/not ready for Firecracker/);
    }
  });

  test.each(["not-json", '["ssh",42]', "[]", '{"command":"ssh"}'])(
    "invalid BOTO_SSH_COMMAND %s falls back to ssh on PATH through RPC",
    async (override) => {
      const compiled = Bun.spawnSync([
        process.execPath,
        "build",
        FAKE_SSH,
        "--compile",
        "--outfile",
        join(root, process.platform === "win32" ? "ssh.exe" : "ssh"),
      ]);
      expect(compiled.exitCode).toBe(0);
      const shell = join(root, "login-shell");
      if (process.platform !== "win32") {
        writeFileSync(shell, '#!/bin/sh\nprintf "__OA_PATH__%s__OA_PATH__" "$PATH"\n', {
          mode: 0o700,
        });
      }
      const pathKey =
        Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const client = await connect({
        BOTO_SSH_COMMAND: override,
        [pathKey]: `${root}${delimiter}${process.env[pathKey] ?? ""}`,
        ...(process.platform === "win32" ? {} : { SHELL: shell }),
      });
      const host = RemoteHost.parse(
        await client.request("hosts.create", { name: "fallback", target: "fixture.invalid" }),
      );
      const checked = RemoteHost.parse(await client.request("hosts.check", { id: host.id }));
      expect(checked.preflight).toEqual(preflight);
      expect(stored(host.id)).toEqual({
        root: preflight.root,
        preflight_json: JSON.stringify(preflight),
      });
      const calls = readFileSync(join(root, "ssh.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("-T");
      expect(calls[0].slice(-2, -1)).toEqual([host.target]);
    },
  );
});
