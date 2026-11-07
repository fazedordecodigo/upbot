import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpDriver } from "../src/providers/acp";
import { commandFor, providerCommand } from "../src/providers/process";
import type { RemoteLaunch } from "../src/providers/types";
import { FAKE_AGENT, readLog, tmp } from "./helpers";

for (const mode of ["key", "empty", "other-key", "rejected", "resume"] as const) {
  test(`Grok VM authentication: ${mode}`, async () => {
    const stateDir = tmp("grok-auth-");
    if (mode === "resume")
      writeFileSync(
        join(stateDir, "sessions.json"),
        JSON.stringify({ "previous-session": { prompts: [] } }),
      );
    const key = "GrokVmSecretSentinel";
    const credentials =
      mode === "empty" ? {} : mode === "other-key" ? { OTHER_KEY: key } : { XAI_API_KEY: key };
    let stderr = "";
    const remote: RemoteLaunch = {
      cwd: stateDir,
      describe: "fake VM",
      credentials,
      mcp: (spec) => spec,
      spawn: () => {
        const child = spawn(process.execPath, [FAKE_AGENT], {
          env: {
            ...process.env,
            ...credentials,
            FAKE_ACP_STATE_DIR: stateDir,
            ...(mode === "rejected"
              ? { FAKE_ACP_AUTH_ERROR: `Authentication failed: invalid api key ${key}` }
              : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        return child;
      },
    };
    const start = new AcpDriver("grok").start({
      cwd: stateDir,
      resumeSessionId: mode === "resume" ? "previous-session" : null,
      remote,
      hooks: {
        onUpdate: () => {},
        onExit: () => {},
        requestPermission: async () => ({ optionId: null }),
      },
    });
    if (mode === "rejected") {
      await expect(start).rejects.toThrow("the saved microVM credential was rejected");
      await start.catch((error) => expect(String(error)).not.toContain(key));
    } else {
      const session = await start;
      await session.close();
    }
    const requests = readLog(stateDir);
    const auth = requests.filter((entry) => entry.method === "authenticate");
    expect(auth.map((entry) => entry.params)).toEqual(
      mode === "key" || mode === "rejected" || mode === "resume"
        ? [{ methodId: "xai.api_key", _meta: { headless: true } }]
        : [],
    );
    if (mode === "key" || mode === "resume") {
      const methods = requests.map((entry) => entry.method);
      expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("authenticate"));
      expect(methods.indexOf("authenticate")).toBeLessThan(
        methods.indexOf(mode === "resume" ? "session/load" : "session/new"),
      );
    }
    expect(readFileSync(join(stateDir, "log.jsonl"), "utf8")).not.toContain(key);
    expect(stderr).not.toContain(key);
  });
}

test("remote Grok default disables updates while overrides win", () => {
  const remote = {} as RemoteLaunch;
  const previous = process.env.BOTO_PROVIDER_COMMAND_GROK;
  const legacy = process.env.BOTO_ACP_COMMAND_GROK;
  try {
    delete process.env.BOTO_PROVIDER_COMMAND_GROK;
    delete process.env.BOTO_ACP_COMMAND_GROK;
    expect(commandFor("grok")).toEqual(["grok", "agent", "stdio"]);
    expect(providerCommand("grok", remote)).toEqual({
      bin: "grok",
      args: ["--no-auto-update", "agent", "stdio"],
    });
    process.env.BOTO_ACP_COMMAND_GROK = '["legacy", "acp"]';
    expect(providerCommand("grok", remote)).toEqual({ bin: "legacy", args: ["acp"] });
    process.env.BOTO_PROVIDER_COMMAND_GROK = '["custom", "stdio"]';
    expect(providerCommand("grok", remote)).toEqual({ bin: "custom", args: ["stdio"] });
  } finally {
    if (previous === undefined) delete process.env.BOTO_PROVIDER_COMMAND_GROK;
    else process.env.BOTO_PROVIDER_COMMAND_GROK = previous;
    if (legacy === undefined) delete process.env.BOTO_ACP_COMMAND_GROK;
    else process.env.BOTO_ACP_COMMAND_GROK = legacy;
  }
});
