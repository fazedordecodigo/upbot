import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const updaterAssets = {
  "darwin-aarch64": "Boto.app.tar.gz",
  "linux-x86_64": "Boto_0.3.0_amd64.AppImage",
  "linux-aarch64": "Boto_0.3.0_aarch64.AppImage",
  "windows-x86_64": "Boto_0.3.0_x64-setup.exe",
  "windows-aarch64": "Boto_0.3.0_arm64-setup.exe",
};

test.each(["complete", "missing", "empty", "duplicate"])(
  "compose updater metadata: %s assets",
  (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "boto-latest-"));
    try {
      let names = Object.values(updaterAssets);
      if (scenario === "missing") names = names.slice(0, -1);
      if (scenario === "empty") names = [];
      if (scenario === "duplicate") names.push("Boto_other_arm64-setup.exe");
      const assets = names.flatMap((name) => [{ name }, { name: `${name}.sig` }]);
      assets.push({ name: "Boto_0.3.0_arm64.deb" }, { name: "Boto-0.3.0-1.aarch64.rpm" });
      writeFileSync(join(dir, "assets.json"), JSON.stringify({ assets }));
      writeFileSync(join(dir, "notes.md"), "Release notes");
      for (const name of names) writeFileSync(join(dir, `${name}.sig`), `signature:${name}\n`);
      const result = spawnSync(
        process.platform === "win32" ? "python" : "python3",
        [
          resolve(import.meta.dir, "../../../scripts/compose-latest.py"),
          "--assets-json",
          join(dir, "assets.json"),
          "--signatures-dir",
          dir,
          "--repository",
          "fazedordecodigo/boto",
          "--tag",
          "v0.3.0",
          "--expected-version",
          "0.3.0",
          "--notes-file",
          join(dir, "notes.md"),
          "--output",
          join(dir, "latest.json"),
        ],
        { encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      if (scenario !== "complete") {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("expected exactly one updater asset");
        return;
      }
      expect(result.status).toBe(0);
      const metadata = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
      expect(metadata.version).toBe("0.3.0");
      expect(metadata.notes).toBe("Release notes");
      expect(Object.keys(metadata.platforms)).toEqual(Object.keys(updaterAssets));
      for (const [platform, name] of Object.entries(updaterAssets)) {
        expect(metadata.platforms[platform]).toEqual({
          signature: `signature:${name}`,
          url: `https://github.com/fazedordecodigo/boto/releases/download/v0.3.0/${name}`,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
