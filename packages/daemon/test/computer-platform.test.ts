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
      "::Key(37, 1, [ushort[]]@(91,16))",
    );
  });
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
