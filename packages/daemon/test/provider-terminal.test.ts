import { expect, test } from "bun:test";
import { loginTerminalCommand } from "../src/providers/terminal";

test("login opens a terminal rather than hiding the provider's method selector", () => {
  const command = ["gemini", "argument with spaces", "a'b;$HOME"];
  expect(
    loginTerminalCommand(command, "linux", (name) => (name === "xterm" ? "/bin/xterm" : null)),
  ).toEqual(["/bin/xterm", "-e", ...command]);
  const mac = loginTerminalCommand(command, "darwin", () => "/usr/bin/osascript");
  expect(mac[2]).toContain('tell application "Terminal"');
  expect(mac[2]).toContain("do script");
  const win = loginTerminalCommand(command, "win32", () => "powershell.exe");
  const encoded = win.at(-1)!.match(/'-EncodedCommand','([^']+)'/)![1]!;
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
    "& 'gemini' 'argument with spaces' 'a''b;$HOME'",
  );
  expect(() => loginTerminalCommand([], "linux", () => "xterm")).toThrow("empty login command");
  expect(() => loginTerminalCommand(["gemini"], "linux", () => null)).toThrow(
    "terminal unavailable",
  );
});
