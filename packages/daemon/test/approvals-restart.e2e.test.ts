import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Approval } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopDaemon,
  tmp,
  toolCall,
} from "./helpers";

setDefaultTimeout(30000);

const TOKEN = `approvals-restart-${crypto.randomUUID()}`;
const FAKE_MCP = join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts");
const SENTINEL = "restart-sentinel-args";

describe("approvals across daemon restarts", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;

  const start = async () => {
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_VAULT_KEY: "34".repeat(32),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  };

  /** Starts a tool call that blocks on an approval and returns that pending approval. */
  const blockOn = async (name: string, args: Record<string, unknown>): Promise<Approval> => {
    const pending = c.waitForEventWhere("approval.updated", (d) => d.status === "pending", 20000);
    toolCall(c, a, name, args).catch(() => {});
    return pending;
  };

  const restart = async (signal: "SIGKILL" | "SIGTERM") => {
    await stopDaemon(daemon, c, stateDir, signal);
    await start();
  };

  const audit = (event: string) => {
    const db = new Database(join(dataDir, "boto.db"), { readonly: true });
    try {
      return db
        .query("SELECT approval_id, data_json FROM approval_audit WHERE event = ?")
        .all(event) as { approval_id: string; data_json: string }[];
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    dataDir = tmp("appr-restart-data-");
    agentsRoot = tmp("appr-restart-agents-");
    stateDir = tmp("appr-restart-fake-");
    await start();
    a = await c.request("agents.create", { name: "A", provider: "devin", instructions: "" });
    await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Notes",
      command: ["bun", FAKE_MCP],
      secrets: { FAKE_APP_PERMISSIONS: "1" },
    });
  });

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("kill -9 with a pending approval lists it as interrupted, audited and not decidable", async () => {
    const pending = await blockOn("notes-create_note", { title: SENTINEL });
    expect(pending.detail).toContain(SENTINEL);
    await restart("SIGKILL");

    const listed = await c.request("approvals.list", {});
    const interrupted = listed.find((x) => x.id === pending.id);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      kind: "tool",
      tool: "notes-create_note",
      title: "Run notes-create_note",
      detail: "",
      appName: "Notes",
      permission: "write",
    });
    expect(interrupted?.interruptedAt).toBeGreaterThan(pending.createdAt);
    expect((await c.request("approvals.list", { agentId: a.id })).map((x) => x.id)).toContain(
      pending.id,
    );
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);

    await expect(
      c.request("approvals.respond", { id: pending.id, decision: "approve" }),
    ).rejects.toThrow("interrupted by a daemon restart");

    // The blocked turn is interrupted too; nothing re-runs the call.
    const history = await c.request("chat.history", { agentId: a.id });
    expect(history.turns.find((t) => t.id === pending.turnId)?.status).toBe("interrupted");
    expect(history.items.some((i) => JSON.stringify(i).includes("tool-ok:note-created"))).toBe(
      false,
    );

    const events = audit("approval.interrupted");
    expect(events.map((e) => e.approval_id)).toEqual([pending.id]);
    expect(JSON.parse(events[0]!.data_json)).toMatchObject({
      reason: "daemon_restart",
      tool: "notes-create_note",
    });
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  test("SIGTERM keeps a pending secret request for the next start; leftovers are audited once", async () => {
    const pending = await blockOn("request_secret", {
      name: "stripe.key",
      label: "Stripe",
      reason: SENTINEL,
    });
    expect(pending.kind).toBe("secret");
    await restart("SIGTERM");

    const listed = await c.request("approvals.list", {});
    expect(listed.find((x) => x.id === pending.id)).toMatchObject({
      status: "interrupted",
      kind: "secret",
      secretName: "stripe.key",
      detail: "",
    });
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
    await expect(
      c.request("approvals.respond", { id: pending.id, decision: "approve", value: "sk_live" }),
    ).rejects.toThrow("interrupted by a daemon restart");
    expect(await c.request("vault.list", {})).not.toContainEqual(
      expect.objectContaining({ name: "stripe.key" }),
    );
    // A graceful shutdown must not expire it first.
    expect(audit("approval.decided").some((e) => e.approval_id === pending.id)).toBe(false);

    await restart("SIGTERM");
    const ids = audit("approval.interrupted").map((e) => e.approval_id);
    expect(ids.filter((id) => id === pending.id)).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });
});
