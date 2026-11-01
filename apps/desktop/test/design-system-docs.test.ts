import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("docs name the token source, generator, Eco mapping and OFL fonts", () => {
  const doc = read("docs/design-system.md");
  const readme = read("README.md");
  const agents = read("AGENTS.md");
  expect(doc).toContain("apps/desktop/src/styles/tokens.json");
  expect(doc).toContain("apps/desktop/src/styles/tokens.css");
  expect(doc).toContain("scripts/build-tokens.ts");
  expect(doc).toContain("Host Grotesk");
  expect(doc).toContain("DM Mono");
  expect(doc).toContain("legacy-bridge.css");
  for (const hex of ["#110E12", "#F29BB2", "#C2557B", "#7A4A6E", "#EDE6EA"]) {
    expect(doc).toContain(hex);
  }
  expect(doc).toContain("accent");
  expect(readme).toContain("SIL Open Font License");
  expect(readme).toContain("Host Grotesk");
  expect(readme).toContain("DM Mono");
  expect(readme).not.toContain("Nunito");
  expect(agents).toContain("tokens.json");
  expect(agents).toContain("build-tokens.ts");
  expect(agents).toContain("icons.tsx");
});
