import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performDesktopEvents } from "../src/main";

test.skipIf(process.platform === "win32")(
  "desktop typing sends 2000 characters without a per-character timeout budget",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-type-"));
    const command = join(dir, "xdotool");
    const oldPath = process.env.PATH;
    try {
      writeFileSync(
        command,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, "args")}'\n/bin/cat > '${join(dir, "text")}'\n`,
      );
      chmodSync(command, 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      const text = "a".repeat(2000);
      expect(performDesktopEvents(":0", [{ type: "type", text }])).toBe("type");
      expect(readFileSync(join(dir, "text"), "utf8")).toBe(text);
      expect(readFileSync(join(dir, "args"), "utf8").split("\n")).toContain("0");
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "desktop input reports failed xdotool instead of successful key delivery",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-failure-"));
    const command = join(dir, "xdotool");
    const oldPath = process.env.PATH;
    try {
      writeFileSync(command, "#!/bin/sh\nexit 1\n");
      chmodSync(command, 0o755);
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      expect(() => performDesktopEvents(":0", [{ type: "key", keysym: "ctrl+Return" }])).toThrow(
        "desktop input command failed",
      );
      expect(performDesktopEvents(":0", [])).toBe("move");
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
