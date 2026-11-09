import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("agent settings requests Computer Use availability for its selected bot", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/components/AgentConfigScreen.tsx"),
    "utf8",
  );
  expect(source).toContain('client.request("computer.access", { agentId })');
});
