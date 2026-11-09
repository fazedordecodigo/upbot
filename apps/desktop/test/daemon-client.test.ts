import { afterAll, expect, test } from "bun:test";

type TauriTestGlobals = typeof globalThis & {
  __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
};

let resolveConnection: () => Promise<unknown>;
let invokeCount = 0;
let socketAttempts = 0;
const tauriGlobals = globalThis as TauriTestGlobals;

tauriGlobals.window = globalThis;
tauriGlobals.__TAURI_INTERNALS__ = {
  invoke: async (command: string) => {
    if (command !== "daemon_connection") throw new Error(`unexpected invoke: ${command}`);
    invokeCount += 1;
    return resolveConnection();
  },
};

const NativeWebSocket = globalThis.WebSocket;
class CountingWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    socketAttempts += 1;
    super(url, protocols);
  }
}
globalThis.WebSocket = CountingWebSocket;

const { DaemonClient } = await import("../src/lib/daemon");

afterAll(() => {
  globalThis.WebSocket = NativeWebSocket;
  delete tauriGlobals.window;
  delete tauriGlobals.__TAURI_INTERNALS__;
});

test("first socket retry re-resolves the connection and notifies refresh subscribers", async () => {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      attempts++;
      if (attempts === 1) return new Response(null, { status: 503 });
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message));
        socket.send(JSON.stringify({ id: request.id, result: [] }));
      },
    },
  });
  invokeCount = 0;
  resolveConnection = async () => ({ port: server.port, token: "t" });
  const client = new DaemonClient();
  let refreshed = false;
  const off = client.onReconnect(() => {
    void client.request("agents.list", {}).then(() => {
      refreshed = true;
    });
  });
  try {
    await expect(client.connect()).rejects.toThrow();
    await waitFor(() => refreshed);
    expect(invokeCount).toBe(2);
    expect(attempts).toBe(2);
  } finally {
    off();
    client.close();
    server.stop(true);
  }
});

function serve() {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/ws") {
        return new Response(null, { status: 404 });
      }
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message));
        socket.send(JSON.stringify({ id: request.id, result: [] }));
      },
    },
  });
}

test("refresh requests recover after an initial RPC failure and socket reconnect", async () => {
  let fail = true;
  let firstSocket: { terminate: () => void } | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        firstSocket = socket;
      },
      message(socket, message) {
        const request = JSON.parse(String(message));
        socket.send(
          JSON.stringify(
            fail
              ? { id: request.id, error: { code: "internal", message: "falha simulada" } }
              : { id: request.id, result: [] },
          ),
        );
      },
    },
  });
  invokeCount = 0;
  resolveConnection = async () => ({ port: server.port, token: "t" });
  const client = new DaemonClient();
  let refreshed = false;
  const off = client.onReconnect(() => {
    void client.request("agents.list", {}).then(() => {
      refreshed = true;
    });
  });
  try {
    await client.connect();
    await expect(client.request("agents.list", {})).rejects.toThrow("falha simulada");
    fail = false;
    firstSocket?.terminate();
    await waitFor(() => refreshed);
    expect(invokeCount).toBe(2);
  } finally {
    off();
    client.close();
    server.stop(true);
  }
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

test("reports daemon termination after re-resolving and stops retrying", async () => {
  const server = serve();
  const exitMessage = "botod exited: TerminatedPayload { code: Some(1), signal: None }";
  invokeCount = 0;
  socketAttempts = 0;
  resolveConnection = async () => {
    if (invokeCount === 1) return { port: server.port, token: "t" };
    throw exitMessage;
  };
  const client = new DaemonClient();
  let failure: Error | undefined;
  let disconnects = 0;
  const offDisconnect = client.onDisconnect(() => disconnects++);
  const off = client.onFailure((error) => {
    failure = error;
  });

  try {
    await client.connect();
    expect(invokeCount).toBe(1);
    expect(socketAttempts).toBe(1);
    server.stop(true);
    await waitFor(() => disconnects > 0);
    expect(invokeCount).toBe(1);
    await waitFor(() => failure !== undefined);
    expect(disconnects).toBe(2);
    expect(failure?.message).toBe(exitMessage);
    expect(invokeCount).toBe(2);
    const callsAfterFailure = invokeCount;
    const socketsAfterFailure = socketAttempts;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(invokeCount).toBe(callsAfterFailure);
    expect(socketAttempts).toBe(socketsAfterFailure);
  } finally {
    offDisconnect();
    off();
    client.close();
    server.stop(true);
  }
});

test("reconnects to the newly resolved daemon connection", async () => {
  const oldServer = serve();
  const newServer = serve();
  invokeCount = 0;
  socketAttempts = 0;
  resolveConnection = async () => ({
    port: invokeCount === 1 ? oldServer.port : newServer.port,
    token: "t",
  });
  const client = new DaemonClient();
  let reconnected = false;
  let disconnects = 0;
  const offDisconnect = client.onDisconnect(() => disconnects++);
  const off = client.onReconnect(() => {
    reconnected = true;
  });

  try {
    await client.connect();
    oldServer.stop(true);
    await waitFor(() => reconnected);
    expect(disconnects).toBe(1);
    expect(invokeCount).toBe(2);
    expect(socketAttempts).toBe(2);
    expect(await client.request("agents.list", {})).toEqual([]);
  } finally {
    offDisconnect();
    off();
    client.close();
    oldServer.stop(true);
    newServer.stop(true);
  }
});
