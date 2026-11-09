import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCommandIn } from "../src/env/login-path";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

test("Windows catalog command lookup respects PATHEXT and PATH order", () => {
  expect(
    resolveCommandIn("codex", ["C:\\first", "C:\\second"], {
      platform: "win32",
      pathext: ".EXE;.CMD",
      exists: (path) => ["C:\\first\\codex.CMD", "C:\\second\\codex.EXE"].includes(path),
    }),
  ).toBe("C:\\first\\codex.CMD");
});

test.skipIf(process.platform === "win32")(
  "provider catalog RPCs, login, defaults and secret masking",
  async () => {
    const root = tmp("boto-providers-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const shell = join(root, "shell");
    writeFileSync(shell, `#!/bin/sh\nprintf '__OA_PATH__${bin}__OA_PATH__'\n`);
    chmodSync(shell, 0o755);
    const codex = join(bin, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n");
    chmodSync(codex, 0o755);
    const login = join(root, "login");
    writeFileSync(
      login,
      `#!/bin/sh\n/bin/sleep 0.3\n/bin/mkdir -p '${root}/.codex'\nprintf '{}' > '${root}/.codex/auth.json'\n`,
    );
    chmodSync(login, 0o755);
    const missing = JSON.stringify([join(root, "missing")]);
    const daemon = await startDaemon(
      root,
      join(root, "agents"),
      "catalog-test",
      {
        HOME: root,
        SHELL: shell,
        PATH: bin,
        BOTO_VAULT_KEY: "12".repeat(32),
        BOTO_PROVIDER_COMMAND_CLAUDE: missing,
        BOTO_PROVIDER_COMMAND_GEMINI: missing,
        BOTO_PROVIDER_COMMAND_OPENCODE: missing,
        BOTO_PROVIDER_COMMAND_CURSOR: missing,
        BOTO_PROVIDER_COMMAND_DEVIN: missing,
        BOTO_PROVIDER_COMMAND_GROK: missing,
        BOTO_PROVIDER_LOGIN_COMMAND_CODEX: JSON.stringify([login]),
      },
      true,
    );
    const client = await DaemonClient.connect(daemon.port, "catalog-test");
    const stdout = (async () => {
      const reader = (daemon.proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let output = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return output;
        output += decoder.decode(value, { stream: true });
      }
    })();
    const secret = "test-provider-private-key-1234";
    try {
      const initial = await client.request("providers.list", {});
      expect(initial).toHaveLength(7);
      expect(initial.find((p) => p.id === "codex")).toMatchObject({
        installed: true,
        path: codex,
        version: "1.2.3",
        loggedIn: false,
        ready: false,
      });
      expect(initial.find((p) => p.id === "claude")).toMatchObject({
        installed: false,
        version: null,
      });
      expect(await client.request("providers.getDefault", {})).toEqual({ provider: null });
      await expect(client.request("agents.create", { name: "No default" })).rejects.toMatchObject({
        code: "bad_request",
      });
      await expect(
        client.request("providers.setDefault", { provider: "codex" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(client.request("providers.login", { provider: "claude" })).rejects.toMatchObject(
        { code: "bad_request" },
      );
      await expect(
        client.request("providers.setDefault", { provider: "openai-compatible" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        client.request("providers.setApiKey", { provider: "codex", value: "short" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      expect(
        await client.request("providers.setApiKey", { provider: "codex", value: ` ${secret} ` }),
      ).toMatchObject({ hasApiKey: true, apiKeyMasked: "••••1234", ready: true });
      expect(JSON.stringify(await client.request("providers.list", {}))).not.toContain(secret);
      await client.request("providers.setDefault", { provider: "codex" });
      expect(await client.request("providers.getDefault", {})).toEqual({ provider: "codex" });
      expect(await client.request("agents.create", { name: "Catalog bot" })).toMatchObject({
        provider: "codex",
      });
      expect(
        await client.request("agents.create", { name: "Explicit bot", provider: "claude" }),
      ).toMatchObject({ provider: "claude" });
      expect(
        await client.request("providers.setApiKey", { provider: "codex", value: "12345678" }),
      ).toMatchObject({ apiKeyMasked: "••••" });
      expect(await client.request("providers.deleteApiKey", { provider: "codex" })).toMatchObject({
        hasApiKey: false,
        apiKeyMasked: null,
        ready: false,
      });
      await client.request("providers.scan", {});
      await client.waitForEvent("providers.changed");
      writeFileSync(codex, "#!/bin/sh\nprintf 'codex-cli 2.3.4\\n'\n");
      expect(
        (await client.request("providers.list", {})).find((p) => p.id === "codex")?.version,
      ).toBe("1.2.3");
      expect(
        (await client.request("providers.scan", {})).find((p) => p.id === "codex")?.version,
      ).toBe("2.3.4");
      writeFileSync(codex, "#!/bin/sh\nexit 1\n");
      expect(
        (await client.request("providers.scan", {})).find((p) => p.id === "codex")?.version,
      ).toBeNull();
      expect(await client.request("providers.login", { provider: "codex" })).toMatchObject({
        loginRunning: true,
      });
      const deadline = Date.now() + 5000;
      let info = (await client.request("providers.list", {})).find((p) => p.id === "codex");
      while (info?.loginRunning && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        info = (await client.request("providers.list", {})).find((p) => p.id === "codex");
      }
      expect(info).toMatchObject({ loggedIn: true, loginRunning: false, ready: true });
      await client.request("vmCredentials.set", {
        provider: "claude",
        kind: "oauth_token",
        value: "fake-oauth-token",
      });
      expect(await client.request("providers.deleteApiKey", { provider: "claude" })).toMatchObject({
        loggedIn: true,
        hasApiKey: false,
      });
      expect(await client.request("vmCredentials.list", {})).toContainEqual(
        expect.objectContaining({ provider: "claude", kind: "oauth_token" }),
      );
    } finally {
      await stopDaemon(daemon, client);
      expect(await daemon.stderrText).not.toContain(secret);
      expect(await stdout).not.toContain(secret);
      await removeDir(root);
    }
  },
  30000,
);
