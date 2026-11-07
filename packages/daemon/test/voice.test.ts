import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sttCommand, ttsCommand, Voice, WINDOWS_SPEECH_SCRIPT } from "../src/voice";

const only =
  (...found: string[]) =>
  (cmd: string) =>
    found.includes(cmd) ? `/bin/${cmd}` : null;

describe("ttsCommand", () => {
  test("macOS uses say with text on stdin", () => {
    expect(ttsCommand("darwin", only("say"), {}, null)).toEqual({
      bin: "/bin/say",
      args: [],
      input: "stdin",
    });
    expect(ttsCommand("darwin", only(), {}, null)).toBeNull();
  });

  test("Windows uses Windows PowerShell System.Speech with text on stdin", () => {
    const cmd = ttsCommand("win32", only("powershell"), {}, null);
    expect(cmd).toEqual({
      bin: "/bin/powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT],
      input: "stdin",
    });
    expect(WINDOWS_SPEECH_SCRIPT).toContain("System.Speech");
    expect(WINDOWS_SPEECH_SCRIPT).toContain("OpenStandardInput");
    expect(ttsCommand("win32", only("pwsh"), {}, null)).toBeNull();
  });

  test("Windows falls back to the SystemRoot PowerShell path", () => {
    const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const resolve = (cmd: string) => (cmd === exe ? exe : null);
    expect(ttsCommand("win32", resolve, { SystemRoot: "C:\\Windows" }, null)?.bin).toBe(exe);
    expect(ttsCommand("win32", resolve, {}, null)).toBeNull();
  });

  test("Linux prefers espeak-ng, then espeak, then spd-say", () => {
    expect(ttsCommand("linux", only("espeak-ng", "espeak", "spd-say"), {}, null)).toEqual({
      bin: "/bin/espeak-ng",
      args: ["--stdin"],
      input: "stdin",
    });
    expect(ttsCommand("linux", only("espeak", "spd-say"), {}, null)?.bin).toBe("/bin/espeak");
    expect(ttsCommand("linux", only("spd-say"), {}, null)).toEqual({
      bin: "/bin/spd-say",
      args: ["-w", "--"],
      input: "arg",
    });
    expect(ttsCommand("linux", only(), {}, null)).toBeNull();
    expect(ttsCommand("linux", only("say"), {}, null)).toBeNull();
  });

  test("BOTO_TTS_COMMAND wins on every platform and is not replaced when missing", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(
        ttsCommand(platform, only("say", "powershell", "espeak-ng", "mytts"), {}, ["mytts", "-x"]),
      ).toEqual({ bin: "/bin/mytts", args: ["-x"], input: "stdin" });
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

describe.skipIf(process.platform === "win32")("Voice with Linux defaults", () => {
  const dirs: string[] = [];
  const saved = { tts: process.env.BOTO_TTS_COMMAND, stt: process.env.BOTO_STT_COMMAND };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (saved.tts === undefined) delete process.env.BOTO_TTS_COMMAND;
    else process.env.BOTO_TTS_COMMAND = saved.tts;
    if (saved.stt === undefined) delete process.env.BOTO_STT_COMMAND;
    else process.env.BOTO_STT_COMMAND = saved.stt;
  });

  const setup = (bins: Record<string, string>) => {
    delete process.env.BOTO_TTS_COMMAND;
    delete process.env.BOTO_STT_COMMAND;
    const dir = mkdtempSync(join(tmpdir(), "boto-voice-"));
    dirs.push(dir);
    for (const [name, script] of Object.entries(bins)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    const path = `${dir}:/usr/bin:/bin`;
    return { dir, voice: new Voice(join(dir, "work"), () => path, "linux") };
  };

  const waitFor = async (file: string) => {
    for (let i = 0; i < 250 && !existsSync(file); i++) await Bun.sleep(20);
    return readFileSync(file, "utf8");
  };

  test("status is false when nothing is installed", () => {
    expect(setup({}).voice.status()).toEqual({ tts: false, stt: false });
  });

  test("espeak-ng reads the text from stdin", async () => {
    const { dir, voice } = setup({
      "espeak-ng": `printf '%s|' "$@" > "$0.args"; cat > "$0.tmp"; mv "$0.tmp" "$0.txt"`,
    });
    expect(voice.status()).toEqual({ tts: true, stt: false });
    await voice.speak("Olá; $(rm -rf /) `id`");
    expect(await waitFor(join(dir, "espeak-ng.txt"))).toBe("Olá; $(rm -rf /) `id`");
    expect(readFileSync(join(dir, "espeak-ng.args"), "utf8")).toBe("--stdin|");
  });

  test("spd-say gets the text as one argument after --", async () => {
    const { dir, voice } = setup({
      "spd-say": `printf '%s|' "$@" > "$0.tmp"; mv "$0.tmp" "$0.args"`,
    });
    expect(voice.status().tts).toBe(true);
    await voice.speak("-h linha 1\nlinha 2");
    expect(await waitFor(join(dir, "spd-say.args"))).toBe("-w|--|-h linha 1\nlinha 2|");
  });

  test("a missing BOTO_TTS_COMMAND binary is reported, not replaced by the default", async () => {
    const { voice } = setup({ "espeak-ng": "cat > /dev/null" });
    process.env.BOTO_TTS_COMMAND = JSON.stringify(["definitely-missing-boto-tts"]);
    expect(voice.status().tts).toBe(false);
    await expect(voice.speak("oi")).rejects.toThrow(
      "text-to-speech command not found: definitely-missing-boto-tts",
    );
  });

  test("whisper on PATH enables speech-to-text", () => {
    expect(setup({ whisper: "exit 0" }).voice.status()).toEqual({ tts: false, stt: true });
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
