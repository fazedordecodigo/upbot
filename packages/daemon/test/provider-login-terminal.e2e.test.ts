import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

test.skipIf(process.platform === "win32")(
  "Gemini login exposes its method prompt in a terminal and accepts a choice",
  async () => {
    const root = tmp("login-terminal-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const gemini = join(bin, "gemini");
    const terminal = join(bin, "terminal");
    const choice = join(root, "choice");
    const output = join(root, "terminal-output");
    writeFileSync(
      gemini,
      `#!/bin/sh\nprintf 'Choose Google, API key or Vertex AI: '\nread method\n[ "$method" = google ] || exit 1\nprintf '%s' "$method" > '${choice}'\n`,
    );
    writeFileSync(terminal, `#!/bin/sh\nprintf 'google\\n' | "$@" > '${output}'\n`);
    for (const path of [gemini, terminal]) chmodSync(path, 0o755);
    const daemon = await startDaemon(
      join(root, "data"),
      join(root, "agents"),
      "login-terminal-test",
      {
        BOTO_PROVIDER_COMMAND_GEMINI: JSON.stringify([gemini]),
        BOTO_PROVIDER_LOGIN_COMMAND_GEMINI: JSON.stringify([gemini]),
        BOTO_PROVIDER_TERMINAL_COMMAND: JSON.stringify([terminal]),
      },
    );
    const client = await DaemonClient.connect(daemon.port, "login-terminal-test");
    try {
      await client.request("providers.login", { provider: "gemini" });
      const deadline = Date.now() + 5000;
      while (!existsSync(choice) && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync(choice)).toBe(true);
      expect(readFileSync(choice, "utf8")).toBe("google");
      expect(readFileSync(output, "utf8")).toContain("Google, API key or Vertex AI");
    } finally {
      await stopDaemon(daemon, client);
      removeDir(root);
    }
  },
  30_000,
);
