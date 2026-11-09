import { expect, test } from "bun:test";
import { join } from "node:path";
import { type ApprovalRule, ToolPermission } from "@boto/protocol";
import { DaemonClient, ROOT, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

test("tool permission RPCs map rules and MCP apps, preserve safeguards and emit existing events", async () => {
  const root = tmp("boto-tool-permissions-");
  const daemon = await startDaemon(root, join(root, "agents"), "tool-permissions-test", {
    BOTO_VAULT_KEY: "34".repeat(32),
  });
  const client = await DaemonClient.connect(daemon.port, "tool-permissions-test");
  try {
    expect(await client.request("tools.permissions.list", {})).toEqual([]);
    await expect(
      client.request("tools.permissions.set", { toolId: "unknown", level: "ask" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      client.request("tools.permissions.set", { toolId: "unknown", level: "invalid" as "ask" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const rules: [ApprovalRule, ApprovalRule] = [
      { id: "first", pattern: "computer_*", action: "ask" as const, agentId: null },
      { id: "second", pattern: "browser_*", action: "allow" as const, agentId: "bot-specific" },
    ];
    await client.request("approvals.setRules", { rules });
    await client.waitForEvent("approvals.rulesChanged");
    expect(await client.request("tools.permissions.list", {})).toEqual(
      rules.map((rule) => ({
        toolId: `rule:${rule.id}`,
        label: rule.pattern,
        group: "computer",
        level: rule.action,
        levels: ["ask", "allow"],
        sensitive: false,
        agentId: rule.agentId,
        appId: null,
        permission: null,
      })),
    );
    const changed = await client.request("tools.permissions.set", {
      toolId: "rule:first",
      level: "allow",
    });
    await client.waitForEvent("approvals.rulesChanged");
    expect(changed[0]?.level).toBe("allow");
    expect(await client.request("approvals.rules", {})).toEqual([
      { ...rules[0], action: "allow" },
      rules[1],
    ]);
    await expect(
      client.request("tools.permissions.set", { toolId: "rule:first", level: "off" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await client.request("approvals.rules", {})).toEqual([
      { ...rules[0], action: "allow" },
      rules[1],
    ]);
    const app = await client.request("apps.connect", {
      catalogId: "custom-stdio",
      secrets: {},
      name: "Fixture MCP",
      command: [process.execPath, join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts")],
    });
    const entries = await client.request("tools.permissions.list", {});
    expect(entries).toHaveLength(8);
    for (const entry of entries) expect(ToolPermission.safeParse(entry).success).toBe(true);
    const labels = {
      read: "Ler",
      write: "Editar",
      send: "Enviar",
      pay: "Pagar",
      book: "Reservar",
      del: "Excluir",
    } as const;
    for (const kind of ["read", "write", "send", "pay", "book", "del"] as const) {
      const sensitive = kind !== "read" && kind !== "write";
      expect(entries.find((entry) => entry.toolId === `app:${app.id}:${kind}`)).toEqual({
        toolId: `app:${app.id}:${kind}`,
        label: `Fixture MCP · ${labels[kind]}`,
        group: "mcp",
        level: app.permissions[kind],
        levels: sensitive ? ["off", "ask"] : ["off", "ask", "allow"],
        sensitive,
        appId: app.id,
        agentId: null,
        permission: kind,
      });
    }
    for (const kind of ["send", "pay", "book", "del"] as const) {
      await expect(
        client.request("tools.permissions.set", {
          toolId: `app:${app.id}:${kind}`,
          level: "allow",
        }),
      ).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("sensíveis"),
      });
    }
    expect((await client.request("apps.list", {}))[0]?.permissions).toEqual(app.permissions);
    const eventCount = client.events.filter((event) => event.event === "apps.changed").length;
    const updated = await client.request("tools.permissions.set", {
      toolId: `app:${app.id}:write`,
      level: "allow",
    });
    expect(updated).toHaveLength(8);
    expect(updated.find((entry) => entry.toolId === `app:${app.id}:write`)?.level).toBe("allow");
    expect(client.events.filter((event) => event.event === "apps.changed").length).toBeGreaterThan(
      eventCount,
    );
    expect((await client.request("apps.list", {}))[0]?.permissions).toEqual({
      ...app.permissions,
      write: "allow",
    });
    expect(
      (
        await client.request("tools.permissions.set", {
          toolId: `app:${app.id}:send`,
          level: "off",
        })
      ).find((entry) => entry.permission === "send")?.level,
    ).toBe("off");
    expect(
      (
        await client.request("tools.permissions.set", {
          toolId: `app:${app.id}:send`,
          level: "ask",
        })
      ).find((entry) => entry.permission === "send")?.level,
    ).toBe("ask");
    await expect(
      client.request("tools.permissions.set", { toolId: `app:${app.id}:unknown`, level: "off" }),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await stopDaemon(daemon, client);
    await removeDir(root);
  }
}, 30000);
