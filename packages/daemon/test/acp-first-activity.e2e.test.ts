import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readPids,
  sendAndWait,
  startDaemon,
  stopTestChildren,
  tmp,
  waitForPidDead,
} from "./helpers";

const TOKEN = `acp-first-activity-${crypto.randomUUID()}`;
const WATCHDOG_MS = 1000;

describe("ACP prompt first-activity watchdog", () => {
  let dataDir: string | undefined;
  let agentsRoot: string | undefined;
  let stateDir: string | undefined;
  let daemon: DaemonHandle | undefined;
  let client: DaemonClient | undefined;

  function getClient(): DaemonClient {
    if (!client) throw new Error("Daemon client is unavailable");
    return client;
  }

  function getStateDir(): string {
    if (!stateDir) throw new Error("Fake ACP state directory is unavailable");
    return stateDir;
  }

  async function runPrompt(provider: "cursor" | "opencode", text: string) {
    const currentClient = getClient();
    const currentStateDir = getStateDir();
    const previousPids = new Set(readPids(currentStateDir));
    const agent = await currentClient.request("agents.create", {
      name: `${provider}-${crypto.randomUUID()}`,
      provider,
      instructions: "",
    });
    const startedAt = Date.now();
    const turn = await sendAndWait(currentClient, agent.id, text, 10000);
    return {
      agent,
      turn,
      elapsedMs: Date.now() - startedAt,
      pids: readPids(currentStateDir).filter((pid) => !previousPids.has(pid)),
    };
  }

  async function deleteAgent(agentId: string, pids: number[]) {
    await getClient().request("agents.delete", { id: agentId });
    for (const pid of pids) await waitForPidDead(pid);
  }

  beforeAll(async () => {
    const testDataDir = tmp("acp-first-activity-data-");
    const testAgentsRoot = tmp("acp-first-activity-agents-");
    const testStateDir = tmp("acp-first-activity-fake-");
    dataDir = testDataDir;
    agentsRoot = testAgentsRoot;
    stateDir = testStateDir;
    daemon = await startDaemon(testDataDir, testAgentsRoot, TOKEN, {
      BOTO_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      BOTO_ACP_COMMAND_OPENCODE: JSON.stringify(["bun", FAKE_AGENT]),
      BOTO_ACP_FIRST_ACTIVITY_MS: String(WATCHDOG_MS),
      FAKE_ACP_STATE_DIR: testStateDir,
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    if (client) {
      try {
        const agents = await client.request("agents.list", {});
        for (const agent of agents) await client.request("agents.delete", { id: agent.id });
      } catch {}
      client.close();
    }
    if (daemon) {
      try {
        daemon.proc.kill("SIGTERM");
        await daemon.proc.exited;
      } catch {}
    }
    await stopTestChildren(stateDir);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (agentsRoot)
      rmSync(agentsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (stateDir)
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("non-OpenCode prompts can exceed the OpenCode watchdog threshold", async () => {
    const result = await runPrompt("cursor", "watchdog-delay:1500");
    expect(result.turn.status).toBe("completed");
    expect(result.elapsedMs).toBeGreaterThan(WATCHDOG_MS);
    expect(result.pids).toHaveLength(1);
    await deleteAgent(result.agent.id, result.pids);
  });

  test("OpenCode with no prompt activity fails auth and tears down its child", async () => {
    const result = await runPrompt("opencode", "watchdog-idle");
    expect(result.turn.status).toBe("failed");
    expect(result.turn.error).toBe(
      "opencode requires sign-in. Run `opencode auth login` in a terminal.",
    );
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.pids).toHaveLength(1);
    const pid = result.pids[0];
    if (pid === undefined) throw new Error("OpenCode child PID was not recorded");
    await waitForPidDead(pid);
  });

  test("OpenCode metadata updates do not reset the first-activity watchdog", async () => {
    const result = await runPrompt("opencode", "watchdog-metadata-idle");
    expect(result.turn.status).toBe("failed");
    expect(result.turn.error).toBe(
      "opencode requires sign-in. Run `opencode auth login` in a terminal.",
    );
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.pids).toHaveLength(1);
    const pid = result.pids[0];
    if (pid === undefined) throw new Error("OpenCode child PID was not recorded");
    await waitForPidDead(pid);
  });

  test("OpenCode stays unbounded after its first prompt update", async () => {
    const result = await runPrompt("opencode", "watchdog-activity:10:1500");
    expect(result.turn.status).toBe("completed");
    expect(result.elapsedMs).toBeGreaterThan(WATCHDOG_MS);
    expect(result.pids).toHaveLength(1);
    await deleteAgent(result.agent.id, result.pids);
  });

  for (const decision of ["approve", "deny"] as const) {
    test(`OpenCode approval can wait beyond the watchdog and ${decision}`, async () => {
      const c = getClient();
      const agent = await c.request("agents.create", {
        name: `opencode-approval-${decision}`,
        provider: "opencode",
        instructions: "",
      });
      await c.request("approvals.setRules", {
        rules: [{ id: "watchdog-ask", pattern: "list_agents", action: "ask", agentId: agent.id }],
      });
      const pending = c.waitForEventWhere(
        "approval.updated",
        (a) => a.agentId === agent.id && a.status === "pending",
        10000,
      );
      const result = sendAndWait(c, agent.id, "mcp:list_agents {}", 10000);
      const approval = await pending;
      await Bun.sleep(WATCHDOG_MS * 2);
      const approvals = await c.request("approvals.list", {});
      expect(approvals.find((a) => a.id === approval.id)?.status).toBe("pending");
      await c.request("approvals.respond", { id: approval.id, decision });
      const turn = await result;
      expect(turn.status).toBe("completed");
      expect(turn.error).toBeNull();
      if (!dataDir) throw new Error("Daemon data directory is unavailable");
      const db = new Database(join(dataDir, "boto.db"), { readonly: true });
      try {
        const rows = db
          .query("SELECT data_json FROM approval_audit WHERE event = ? AND agent_id = ?")
          .all("approval.decided", agent.id) as { data_json: string }[];
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.data_json).status).toBe(
          decision === "approve" ? "approved" : "denied",
        );
      } finally {
        db.close();
      }
      await c.request("agents.delete", { id: agent.id });
    }, 15000);
  }
});
