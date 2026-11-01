import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { DaemonEventMap } from "@boto/protocol";
import { DaemonClient, killProcessTree, removeDir, tmp } from "./helpers";

function wsServer() {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message() {},
    },
  });
}

function boundPort(server: { port: number | undefined }): number {
  if (server.port === undefined) throw new Error("server did not bind");
  return server.port;
}

test("close settles an event wait instead of rejecting after the caller is gone", async () => {
  const server = wsServer();
  const client = await DaemonClient.connect(boundPort(server), "teardown");
  const pending = client.waitForEvent("agent.created", 40);
  const result = pending.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  client.close();
  try {
    expect(await result).toBe("client closed");
    await Bun.sleep(80);
    expect(await result).toBe("client closed");
  } finally {
    server.stop(true);
  }
});

test("an event that arrives is still delivered", async () => {
  let socket: { send: (data: string) => void } | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message() {},
    },
  });
  const client = await DaemonClient.connect(boundPort(server), "teardown");
  const pending = client.waitForEvent("agent.created", 1000);
  const agent = { id: "a", name: "Boto" } as DaemonEventMap["agent.created"];
  socket?.send(JSON.stringify({ event: "agent.created", data: agent }));
  try {
    expect(await pending).toEqual(agent);
  } finally {
    client.close();
    server.stop(true);
  }
});

test("removeDir retries Windows lock errors and then removes the directory", async () => {
  const dir = tmp("remove-dir-retry-");
  const codes = ["EBUSY", "EPERM", "ENOTEMPTY"];
  let calls = 0;
  try {
    await removeDir(dir, () => {
      calls += 1;
      if (calls <= codes.length)
        throw Object.assign(new Error("locked"), { code: codes[calls - 1] });
      rmSync(dir, { recursive: true, force: true });
    });
    expect(calls).toBe(codes.length + 1);
    expect(existsSync(dir)).toBe(false);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test("removeDir does not retry unrelated errors", async () => {
  const dir = tmp("remove-dir-once-");
  let calls = 0;
  try {
    await expect(
      removeDir(dir, () => {
        calls += 1;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).rejects.toThrow("denied");
    expect(calls).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killProcessTree stops a live process", async () => {
  const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  await Bun.sleep(20);
  killProcessTree(proc.pid);
  expect(typeof (await proc.exited)).toBe("number");
});
