import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_AGENT, ROOT, removeDir, tmp } from "./helpers";

test("fake provider records only reserved environment key names, never values", async () => {
  const dir = tmp("fixture-env-");
  const secret = "fixture-test-secret-canary";
  const proc = Bun.spawn([process.execPath, FAKE_AGENT], {
    env: { FAKE_ACP_STATE_DIR: dir, BOTO_FIXTURE_TEST: secret, API_KEY: secret },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const file = join(dir, "env.json");
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(25);
    const raw = readFileSync(file, "utf8");
    expect(raw.includes(secret)).toBe(false);
    const dump = JSON.parse(raw) as { keys: string[] };
    expect(Object.keys(dump)).toEqual(["keys"]);
    expect(dump.keys).toContain("BOTO_FIXTURE_TEST");
    expect(dump.keys.every((key) => key.startsWith("BOTO_"))).toBe(true);
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toContain(".fake-acp-state/");
  } finally {
    proc.kill();
    await proc.exited;
    removeDir(dir);
  }
}, 10_000);
