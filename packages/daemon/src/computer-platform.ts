type ScreenshotTool = "import" | "scrot" | "gnome-screenshot";
export type ComputerBackend =
  | { platform: "darwin" }
  | { platform: "win32"; powershell: string }
  | { platform: "linux"; xdotool: string; screenshot: string; screenshotTool: ScreenshotTool };
export type ComputerSupport = { backend: ComputerBackend } | { reason: string };
export type ComputerEnvironment = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  which?: (command: string) => string | null;
};

export function computerSupport({
  platform = process.platform,
  env = process.env,
  which = Bun.which,
}: ComputerEnvironment = {}): ComputerSupport {
  const dry = !!env.BOTO_COMPUTER_DRYRUN;
  if (platform === "darwin") return { backend: { platform } };
  if (platform === "win32") {
    const powershell = dry ? "powershell.exe" : which("powershell.exe");
    return powershell
      ? { backend: { platform, powershell } }
      : { reason: "Computer Use requer o Windows PowerShell (powershell.exe)." };
  }
  if (platform === "linux") {
    if (!dry && (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE?.toLowerCase() === "wayland"))
      return { reason: "Computer Use não suporta Wayland. Entre em uma sessão X11." };
    if (!dry && !env.DISPLAY)
      return { reason: "Computer Use requer uma sessão X11 com DISPLAY definido." };
    const xdotool = dry ? "xdotool" : which("xdotool");
    if (!xdotool) return { reason: "Computer Use requer xdotool instalado no Linux X11." };
    for (const screenshotTool of ["import", "scrot", "gnome-screenshot"] as const) {
      const screenshot = dry ? screenshotTool : which(screenshotTool);
      if (screenshot) return { backend: { platform, xdotool, screenshot, screenshotTool } };
    }
    return {
      reason: "Computer Use requer import (ImageMagick), scrot ou gnome-screenshot no Linux X11.",
    };
  }
  if (dry) return { backend: { platform: "darwin" } };
  return { reason: "Computer Use suporta macOS, Windows e Linux X11." };
}

const CLICK_JXA = `ObjC.import("CoreGraphics");
function run(argv) {
  const p = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const n = Number(argv[2]);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, 0));
  for (let i = 1; i <= n; i++) {
    for (const t of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
      const e = $.CGEventCreateMouseEvent(null, t, p, 0);
      $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, i);
      $.CGEventPost($.kCGHIDEventTap, e);
    }
  }
}`;
const TYPE_AS = `on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run`;

