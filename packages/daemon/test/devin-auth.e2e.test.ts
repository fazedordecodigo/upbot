import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpDriver } from "../src/providers/acp";
import type { RemoteLaunch } from "../src/providers/types";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  sendAndWait,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

const KEY = "DevinSecretSentinel";
const AUTH_METHODS = JSON.stringify([{ id: "devin-browser" }]);

type Env = Record<string, string | undefined>;

async function withEnv<T>(env: Env, run: () => Promise<T>): Promise<T> {
  const saved: Env = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function remote(
  stateDir: string,
  credentials: Record<string, string>,
  env: Env = {},
): RemoteLaunch {
  return {
    cwd: stateDir,
    describe: "fake VM",
    credentials,
    mcp: (spec) => spec,
    spawn: () =>
      spawn(process.execPath, [FAKE_AGENT], {
        env: {
          ...process.env,
          ...credentials,
          FAKE_ACP_STATE_DIR: stateDir,
          FAKE_ACP_AUTH_METHODS: AUTH_METHODS,
          FAKE_ACP_REQUIRE_AUTH: "1",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }),
  };
}

const hooks = {
  onUpdate: () => {},
  onExit: () => {},
  requestPermission: async () => ({ optionId: null }),
};

function localEnv(stateDir: string, extra: Env = {}): Env {
  return {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: stateDir,
    FAKE_ACP_AUTH_METHODS: AUTH_METHODS,
    FAKE_ACP_REQUIRE_AUTH: "1",
    ...extra,
  };
}

function methods(stateDir: string): string[] {
  return readLog(stateDir).map((entry) => entry.method);
}

function authParams(stateDir: string): unknown[] {
  return readLog(stateDir)
    .filter((entry) => entry.method === "authenticate")
    .map((entry) => entry.params);
}

test("Devin local apiKey authenticates before session/new", async () => {
  const stateDir = tmp("devin-auth-");
  await withEnv(localEnv(stateDir), async () => {
    const session = await new AcpDriver("devin").start({
      cwd: stateDir,
      resumeSessionId: null,
      apiKey: KEY,
      hooks,
    });
    await session.close();
  });
  expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser", _meta: { api_key: KEY } }]);
  const order = methods(stateDir);
  expect(order.indexOf("initialize")).toBeLessThan(order.indexOf("authenticate"));
  expect(order.indexOf("authenticate")).toBeLessThan(order.indexOf("session/new"));
});

test("Devin VM credential authenticates before session/new", async () => {
  const stateDir = tmp("devin-auth-");
  const session = await new AcpDriver("devin").start({
    cwd: stateDir,
    resumeSessionId: null,
    remote: remote(stateDir, { WINDSURF_API_KEY: KEY }),
    hooks,
  });
  await session.close();
  expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser", _meta: { api_key: KEY } }]);
  const order = methods(stateDir);
  expect(order.indexOf("authenticate")).toBeLessThan(order.indexOf("session/new"));
});

test("Devin local without a key retries session/new after browser sign-in", async () => {
  const stateDir = tmp("devin-auth-");
  await withEnv(localEnv(stateDir), async () => {
    const session = await new AcpDriver("devin").start({
      cwd: stateDir,
      resumeSessionId: null,
      hooks,
    });
    await session.close();
  });
  expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser" }]);
  const order = methods(stateDir).filter((m) => m !== "session/cancel");
  expect(order.slice(0, 4)).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
});

test("Devin local without a key retries session/load after browser sign-in", async () => {
  const stateDir = tmp("devin-auth-");
  writeFileSync(
    join(stateDir, "sessions.json"),
    JSON.stringify({ "previous-session": { prompts: [] } }),
  );
  await withEnv(localEnv(stateDir), async () => {
    const session = await new AcpDriver("devin").start({
      cwd: stateDir,
      resumeSessionId: "previous-session",
      hooks,
    });
    await session.close();
  });
  expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser" }]);
  const order = methods(stateDir);
  expect(order.slice(0, 4)).toEqual(["initialize", "session/load", "authenticate", "session/load"]);
});

test("Devin remote without a credential never opens browser auth", async () => {
  const stateDir = tmp("devin-auth-");
  const start = new AcpDriver("devin").start({
    cwd: stateDir,
    resumeSessionId: null,
    remote: remote(stateDir, {}),
    hooks,
  });
  await expect(start).rejects.toThrow("Save a Devin API key");
  expect(authParams(stateDir)).toEqual([]);
});

test("Devin rejected key points at Settings → Providers and stays secret", async () => {
  const stateDir = tmp("devin-auth-");
  let stderr = "";
  const failing = remote(
    stateDir,
    { WINDSURF_API_KEY: KEY },
    {
      FAKE_ACP_AUTH_ERROR: `Authentication failed: invalid api key ${KEY}`,
    },
  );
  const spawn0 = failing.spawn;
  failing.spawn = (cmd, env) => {
    const child = spawn0(cmd, env);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    return child;
  };
  const start = new AcpDriver("devin").start({
    cwd: stateDir,
    resumeSessionId: null,
    remote: failing,
    hooks,
  });
  await expect(start).rejects.toThrow("the saved API key was rejected");
  await start.catch((error) => {
    expect(String(error)).toContain("Settings → Providers");
    expect(String(error)).not.toContain(KEY);
  });
  expect(stderr).not.toContain(KEY);
});

test("Devin daemon session authenticates with the vault API key", async () => {
  const dataDir = tmp("devin-auth-data-");
  const agentsRoot = tmp("devin-auth-agents-");
  const stateDir = tmp("devin-auth-fake-");
  const token = crypto.randomUUID();
  const daemon: DaemonHandle = await startDaemon(dataDir, agentsRoot, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: stateDir,
    FAKE_ACP_AUTH_METHODS: AUTH_METHODS,
    FAKE_ACP_REQUIRE_AUTH: "1",
  });
  const client = await DaemonClient.connect(daemon.port, token);
  try {
    await client.request("providers.setApiKey", { provider: "devin", value: KEY });
    const agent = (await client.request("agents.create", {
      name: "Devin",
      provider: "devin",
      instructions: "",
    })) as { id: string };
    const turn = await sendAndWait(client, agent.id, "echo:hi", 15000);
    expect(turn.status).toBe("completed");
    expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser", _meta: { api_key: KEY } }]);
  } finally {
    await stopDaemon(daemon, client, stateDir);
  }
}, 30_000);

test("Devin daemon session without a key signs in through the browser method", async () => {
  const dataDir = tmp("devin-auth-data-");
  const agentsRoot = tmp("devin-auth-agents-");
  const stateDir = tmp("devin-auth-fake-");
  const token = crypto.randomUUID();
  const daemon: DaemonHandle = await startDaemon(dataDir, agentsRoot, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: stateDir,
    FAKE_ACP_AUTH_METHODS: AUTH_METHODS,
    FAKE_ACP_REQUIRE_AUTH: "1",
  });
  const client = await DaemonClient.connect(daemon.port, token);
  try {
    const agent = (await client.request("agents.create", {
      name: "Devin",
      provider: "devin",
      instructions: "",
    })) as { id: string };
    const turn = await sendAndWait(client, agent.id, "echo:hi", 15000);
    expect(turn.status).toBe("completed");
    expect(authParams(stateDir)).toEqual([{ methodId: "devin-browser" }]);
  } finally {
    await stopDaemon(daemon, client, stateDir);
  }
}, 30_000);
