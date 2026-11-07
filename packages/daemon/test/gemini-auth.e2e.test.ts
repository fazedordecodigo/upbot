import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

const TOKEN = `gemini-auth-${crypto.randomUUID()}`;

// Gemini CLI 0.65.0/0.67.0 `--acp` without a saved auth method or GEMINI_API_KEY
// answers session/new with this ACP auth error.
describe("signed-out Gemini", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let agent: Agent;

  beforeAll(async () => {
    dataDir = tmp("gemini-auth-data-");
    agentsRoot = tmp("gemini-auth-agents-");
    stateDir = tmp("gemini-auth-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_PROVIDER_COMMAND_GEMINI: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      FAKE_ACP_NEW_ERROR: "Gemini API key is missing or not configured.",
      FAKE_ACP_NEW_ERROR_CODE: "-32000",
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
    agent = await client.request("agents.create", {
      name: "Gemini",
      provider: "gemini",
      instructions: "",
    });
  });

  afterAll(async () => {
    await stopDaemon(daemon, client, stateDir);
    for (const directory of [dataDir, agentsRoot, stateDir]) {
      if (directory)
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("fails the turn with the interactive sign-in guidance", async () => {
    const { queueId } = await client.request("chat.send", { agentId: agent.id, text: "hello" });
    const turn = await client.waitForEventWhere("turn.ended", (event) => event.queueId === queueId);
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain(
      "gemini requires sign-in. Run `gemini` in a terminal and choose Sign in with Google, Use Gemini API Key or Vertex AI.",
    );
    expect(turn.error).toContain("Gemini API key is missing or not configured.");
  });
});
