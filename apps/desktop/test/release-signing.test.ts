import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const tauriDir = resolve(import.meta.dir, "../src-tauri");
const read = (path: string) => readFileSync(path, "utf8");

test("macOS bundles use Bun and device entitlements with usage descriptions", () => {
  const config = JSON.parse(read(resolve(tauriDir, "tauri.conf.json")));
  const path = resolve(tauriDir, config.bundle.macOS.entitlements);
  expect(existsSync(path)).toBe(true);
  const entitlements = read(path);
  for (const key of [
    "cs.allow-jit",
    "cs.allow-unsigned-executable-memory",
    "cs.disable-executable-page-protection",
    "cs.allow-dyld-environment-variables",
    "cs.disable-library-validation",
    "device.audio-input",
    "automation.apple-events",
  ]) {
    expect(entitlements).toMatch(
      new RegExp(`<key>com\\.apple\\.security\\.${key.replaceAll(".", "\\.")}</key>\\s*<true/>`),
    );
  }
  const info = read(resolve(tauriDir, "Info.plist"));
  expect(info).toContain("<key>NSMicrophoneUsageDescription</key>");
  expect(info).toContain("<key>NSAppleEventsUsageDescription</key>");
});

test("Windows certificate secrets are scoped to the Windows signing step", () => {
  const workflow = read(resolve(import.meta.dir, "../../../.github/workflows/release.yml"));
  const steps = workflow.split(/^ {6}- /m);
  for (const name of ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"]) {
    const references = steps.filter((step) => step.includes(`secrets.${name} }`));
    expect(references).toHaveLength(1);
    expect(references[0]).toContain("id: windows-signing");
    expect(references[0]).toContain("if: runner.os == 'Windows'");
  }
});