// INPUT's union includes MOUSEINPUT so its native size/alignment is correct on x64 and x86.
const WINDOWS_INPUT = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BotoInput {
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard {
    public ushort vk, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse {
    public int x, y; public uint data, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct Data {
    [FieldOffset(0)] public Keyboard keyboard;
    [FieldOffset(0)] public Mouse mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Data data; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  static Input Event(ushort vk, ushort scan, uint flags) {
    return new Input { type = 1, data = new Data { keyboard = new Keyboard { vk = vk, scan = scan, flags = flags } } };
  }
  static void Send(Input[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
      throw new InvalidOperationException("INPUT_BLOCKED");
  }
  public static void Type(string text) {
    var events = new List<Input>();
    foreach (char c in text.Replace("\r\n", "\n").Replace('\r', '\n')) {
      ushort vk = c == '\n' ? (ushort)13 : c == '\t' ? (ushort)9 : (ushort)0;
      ushort scan = vk == 0 ? c : (ushort)0;
      uint flags = vk == 0 ? 4u : 0u;
      events.Add(Event(vk, scan, flags)); events.Add(Event(vk, scan, flags | 2u));
    }
    Send(events.ToArray());
  }
  public static void Key(ushort key, uint flags, ushort[] modifiers) {
    int held = 0;
    try {
      foreach (ushort mod in modifiers) { Send(new[] { Event(mod, 0, mod == 91 ? 1u : 0u) }); held++; }
      Send(new[] { Event(key, 0, flags), Event(key, 0, flags | 2u) });
    } finally {
      for (int i = held - 1; i >= 0; i--) Send(new[] { Event(modifiers[i], 0, modifiers[i] == 91 ? 3u : 2u) });
    }
  }
}
'@`;

function powershell(backend: Extract<ComputerBackend, { platform: "win32" }>, script: string) {
  return [
    backend.powershell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64"),
  ];
}

function psString(text: string) {
  return `'${text.replaceAll("'", "''")}'`;
}

export function screenshotCommand(backend: ComputerBackend, file: string): string[] {
  switch (backend.platform) {
    case "darwin":
      return ["screencapture", "-x", "-t", "png", file];
    case "win32":
      return powershell(
        backend,
        `${WINDOWS_INPUT}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[void][BotoInput]::SetProcessDPIAware()
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size) }
  finally { $graphics.Dispose() }
  $bitmap.Save(${psString(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }`,
      );
    case "linux":
      switch (backend.screenshotTool) {
        case "import":
          return [backend.screenshot, "-window", "root", file];
        case "scrot":
          return [backend.screenshot, file];
        case "gnome-screenshot":
          return [backend.screenshot, "-f", file];
      }
  }
}

export function clickCommand(backend: ComputerBackend, x: number, y: number, double: boolean) {
  const count = double ? "2" : "1";
  switch (backend.platform) {
    case "darwin":
      return ["osascript", "-l", "JavaScript", "-e", CLICK_JXA, String(x), String(y), count];
    case "win32":
      return powershell(
        backend,
        `${WINDOWS_INPUT}
[void][BotoInput]::SetProcessDPIAware()
if (-not [BotoInput]::SetCursorPos(${x}, ${y})) { throw 'CURSOR_UNAVAILABLE' }
for ($i = 0; $i -lt ${count}; $i++) {
  [BotoInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [BotoInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  if ($i -eq 0 -and ${count} -eq 2) { Start-Sleep -Milliseconds 100 }
}`,
      );
    case "linux":
      return [
        backend.xdotool,
        "mousemove",
        String(x),
        String(y),
        "click",
        "--repeat",
        count,
        "--delay",
        "100",
        "1",
      ];
  }
}

export function typeCommand(backend: ComputerBackend, text: string) {
  switch (backend.platform) {
    case "darwin":
      return ["osascript", "-e", TYPE_AS, text];
    case "win32":
      return powershell(backend, `${WINDOWS_INPUT}\n[BotoInput]::Type($env:BOTO_COMPUTER_TEXT)`);
    case "linux":
      return [backend.xdotool, "type", "--clearmodifiers", "--delay", "0", "--", text];
  }
}

const KEYS: Record<string, [number, string, number, number?]> = {
  return: [36, "Return", 13],
  enter: [76, "KP_Enter", 13, 1],
  tab: [48, "Tab", 9],
  space: [49, "space", 32],
  delete: [51, "BackSpace", 8],
  escape: [53, "Escape", 27],
  left: [123, "Left", 37, 1],
  right: [124, "Right", 39, 1],
  down: [125, "Down", 40, 1],
  up: [126, "Up", 38, 1],
  home: [115, "Home", 36, 1],
  end: [119, "End", 35, 1],
  pageup: [116, "Prior", 33, 1],
  pagedown: [121, "Next", 34, 1],
};
const MODIFIERS: Record<string, [string, number]> = {
  command: ["super", 91],
  control: ["ctrl", 17],
  option: ["alt", 18],
  shift: ["shift", 16],
};

export function keyCommand(backend: ComputerBackend, key: string, modifiers: unknown) {
  const lower = key.toLowerCase();
  const code = Object.hasOwn(KEYS, lower) ? KEYS[lower] : undefined;
  const single = /^[a-z0-9]$/.test(lower) ? lower : null;
  if (!code && !single)
    throw new Error(`unsupported key; use a letter/digit or ${Object.keys(KEYS).join(", ")}`);
  const mods = [...new Set((Array.isArray(modifiers) ? modifiers : []).map(String))];
  if (mods.some((mod) => !Object.hasOwn(MODIFIERS, mod)))
    throw new Error("modifiers: command, control, option, shift");
  switch (backend.platform) {
    case "darwin": {
      const using = mods.length ? ` using {${mods.map((mod) => `${mod} down`).join(", ")}}` : "";
      const action = code ? `key code ${code[0]}` : `keystroke "${single}"`;
      return ["osascript", "-e", `tell application "System Events" to ${action}${using}`];
    }
    case "win32":
      return powershell(
        backend,
        `${WINDOWS_INPUT}\n[BotoInput]::Key(${code ? code[2] : lower.toUpperCase().charCodeAt(0)}, ${code?.[3] ?? 0}, [ushort[]]@(${mods.map((mod) => (MODIFIERS[mod] as [string, number])[1]).join(",")}))`,
      );
    case "linux":
      return [
        backend.xdotool,
        "key",
        "--clearmodifiers",
        [
          ...mods.map((mod) => (MODIFIERS[mod] as [string, number])[0]),
          code ? code[1] : single,
        ].join("+"),
      ];
  }
}
