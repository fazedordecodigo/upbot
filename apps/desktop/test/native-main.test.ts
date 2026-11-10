import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../packages/daemon/test/helpers";

test("tray and shortcut focus the main window without a native popover", () => {
  const native = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/menubar.rs"), "utf8");
  expect(native.includes("index.html#/menubar")).toBe(false);
  expect(native.match(/focus_main\(app.clone\(\)\)/g)?.length).toBe(2);
  expect(native).toContain("pub async fn open_main");
  const entry = readFileSync(join(ROOT, "apps/desktop/src/main.tsx"), "utf8");
  expect(entry.includes('"#/menubar"')).toBe(false);
  expect(
    JSON.parse(readFileSync(join(ROOT, "apps/desktop/src-tauri/capabilities/menubar.json"), "utf8"))
      .windows,
  ).toEqual(["main"]);
});

test("every Firecracker test command names only tests present in this split", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (!name.startsWith("test:firecracker")) continue;
    for (const file of command.split(" ").filter((word) => word.endsWith(".test.ts")))
      expect(existsSync(join(ROOT, file))).toBe(true);
  }
});
