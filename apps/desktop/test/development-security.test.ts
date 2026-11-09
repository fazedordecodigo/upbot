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
