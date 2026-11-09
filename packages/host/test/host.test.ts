import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  appendProxyLog,
  blockedHost,
  buildGuestProviderEnv,
  DESKTOP_MAX_EVENTS,
  DesktopControllerState,
  DesktopDecoder,
  encodeDesktopMessage,
  isFirecrackerReady,
  matchesGuestHelperStamp,
  proxyServer,
  proxyTarget,
  type RunSpec,
  readFirstLine,
  relayErrorReporter,
  validateDesktopEvents,
  vmConfig,
} from "../src/main";

const MAIN = join(import.meta.dir, "../src/main.ts");

describe("boto-host", () => {
  test("readFirstLine keeps the bytes after the spec", async () => {
    const s = new PassThrough();
    const p = readFirstLine(s);
    s.write('{"a":1}\nrest');
    const { line, rest } = await p;
    expect(line).toBe('{"a":1}');
    expect(rest.toString()).toBe("rest");
  });

  test("proxy blocks private, loopback, metadata and IPv6 destinations", () => {
    for (const h of [
      "localhost",
      "x.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.254",
      "192.0.0.1",
      "198.18.0.1",
      "198.19.255.254",
      "224.0.0.1",
      "::1",
      "[fd00::1]",
      "metadata.google.internal",
    ])
      expect(blockedHost(h)).toBe(true);
    for (const h of ["api.anthropic.com", "8.8.8.8", "172.32.0.1"])
      expect(blockedHost(h)).toBe(false);
  });

  test("proxyTarget rejects hostnames resolving to blocked addresses", async () => {
    expect(await proxyTarget("2130706433")).toBeNull();
    expect(await proxyTarget("localhost")).toBeNull();
    expect(await proxyTarget("8.8.8.8")).toBe("8.8.8.8");
  });

  test("guest provider env strips inherited internal Boto values", () => {
    const env = buildGuestProviderEnv(
      {
        BOTO_GUEST_PROXY: "http://127.0.0.1:3128",
        BOTO_GUEST_BRIDGE_SOCKET: "/run/boto/bridge.sock",
        BOTO_SENTINEL_TEST: "leak",
        UPBOT_SENTINEL_TEST: "legacy-leak",
        HOME: "/root",
        PATH: "/usr/bin",
      },
      { BOTO_BRIDGE_TOKEN: "mcp-token", CUSTOM_VALUE: "kept" },
      "http://127.0.0.1:3128",
    );
    expect(env.BOTO_GUEST_PROXY).toBeUndefined();
    expect(env.UPBOT_SENTINEL_TEST).toBeUndefined();
    expect(env.BOTO_GUEST_BRIDGE_SOCKET).toBeUndefined();
    expect(env.BOTO_SENTINEL_TEST).toBeUndefined();
    expect(env.BOTO_BRIDGE_TOKEN).toBe("mcp-token");
    expect(env.CUSTOM_VALUE).toBe("kept");
    expect(env.HOME).toBe("/root");
    expect(env.NO_COLOR).toBe("1");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  test("proxy audit log rotates above one MiB before appending", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-log-test-"));
    const path = join(dir, "proxy.log");
    const large = Buffer.alloc(1024 * 1024 + 1, 0x61);
    writeFileSync(path, large);
    try {
      appendProxyLog(path, "api.example.com:443", "allowed 203.0.113.1");
      expect(readFileSync(`${path}.1`)).toEqual(large);
      const line = readFileSync(path, "utf8").trim();
      expect(line).toMatch(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z api\.example\.com:443 allowed 203\.0\.113\.1$/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("proxy rejects a numeric hostname resolving to loopback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-test-"));
    const socketPath = join(dir, "proxy.sock");
    const logPath = join(dir, "proxy.log");
    const target = createServer((conn) => conn.destroy());
    const proxy = proxyServer(logPath);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(socketPath, resolve));
    try {
      const port = (target.address() as { port: number }).port;
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ path: socketPath });
        let text = "";
        let settled = false;
        const finish = (value: string | Error) => {
          if (settled) return;
          settled = true;
          client.destroy();
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        // Windows AF_UNIX often keeps the peer half-open after `end()`, so wait for
        // the response headers instead of the socket close (same pattern as below).
        client.setTimeout(3000, () => finish(new Error("proxy response timeout")));
        client.on("data", (data) => {
          text += data.toString();
          if (text.includes("\r\n\r\n")) finish(text);
        });
        client.on("end", () => finish(text));
        client.on("error", (error) => finish(error));
        client.on("connect", () =>
          client.write(`CONNECT 2130706433:${port} HTTP/1.1\r\nHost: proxy\r\n\r\n`),
        );
      });
      expect(response).toStartWith("HTTP/1.1 403 Forbidden");
      expect(readFileSync(logPath, "utf8")).toContain(
        `2130706433:${port} denied blocked or unresolved destination`,
      );
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("proxy logs upstream connection failures and successes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-test-"));
    const socketPath = join(dir, "proxy.sock");
    const logPath = join(dir, "proxy.log");
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as { port: number }).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const alive = createServer((conn) => conn.resume());
    await new Promise<void>((resolve) => alive.listen(0, "127.0.0.1", resolve));
    const alivePort = (alive.address() as { port: number }).port;
    const proxy = proxyServer(logPath, async () => "127.0.0.1");
    await new Promise<void>((resolve) => proxy.listen(socketPath, resolve));
    const connect = (port: number) =>
      new Promise<string>((resolve, reject) => {
        const client = createConnection({ path: socketPath });
        let text = "";
        client.setTimeout(3000, () => client.destroy(new Error("proxy response timeout")));
        client.on("data", (data) => {
          text += data.toString();
          if (text.includes("\r\n\r\n")) {
            client.destroy();
            resolve(text);
          }
        });
        client.on("end", () => resolve(text));
        client.on("error", reject);
        client.on("connect", () =>
          client.write(`CONNECT example.com:${port} HTTP/1.1\r\nHost: proxy\r\n\r\n`),
        );
      });
    try {
      const failed = await connect(deadPort);
      expect(failed).toStartWith("HTTP/1.1 502 Bad Gateway");
      const ok = await connect(alivePort);
      expect(ok).toStartWith("HTTP/1.1 200 Connection Established");
      const text = readFileSync(logPath, "utf8");
      expect(text).toContain(`example.com:${deadPort} upstream error ECONNREFUSED`);
      expect(text).toContain(`example.com:${alivePort} connected 127.0.0.1`);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => alive.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("relay error reporter flushes suppressed failures", async () => {
    const lines: string[] = [];
    const report = relayErrorReporter("/bridge.sock", (line) => lines.push(line), 100);
    const error = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    report(error);
    report(error);
    report(error);
    await Bun.sleep(250);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/bridge.sock: ECONNREFUSED");
    expect(lines[1]).toContain("2");
  });

  test("bridge reports daemon failures on stderr without the token", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
    const secretName = "sk-live-SENTINEL";
    try {
      const r = spawnSync("bun", [MAIN, "bridge"], {
        input: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: secretName, arguments: {} },
        })}\n`,
        env: {
          ...process.env,
          BOTO_BRIDGE_SOCKET: join(dir, "missing.sock"),
          BOTO_BRIDGE_TOKEN: "sentinel-token",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      expect(r.stdout).toContain('"isError":true');
      expect(r.stderr).toContain("boto-host bridge: method=tools/call tool=unlisted");
      expect(r.stderr).not.toContain("sentinel-token");
      expect(r.stderr).not.toContain(secretName);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("bridge diagnostics omit untrusted daemon response and tool values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
    const socket = join(dir, "bridge.sock");
    const token = "bridge-token-SENTINEL";
    const server = Bun.serve({
      unix: socket,
      async fetch(req) {
        const body = (await req.json()) as { method: string };
        if (body.method === "tools/list")
          return Response.json({ tools: [{ name: "list_agents" }] });
        return new Response('no agent named "SECRET-VALUE-123"', { status: 400 });
      },
    });
    const child = spawn("bun", [MAIN, "bridge"], {
      env: {
        ...process.env,
        BOTO_BRIDGE_SOCKET: socket,
        BOTO_BRIDGE_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const pendingLines: ((line: string) => void)[] = [];
    const lines: string[] = [];
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const resolve = pendingLines.shift();
        if (resolve) resolve(line);
        else lines.push(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const nextLine = () => {
      const line = lines.shift();
      return line === undefined
        ? new Promise<string>((resolve) => pendingLines.push(resolve))
        : Promise.resolve(line);
    };
    const request = async (message: unknown) => {
      const response = nextLine();
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const line = await response;
      return JSON.parse(line) as {
        result?: { content?: { text?: string }[]; isError?: boolean; tools?: unknown[] };
      };
    };
    const exited = new Promise<void>((resolve, reject) => {
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    try {
      const listed = await request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(listed.result?.tools).toEqual([{ name: "list_agents" }]);
      const listedCall = await request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_agents", arguments: {} },
      });
      const secretCall = await request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sk-live-SENTINEL", arguments: {} },
      });
      expect(listedCall.result?.content?.[0]?.text).toContain('no agent named "SECRET-VALUE-123"');
      expect(secretCall.result?.content?.[0]?.text).toContain('no agent named "SECRET-VALUE-123"');
      child.stdin.end();
      await exited;
      expect(stdout).toContain("SECRET-VALUE-123");
      expect(stderr).toContain("method=tools/call tool=list_agents status=400");
      expect(stderr).toContain("method=tools/call tool=unlisted status=400");
      expect(stderr).not.toContain("SECRET-VALUE-123");
      expect(stderr).not.toContain("sk-live-SENTINEL");
      expect(stderr).not.toContain(token);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await server.stop(true);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("vm config clamps resources and wires vsock", () => {
    const spec: RunSpec = {
      agentId: "a",
      isolation: "firecracker",
      cmd: ["x"],
      vcpus: 999,
      memMib: 1,
    };
    const cfg = vmConfig(spec, "/root.ext4", "/v.sock", "/workspace.ext4");
    expect(cfg["machine-config"]).toEqual({ vcpu_count: 32, mem_size_mib: 256 });
    expect(cfg.vsock).toEqual({ guest_cid: 3, uds_path: "/v.sock" });
    expect(cfg.drives).toEqual([
      {
        drive_id: "rootfs",
        path_on_host: "/root.ext4",
        is_root_device: true,
        is_read_only: false,
      },
      {
        drive_id: "workspace",
        path_on_host: "/workspace.ext4",
        is_root_device: false,
        is_read_only: false,
      },
    ]);
  });

  test("preflight reports readiness without pretending", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "preflight"], {
      env: { ...process.env, BOTO_HOST_ROOT: root, BOTO_FIRECRACKER_BIN: "/nonexistent" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const pre = JSON.parse(r.stdout.trim());
    expect(pre.root).toBe(root);
    expect(pre.kernelImage).toBeNull();
    expect(pre.rootfs).toBeNull();
    expect(pre.guestHelperCurrent).toBeNull();
    expect(pre.firecrackerReady).toBe(false);
  });

  test("a stale guest helper stamp blocks Firecracker readiness", () => {
    const guestHelperCurrent = matchesGuestHelperStamp("stale", Buffer.from("current helper"));
    expect(guestHelperCurrent).toBe(false);
    expect(
      isFirecrackerReady({
        os: "linux",
        kvm: true,
        firecrackerVersion: "Firecracker v1.12.1",
        kernelImage: "/root/firecracker/vmlinux",
        rootfs: "/root/firecracker/rootfs.ext4",
        mkfsExt4: "/usr/sbin/mkfs.ext4",
        guestHelperCurrent,
      }),
    ).toBe(false);
    expect(
      isFirecrackerReady({
        os: "linux",
        kvm: true,
        firecrackerVersion: "Firecracker v1.12.1",
        kernelImage: "/root/firecracker/vmlinux",
        rootfs: "/root/firecracker/rootfs.ext4",
        mkfsExt4: "/usr/sbin/mkfs.ext4",
        guestHelperCurrent: null,
      }),
    ).toBe(true);
  });

  test("firecracker run fails clearly when prerequisites are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({ agentId: "a", isolation: "firecracker", cmd: ["true"] })}\n`,
      env: { ...process.env, BOTO_HOST_ROOT: root, BOTO_FIRECRACKER_BIN: "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/firecracker|missing/);
  });

  test("firecracker run rejects a non-positive or malformed boot timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    try {
      for (const value of ["0", "-1", "abc", "Infinity"]) {
        const r = spawnSync("bun", [MAIN, "run"], {
          input: `${JSON.stringify({ agentId: "a", isolation: "firecracker", cmd: ["true"] })}\n`,
          env: {
            ...process.env,
            BOTO_HOST_ROOT: root,
            BOTO_FIRECRACKER_BIN: "",
            BOTO_VM_BOOT_TIMEOUT_MS: value,
          },
          encoding: "utf8",
        });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("BOTO_VM_BOOT_TIMEOUT_MS must be a positive number");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("local run executes the command in the agent workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({
        agentId: "ag1",
        isolation: "none",
        cmd: [
          process.execPath,
          "-e",
          "console.log(process.cwd()); process.stdin.pipe(process.stdout)",
        ],
      })}\nhello`,
      env: { ...process.env, BOTO_HOST_ROOT: root },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const actual = r.stdout.split(/\r?\n/, 1)[0]!;
    expect(realpathSync(actual)).toBe(realpathSync(join(root, "agents", "ag1")));
    expect(r.stdout).toContain("hello");
  });
});

describe("boto-host desktop", () => {
  test("encodes one JSON message per line and decodes split or batched chunks", () => {
    const a = encodeDesktopMessage({ type: "frame", seq: 1, data: "AAAA" });
    const b = encodeDesktopMessage({ type: "cursor", x: 1, y: 2, kind: "move" });
    expect(a.endsWith("\n")).toBe(true);
    expect(a.slice(0, -1).includes("\n")).toBe(false);
    const decoder = new DesktopDecoder();
    const got: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const bytes = Buffer.from(a + b);
    decoder.push(
      bytes.subarray(0, 7),
      (m) => got.push(m),
      (c) => errors.push(c),
    );
    expect(got).toHaveLength(0);
    decoder.push(
      bytes.subarray(7),
      (m) => got.push(m),
      (c) => errors.push(c),
    );
    expect(got).toEqual([
      { type: "frame", seq: 1, data: "AAAA" },
      { type: "cursor", x: 1, y: 2, kind: "move" },
    ]);
    expect(errors).toEqual([]);
  });

  test("reports malformed, non-object and oversized lines without throwing", () => {
    const decoder = new DesktopDecoder(32);
    const got: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const onMessage = (m: Record<string, unknown>) => got.push(m);
    const onError = (c: string) => errors.push(c);
    decoder.push(Buffer.from("not json\n[1,2]\n\n"), onMessage, onError);
    decoder.push(Buffer.from(`${"x".repeat(40)}\n{"type":"ok"}\n`), onMessage, onError);
    decoder.push(Buffer.from("y".repeat(40)), onMessage, onError);
    expect(errors).toEqual(["bad_json", "bad_message", "line_too_long", "line_too_long"]);
    expect(got).toEqual([{ type: "ok" }]);
  });

  test("validates user input strictly and keeps composite actions for the agent", () => {
    const user = validateDesktopEvents(
      [
        { type: "mouse_move", x: 10, y: 20 },
        { type: "mouse_down", button: 1 },
        { type: "mouse_up", button: 1 },
        { type: "wheel", deltaY: -3 },
        { type: "key_down", keysym: "Return" },
        { type: "key_up", keysym: "Return" },
      ],
      "user",
    );
    expect(user).toHaveLength(6);
    for (const bad of [
      [],
      "nope",
      [{ type: "mouse_move", x: -1, y: 0 }],
      [{ type: "mouse_move", x: 1.5, y: 0 }],
      [{ type: "mouse_move", x: 9000, y: 0 }],
      [{ type: "mouse_move", x: 1, y: 1, extra: true }],
      [{ type: "mouse_down", button: 9 }],
      [{ type: "wheel", deltaY: 1000 }],
      [{ type: "key_down", keysym: "ctrl+c" }],
      [{ type: "key_down", keysym: "" }],
      [{ type: "click", x: 1, y: 1 }],
      [{ type: "type", text: "hi" }],
      [{ type: "key", keysym: "ctrl+c" }],
      [{ type: "teleport" }],
      Array.from({ length: DESKTOP_MAX_EVENTS + 1 }, () => ({ type: "mouse_down", button: 1 })),
    ])
      expect(validateDesktopEvents(bad, "user")).toBeNull();
    expect(
      validateDesktopEvents(
        [
          { type: "click", x: 5, y: 6 },
          { type: "click", x: 5, y: 6, button: 3, double: true },
          { type: "type", text: "olá" },
          { type: "key", keysym: "ctrl+shift+t" },
        ],
        "agent",
      ),
    ).toEqual([
      { type: "click", x: 5, y: 6, button: 1, double: false },
      { type: "click", x: 5, y: 6, button: 3, double: true },
      { type: "type", text: "olá" },
      { type: "key", keysym: "ctrl+shift+t" },
    ]);
    expect(validateDesktopEvents([{ type: "type", text: "x".repeat(4001) }], "agent")).toBeNull();
    expect(validateDesktopEvents([{ type: "key", keysym: "ctrl+c; rm" }], "agent")).toBeNull();
  });

  test("refuses input from whoever is not the controller", () => {
    const state = new DesktopControllerState();
    expect(state.accepts("agent")).toBe(true);
    expect(state.accepts("user")).toBe(false);
    expect(state.set("user")).toBe(true);
    expect(state.accepts("user")).toBe(true);
    expect(state.accepts("agent")).toBe(false);
    expect(state.set("root")).toBe(false);
    expect(state.controller).toBe("user");
  });

  test("passes the machine name to the guest only when it is a safe slug", () => {
    const base: RunSpec = { agentId: "a", isolation: "firecracker", cmd: ["true"] };
    const args = (spec: RunSpec) =>
      vmConfig(spec, "/r.ext4", "/v.sock", "/w.ext4")["boot-source"].boot_args;
    expect(args(base)).not.toContain("boto.name=");
    expect(args({ ...base, machineName: "codigo-01" })).toContain(" boto.name=codigo-01");
    expect(args({ ...base, machineName: "Código 01" })).not.toContain("boto.name=");
    expect(args({ ...base, machineName: "x init=/bin/sh" })).not.toContain("boto.name=");
  });
});
