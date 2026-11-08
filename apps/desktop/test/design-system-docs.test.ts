import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("docs name the token source, generator, Rio Negro mapping and OFL fonts", () => {
  const doc = read("docs/design-system.md");
  const readme = read("README.md");
  const agents = read("AGENTS.md");
  expect(doc).toContain("apps/desktop/src/styles/tokens.json");
  expect(doc).toContain("apps/desktop/src/styles/tokens.css");
  expect(doc).toContain("scripts/build-tokens.ts");
  expect(doc).toContain("Bricolage Grotesque");
  expect(doc).toContain("Inter");
  expect(doc).toContain("JetBrains Mono");
  expect(doc).toContain("legacy-bridge.css");
  for (const hex of [
    "#0c1416",
    "#131d20",
    "#e8eeee",
    "#f08aa6",
    "#c2456b",
    "#3bb7a5",
    "#1a7d6f",
    "#f6f8f7",
  ]) {
    expect(doc).toContain(hex);
  }
  expect(doc).toContain("accent");
  expect(doc).not.toContain("Host Grotesk");
  expect(doc).not.toContain("DM Mono");
  expect(readme).toContain("SIL Open Font License");
  expect(readme).toContain("Bricolage Grotesque");
  expect(readme).toContain("Inter");
  expect(readme).toContain("JetBrains Mono");
  expect(readme).not.toContain("Nunito");
  expect(readme).not.toContain("Host Grotesk");
  expect(agents).toContain("tokens.json");
  expect(agents).toContain("build-tokens.ts");
  expect(agents).toContain("icons.tsx");
  expect(agents).toContain("Bricolage Grotesque");
  expect(agents).not.toContain("Host Grotesk");
});
