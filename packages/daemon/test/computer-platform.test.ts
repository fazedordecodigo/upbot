import { describe, expect, test } from "bun:test";
import {
  type ComputerBackend,
  clickCommand,
  computerSupport,
  keyCommand,
  screenshotCommand,
  typeCommand,
} from "../src/computer-platform";

describe("computer platform commands", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    test(`${platform} dry run and whitelist`, () => {
      const support = computerSupport({
        platform,
        env: { BOTO_COMPUTER_DRYRUN: "log" },
        which: () => null,
      });
      if (!("backend" in support)) throw new Error("missing backend");
      const backend = support.backend;
      expect(clickCommand(backend, 10, 20, true).length).toBeGreaterThan(1);
      expect(screenshotCommand(backend, "/tmp/a'b.png").length).toBeGreaterThan(1);
      expect(typeCommand(backend, "Olá '$();+{}🙂").length).toBeGreaterThan(1);
      for (const key of ["return", "enter", "delete", "left", "pageup", "a", "9"])
        expect(
          keyCommand(backend, key, ["command", "control", "option", "shift"]).length,
        ).toBeGreaterThan(1);
      for (const key of ["f13", "constructor", "__proto__", "a;exit"])
        expect(() => keyCommand(backend, key, [])).toThrow("unsupported key");
      expect(() => keyCommand(backend, "a", ["constructor"])).toThrow("modifiers");
    });
  }
  test("Linux commands and screenshot fallbacks", () => {
    for (const tool of ["import", "scrot", "gnome-screenshot"] as const) {
      const support = computerSupport({
        platform: "linux",
        env: { DISPLAY: ":0" },
        which: (name) => (name === "xdotool" || name === tool ? name : null),
      });
      if (!("backend" in support)) throw new Error("missing backend");
      expect(screenshotCommand(support.backend, "/a.png")[0]).toBe(tool);
      expect(keyCommand(support.backend, "s", ["control", "option"])).toEqual([
        "xdotool",
        "key",
        "--clearmodifiers",
        "ctrl+alt+s",
      ]);
      expect(typeCommand(support.backend, "--evil").slice(-2)).toEqual(["--", "--evil"]);
      expect(clickCommand(support.backend, 1, 2, true)).toEqual([
        "xdotool",
        "mousemove",
        "1",
        "2",
        "click",
        "--repeat",
        "2",
        "--delay",
        "100",
        "1",
      ]);
    }
  });
  test("Windows uses encoded scripts, Unicode input and DPI-aware capture", () => {
    const backend: ComputerBackend = { platform: "win32", powershell: "powershell.exe" };
    const decode = (cmd: string[]) => Buffer.from(cmd.at(-1) ?? "", "base64").toString("utf16le");
    expect(decode(typeCommand(backend, "secret"))).toContain("Type($env:BOTO_COMPUTER_TEXT)");
    expect(decode(typeCommand(backend, "secret"))).not.toContain("secret");
    expect(decode(clickCommand(backend, 10, 20, true))).toContain("SetCursorPos(10, 20)");
    expect(decode(screenshotCommand(backend, "C:\\a'b.png"))).toContain("C:\\a''b.png");
    expect(decode(screenshotCommand(backend, "a.png"))).toContain("SetProcessDPIAware()");
    expect(decode(keyCommand(backend, "left", ["command", "shift"]))).toContain(
      "::Key(37, 1, [uint16[]]@(91,16))",
    );
  });
  test("Windows scripts avoid PowerShell 6.2 numeric aliases", () => {
    const backend: ComputerBackend = { platform: "win32", powershell: "powershell.exe" };
    for (const command of [
      screenshotCommand(backend, "a.png"),
      clickCommand(backend, 10, 20, true),
      typeCommand(backend, "text"),
      keyCommand(backend, "return", []),
      keyCommand(backend, "a", ["control"]),
    ]) {
      const script = Buffer.from(command.at(-1) ?? "", "base64").toString("utf16le");
      expect(script).not.toMatch(/\[(?:short|ushort|uint|ulong)(?:\[\])?\]/i);
    }
  });
  test.skipIf(process.platform !== "win32")(
    "Windows PowerShell parses scripts and resolves key types without sending input",
    () => {
      const backend: ComputerBackend = { platform: "win32", powershell: "powershell.exe" };
      for (const command of [
        screenshotCommand(backend, "a.png"),
        clickCommand(backend, 10, 20, true),
        typeCommand(backend, ""),
        keyCommand(backend, "return", []),
        keyCommand(backend, "a", ["control"]),
      ]) {
        const script = Buffer.from(command.at(-1) ?? "", "base64").toString("utf16le");
        const check = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${command.at(-1)}'))
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
${script.slice(0, script.indexOf("\n'@") + 3)}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TypeExpressionAst] -or $n -is [System.Management.Automation.Language.TypeConstraintAst] }, $true)) {
  if ($null -eq $node.TypeName.GetReflectionType()) { throw ('Unresolved type: ' + $node.TypeName.FullName) }
}`;
        const result = Bun.spawnSync([
          ...command.slice(0, -1),
          Buffer.from(check, "utf16le").toString("base64"),
        ]);
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
      }
    },
    // Each fresh powershell.exe pays ~30 s for its first Add-Type on Windows ARM64.
    process.arch === "arm64" ? 300_000 : 30_000,
  );
  test("availability explains Wayland, missing display and tools", () => {
    for (const [env, reason] of [
      [{ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, "Wayland"],
      [{}, "DISPLAY"],
      [{ DISPLAY: ":0" }, "xdotool"],
    ] as const) {
      expect(computerSupport({ platform: "linux", env, which: () => null })).toMatchObject({
        reason: expect.stringContaining(reason),
      });
    }
    expect(
      computerSupport({
        platform: "linux",
        env: { DISPLAY: ":0" },
        which: (n) => (n === "xdotool" ? n : null),
      }),
    ).toMatchObject({ reason: expect.stringContaining("scrot") });
    expect(computerSupport({ platform: "win32", env: {}, which: () => null })).toMatchObject({
      reason: expect.stringContaining("PowerShell"),
    });
  });
});
