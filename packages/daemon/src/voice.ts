import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { resolveCommandIn, spawnEnv } from "./env/login-path";
import { spawnChild } from "./env/spawn";
import { envOverride } from "./env/vars";

// Voice: text-to-speech with BOTO_TTS_COMMAND (text on stdin) or a built-in default
// (macOS `say`, Windows System.Speech via Windows PowerShell, Linux espeak-ng/espeak/spd-say)
// and speech-to-text with BOTO_STT_COMMAND (JSON array, "{file}" = recorded audio path,
// transcript on stdout) or the `whisper` CLI when it is on PATH.

export type TtsCommand = { bin: string; args: string[]; input: "stdin" | "arg" };

type Resolve = (cmd: string) => string | null;

// Fixed script: the text is read as UTF-8 bytes from stdin, never interpolated.
export const WINDOWS_SPEECH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$ms = New-Object System.IO.MemoryStream",
  "[Console]::OpenStandardInput().CopyTo($ms)",
  "$text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$s.SetOutputToDefaultAudioDevice()",
  "$s.Speak($text)",
].join("; ");

/** Picks the TTS command: BOTO_TTS_COMMAND first (even when its binary is missing, so a
 * broken override is reported instead of silently replaced), then the platform default. */
export function ttsCommand(
  platform: NodeJS.Platform,
  resolve: Resolve,
  env: NodeJS.ProcessEnv = process.env,
  override: string[] | null = envOverride("BOTO_TTS_COMMAND"),
): TtsCommand | null {
  if (override) {
    const bin = resolve(override[0]!);
    return bin ? { bin, args: override.slice(1), input: "stdin" } : null;
  }
  if (platform === "darwin") {
    const bin = resolve("say");
    return bin ? { bin, args: [], input: "stdin" } : null;
  }
  if (platform === "win32") {
    // Windows PowerShell 5.1 (.NET Framework) ships System.Speech; pwsh (PowerShell 7) does not.
    const root = Object.entries(env).find(([k]) => k.toLowerCase() === "systemroot")?.[1];
    const bin =
      resolve("powershell") ??
      (root
        ? resolve(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        : null);
    return bin
      ? {
          bin,
          args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT],
          input: "stdin",
        }
      : null;
  }
  for (const name of ["espeak-ng", "espeak"]) {
    const bin = resolve(name);
    if (bin) return { bin, args: ["--stdin"], input: "stdin" };
  }
  // spd-say has no whole-text stdin mode (pipe mode speaks line by line), so the text is
  // passed as a single argv entry after "--" (no shell is involved).
  const spd = resolve("spd-say");
  return spd ? { bin: spd, args: ["-w", "--"], input: "arg" } : null;
}

/** Picks the STT command: BOTO_STT_COMMAND first, then `whisper` on PATH. */
export function sttCommand(
  resolve: Resolve,
  override: string[] | null = envOverride("BOTO_STT_COMMAND"),
): { bin: string; args: string[]; custom: boolean } | null {
  if (override) {
    const bin = resolve(override[0]!);
    return bin ? { bin, args: override.slice(1), custom: true } : null;
  }
  const whisper = resolve("whisper");
  return whisper ? { bin: whisper, args: [], custom: false } : null;
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

export class Voice {
  private speaking: ChildProcess | null = null;

  constructor(
    private dir: string,
    private pathEnv: () => string,
    private platform: NodeJS.Platform = process.platform,
  ) {}

  private resolve = (cmd: string): string | null =>
    resolveCommandIn(cmd, this.pathEnv().split(this.platform === "win32" ? ";" : delimiter), {
      platform: this.platform,
      ...(process.env.PATHEXT ? { pathext: process.env.PATHEXT } : {}),
    });

  status() {
    return {
      tts: ttsCommand(this.platform, this.resolve) !== null,
      stt: sttCommand(this.resolve) !== null,
    };
  }

  async speak(text: string): Promise<void> {
    const override = envOverride("BOTO_TTS_COMMAND");
    const cmd = ttsCommand(this.platform, this.resolve, process.env, override);
    if (!cmd) {
      if (override) throw new Error(`text-to-speech command not found: ${override[0]}`);
      throw new Error("text-to-speech is not available");
    }
    this.stop();
    const input = text.slice(0, 20_000);
    const p = spawnChild(cmd.bin, cmd.input === "arg" ? [...cmd.args, input] : cmd.args, {
      stdio: [cmd.input === "stdin" ? "pipe" : "ignore", "ignore", "ignore"],
      env: spawnEnv(undefined, this.platform, this.pathEnv()),
    });
    this.speaking = p;
    p.stdin?.on("error", () => {});
    p.on("error", () => {
      if (this.speaking === p) this.speaking = null;
    });
    p.once("close", () => {
      if (this.speaking === p) this.speaking = null;
    });
    const spawned = new Promise<void>((resolve, reject) => {
      p.once("spawn", resolve);
      p.once("error", reject);
    });
    p.stdin?.end(input);
    await spawned;
  }

  stop(): void {
    this.speaking?.kill();
    this.speaking = null;
  }

  async transcribe(audioBase64: string, mime: string): Promise<string> {
    const id = crypto.randomUUID();
    const work = join(this.dir, id);
    mkdirSync(work, { recursive: true });
    const file = join(work, `audio.${EXT[mime.split(";")[0]!.trim()] ?? "webm"}`);
    writeFileSync(file, Buffer.from(audioBase64, "base64"));
    try {
      const override = envOverride("BOTO_STT_COMMAND");
      const cmd = sttCommand(this.resolve, override);
      if (!cmd) {
        if (override) throw new Error(`speech-to-text command not found: ${override[0]}`);
        throw new Error(
          "speech-to-text is not available (install whisper or set BOTO_STT_COMMAND)",
        );
      }
      const custom = cmd.custom;
      const args = custom
        ? cmd.args.map((a) => a.replaceAll("{file}", file))
        : [file, "--model", "base", "--output_format", "txt", "--output_dir", work];
      const p = spawnChild(cmd.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(undefined, this.platform, this.pathEnv()),
      });
      const timer = setTimeout(() => p.kill(), 120_000);
      try {
        const [out, err, code] = await Promise.all([
          new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            p.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
            p.stdout?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            if (!p.stdout) resolve("");
          }),
          new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            p.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
            p.stderr?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            if (!p.stderr) resolve("");
          }),
          new Promise<number>((resolve, reject) => {
            p.once("error", reject);
            p.once("close", (exitCode) => resolve(exitCode ?? 1));
          }),
        ]);
        if (code !== 0) throw new Error(`transcription failed: ${err.trim().slice(0, 300)}`);
        if (custom) return out.trim();
        return (await Bun.file(join(work, "audio.txt")).text()).trim();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
