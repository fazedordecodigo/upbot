import { resolveCommand } from "../env/login-path";

const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function loginTerminalCommand(
  command: string[],
  platform: string = process.platform,
  lookup: (command: string) => string | null = resolveCommand,
): string[] {
  if (!command[0]) throw new Error("empty login command");
  if (platform === "darwin") {
    const terminal = lookup("osascript");
    if (!terminal) throw new Error("terminal unavailable");
    return [
      terminal,
      "-e",
      `tell application "Terminal"
activate
set loginTab to do script ${JSON.stringify(command.map(shQuote).join(" "))}
delay 0.5
repeat while busy of loginTab
delay 0.2
end repeat
end tell`,
    ];
  }
  if (platform === "win32") {
    const terminal = lookup("powershell.exe");
    if (!terminal) throw new Error("terminal unavailable");
    const encoded = Buffer.from(`& ${command.map(psQuote).join(" ")}`, "utf16le").toString(
      "base64",
    );
    return [
      terminal,
      "-NoProfile",
      "-Command",
      `Start-Process -Wait -FilePath ${psQuote(terminal)} -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
    ];
  }
  for (const [name, ...args] of [
    ["x-terminal-emulator", "-e"],
    ["gnome-terminal", "--wait", "--"],
    ["konsole", "--nofork", "-e"],
    ["xterm", "-e"],
    ["kitty", "--"],
    ["alacritty", "-e"],
  ]) {
    const terminal = lookup(name!);
    if (terminal) return [terminal, ...args, ...command];
  }
  throw new Error("terminal unavailable");
}
