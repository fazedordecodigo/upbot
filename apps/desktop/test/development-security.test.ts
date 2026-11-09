import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  expect(readme).toContain('xdg-open "http://localhost:1420/#port=$PORT&token=$TOKEN"');
  expect(readme).toContain("set -x");
  expect(readme).not.toMatch(/(?:echo|console\.log)\s*\(?["']?\$TOKEN/);
});
