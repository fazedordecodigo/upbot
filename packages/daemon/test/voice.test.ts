import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { sttCommand, ttsCommand, WINDOWS_SPEECH_SCRIPT } from "../src/voice";
import { ssipAddress, ssipEscape } from "../src/voice-ssip";

const only =
  (...found: string[]) =>
  (cmd: string) =>
    found.includes(cmd) ? `/bin/${cmd}` : null;

const none = () => false;
const all = () => true;

describe("ttsCommand", () => {
  test("macOS uses say with text on stdin", () => {
    expect(ttsCommand("darwin", only("say"), {}, null)).toEqual({
      kind: "stdin",
      bin: "/bin/say",
      args: [],
    });
    expect(ttsCommand("darwin", only(), {}, null)).toBeNull();
  });

  test("Windows uses Windows PowerShell System.Speech with text on stdin", () => {
    const cmd = ttsCommand("win32", only("powershell"), {}, null);
    expect(cmd).toEqual({
      kind: "stdin",
      bin: "/bin/powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT],
    });
    expect(WINDOWS_SPEECH_SCRIPT).toContain("System.Speech");
    expect(WINDOWS_SPEECH_SCRIPT).toContain("OpenStandardInput");
    expect(ttsCommand("win32", only("pwsh"), {}, null)).toBeNull();
  });

  test("Windows falls back to the SystemRoot PowerShell path", () => {
    const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const resolve = (cmd: string) => (cmd === exe ? exe : null);
    expect(ttsCommand("win32", resolve, { SystemRoot: "C:\\Windows" }, null)).toMatchObject({
      bin: exe,
    });
    expect(ttsCommand("win32", resolve, {}, null)).toBeNull();
  });

  test("Linux prefers espeak-ng, then espeak, then Speech Dispatcher", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    const socket = "/run/user/1000/speech-dispatcher/speechd.sock";
    const all = only("espeak-ng", "espeak", "spd-say", "speech-dispatcher");
    expect(ttsCommand("linux", all, env, null, none)).toEqual({
      kind: "stdin",
      bin: "/bin/espeak-ng",
      args: ["--stdin"],
    });
    expect(ttsCommand("linux", only("espeak", "spd-say"), env, null, none)).toEqual({
      kind: "stdin",
      bin: "/bin/espeak",
      args: ["--stdin"],
    });
    expect(ttsCommand("linux", only("spd-say"), env, null, (p) => p === socket)).toEqual({
      kind: "ssip",
      socket,
      spawn: null,
    });
    expect(ttsCommand("linux", only("speech-dispatcher"), env, null, none)).toEqual({
      kind: "ssip",
      socket,
      spawn: "/bin/speech-dispatcher",
    });
    // spd-say alone is never run: it would carry the text in argv.
    expect(ttsCommand("linux", only("spd-say"), env, null, none)).toBeNull();
    expect(ttsCommand("linux", only(), env, null, none)).toBeNull();
    expect(ttsCommand("linux", only("say"), env, null, none)).toBeNull();
  });

  test("a custom SPEECHD_ADDRESS socket is used but never autospawned", () => {
    const env = { SPEECHD_ADDRESS: "unix_socket:/tmp/sd.sock" };
    const sd = only("speech-dispatcher");
    expect(ttsCommand("linux", sd, env, null, (p) => p === "/tmp/sd.sock")).toEqual({
      kind: "ssip",
      socket: "/tmp/sd.sock",
      spawn: null,
    });
    expect(ttsCommand("linux", sd, env, null, none)).toBeNull();
    expect(
      ttsCommand("linux", sd, { SPEECHD_ADDRESS: "inet_socket:localhost:6560" }, null, all),
    ).toBeNull();
  });

  test("BOTO_TTS_COMMAND wins on every platform and is not replaced when missing", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(
        ttsCommand(platform, only("say", "powershell", "espeak-ng", "mytts"), {}, ["mytts", "-x"]),
      ).toEqual({ kind: "stdin", bin: "/bin/mytts", args: ["-x"] });
      expect(
        ttsCommand(platform, only("say", "powershell", "espeak-ng"), {}, ["mytts"]),
      ).toBeNull();
    }
  });
});

describe("sttCommand", () => {
  test("BOTO_STT_COMMAND wins over whisper; a missing override is unavailable", () => {
    expect(sttCommand(only("whisper", "stt"), ["stt", "{file}"])).toEqual({
      bin: "/bin/stt",
      args: ["{file}"],
      custom: true,
    });
    expect(sttCommand(only("whisper"), ["stt"])).toBeNull();
    expect(sttCommand(only("whisper"), null)).toEqual({
      bin: "/bin/whisper",
      args: [],
      custom: false,
    });
    expect(sttCommand(only(), null)).toBeNull();
  });
});

describe("SSIP", () => {
  test("ssipAddress follows libspeechd's default socket and SPEECHD_ADDRESS", () => {
    expect(ssipAddress({ XDG_RUNTIME_DIR: "/run/user/7" })).toEqual({
      socket: "/run/user/7/speech-dispatcher/speechd.sock",
      custom: false,
    });
    expect(ssipAddress({ XDG_CACHE_HOME: "/c" })?.socket).toBe("/c/speech-dispatcher/speechd.sock");
    expect(ssipAddress({ HOME: "/h" })?.socket).toBe("/h/.cache/speech-dispatcher/speechd.sock");
    expect(ssipAddress({ HOME: "/h", SPEECHD_ADDRESS: "unix_socket" })?.custom).toBe(false);
    expect(ssipAddress({ SPEECHD_ADDRESS: "unix_socket:/s" })).toEqual({
      socket: "/s",
      custom: true,
    });
    expect(ssipAddress({ SPEECHD_ADDRESS: "inet_socket:127.0.0.1:6560" })).toBeNull();
  });

  test("ssipEscape uses CRLF, doubles leading dots and ends with a lone dot", () => {
    expect(ssipEscape("oi")).toBe("oi\r\n.\r\n");
    expect(ssipEscape(".\n..a\r\nb.\rc\n")).toBe("..\r\n...a\r\nb.\r\nc\r\n\r\n.\r\n");
    expect(ssipEscape("!-!QUIT\nSPEAK")).toBe("!-!QUIT\r\nSPEAK\r\n.\r\n");
  });
});

describe.skipIf(process.platform !== "win32")("Windows PowerShell speech script", () => {
  const run = (script: string, input: string) =>
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: Buffer.from(input, "utf8"),
      windowsHide: true,
      timeout: 60_000,
    });

  test("reads UTF-8 text from stdin without evaluating it", () => {
    const text = "Olá, ação! $(Write-Output pwned); `whoami` 'x' \"y\"";
    const script = WINDOWS_SPEECH_SCRIPT.replace(
      /; \$s = New-Object.*$/,
      "; [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)))",
    );
    const r = run(script, text);
    expect(r.status).toBe(0);
    expect(Buffer.from(r.stdout.toString().trim(), "base64").toString("utf8")).toBe(text);
  });

  test("System.Speech loads and synthesizes", () => {
    const r = run(
      WINDOWS_SPEECH_SCRIPT.replace("SetOutputToDefaultAudioDevice()", "SetOutputToNull()"),
      "Olá",
    );
    expect(r.status).toBe(0);
  });
});
