import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeDir } from "../../../packages/daemon/test/helpers";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("preview recipe isolates fake ACP state outside the checkout", () => {
  expect(readme).toContain('STATE="$(mktemp -d "$HOME/boto-preview.XXXXXX")"');
  expect(readme).toContain('FAKE_ACP_STATE_DIR="$STATE/fake-acp"');
  expect(readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8")).toContain(
    ".fake-acp-state/",
  );
});

test("preview token stays in a private file and is reused in the browser hash without being printed", () => {
  expect(readme).toContain("umask 077");
  expect(readme).toContain('openssl rand -hex 32 > "$STATE/token"');
  expect(readme).toContain('chmod 600 "$STATE/token"');
  expect(readme).toContain('TOKEN="$(cat "$STATE/token")"');
  expect(readme).toContain('PREVIEW_STATE="$STATE" PREVIEW_PORT="$PORT" bun -e');
  expect(readme).toContain("set -x");
  expect(readme).not.toMatch(/(?:echo|console\.log)\s*\(?["']?\$TOKEN/);
});

test("preview credentials are never expanded into an external browser command", () => {
  expect(readme).not.toMatch(/(?:xdg-open|\bopen)\s+["'][^\n]*token=/);
});

for (const { name, contents, navigationError = false } of [
  { name: "valid", contents: "preview-canary" },
  { name: "empty", contents: "" },
  { name: "missing", contents: null },
  { name: "navigation error", contents: "preview-canary", navigationError: true },
]) {
  test(`documented preview launch reads private credentials (${name})`, async () => {
    const script = readme.match(
      /PREVIEW_STATE="\$STATE" PREVIEW_PORT="\$PORT" bun -e '([\s\S]*?)'/,
    )?.[1];
    expect(script).toBeDefined();
    if (!script) return;
    const fakeBrowser = `export const chromium = { launch: async (options) => {
      console.log(JSON.stringify({options, argv: process.argv}));
      return { newPage: async () => ({ goto: async (url) => {
        if (process.env.FAKE_PREVIEW_NAVIGATION_ERROR) throw new Error(url);
        console.log(JSON.stringify({url}));
      } }), close: async () => {}, once: (_event, resolve) => resolve() };
    } };`;
    const state = mkdtempSync(join(tmpdir(), "preview-security-"));
    try {
      const driver = join(state, "browser.mjs");
      writeFileSync(driver, fakeBrowser);
      const program = script.replace(
        '"playwright-core"',
        JSON.stringify(pathToFileURL(driver).href),
      );
      if (contents !== null) writeFileSync(join(state, "token"), contents, { mode: 0o600 });
      const command = [process.execPath, "-e", program];
      const child = Bun.spawn(command, {
        env: {
          ...process.env,
          PREVIEW_STATE: state,
          PREVIEW_PORT: "12345",
          FAKE_PREVIEW_NAVIGATION_ERROR: navigationError ? "1" : "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 15000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (navigationError) {
          expect(exit).not.toBe(0);
          expect(stderr).toContain("Preview navigation failed");
          expect(stdout + stderr).not.toContain("preview-canary");
        } else if (contents) {
          expect(exit).toBe(0);
          const [launch, navigation] = stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(JSON.stringify([command, launch])).not.toContain(contents);
          expect(launch.options).toEqual({ channel: "chrome", headless: false });
          const hash = new URLSearchParams(new URL(navigation.url).hash.slice(1));
          expect(hash.get("token")).toBe(contents);
          expect(hash.get("port")).toBe("12345");
        } else {
          expect(exit).not.toBe(0);
          expect(stdout).toBe("");
          expect(stderr).toContain(contents === null ? "ENOENT" : "Preview token file is empty");
        }
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    } finally {
      await removeDir(state);
    }
  }, 30000);
}
