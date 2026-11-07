import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { resolveCommandIn, spawnEnv } from "./env/login-path";
import { spawnChild } from "./env/spawn";
import { envOverride } from "./env/vars";
import { type SsipSpeech, ssipAddress, ssipConnect, ssipSpeak } from "./voice-ssip";

// Voice: text-to-speech with BOTO_TTS_COMMAND (text on stdin) or a built-in default
// (macOS `say`, Windows System.Speech via Windows PowerShell, Linux espeak-ng/espeak or
// Speech Dispatcher over its SSIP socket) and speech-to-text with BOTO_STT_COMMAND (JSON
// array, "{file}" = recorded audio path, transcript on stdout) or the `whisper` CLI on PATH.
// The text never goes into a process argument list, where other local users could read it.

export type TtsCommand =
  | { kind: "stdin"; bin: string; args: string[] }
  /** Speech Dispatcher; `spawn` starts it (as spd-say would) when the socket is missing. */
  | { kind: "ssip"; socket: string; spawn: string | null };

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
  exists: (path: string) => boolean = existsSync,
): TtsCommand | null {
  const stdin = (bin: string | null, args: string[] = []): TtsCommand | null =>
    bin ? { kind: "stdin", bin, args } : null;
  if (override) {
    const [cmd = "", ...args] = override;
    return stdin(resolve(cmd), args);
  }
  if (platform === "darwin") return stdin(resolve("say"));
  if (platform === "win32") {
    // Windows PowerShell 5.1 (.NET Framework) ships System.Speech; pwsh (PowerShell 7) does not.
    const root = Object.entries(env).find(([k]) => k.toLowerCase() === "systemroot")?.[1];
    const bin =
      resolve("powershell") ??
      (root
        ? resolve(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        : null);
    return stdin(bin, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT]);
  }
  for (const name of ["espeak-ng", "espeak"]) {
    const bin = resolve(name);
    if (bin) return stdin(bin, ["--stdin"]);
  }
  // spd-say would need the text in argv (or line-by-line stdin, where `!-!` lines are SSIP
  // commands), so Boto talks to Speech Dispatcher's socket itself.
  const address = ssipAddress(env);
  if (!address) return null;
  // The socket file can outlive a crashed server, so keep `spawn` to restart it on a failed
  // connect. Custom addresses are never autospawned (libspeechd does the same).
  const spawn = address.custom ? null : resolve("speech-dispatcher");
  return spawn || exists(address.socket) ? { kind: "ssip", socket: address.socket, spawn } : null;
}

/** Picks the STT command: BOTO_STT_COMMAND first, then `whisper` on PATH. */
export function sttCommand(
  resolve: Resolve,
  override: string[] | null = envOverride("BOTO_STT_COMMAND"),
): { bin: string; args: string[]; custom: boolean } | null {
  if (override) {
    const [cmd = "", ...args] = override;
    const bin = resolve(cmd);
    return bin ? { bin, args, custom: true } : null;
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
  private speaking: { stop(): void } | null = null;

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
    if (cmd.kind === "ssip") return this.speakSsip(cmd.socket, cmd.spawn, input);
    const p = spawnChild(cmd.bin, cmd.args, {
      stdio: ["pipe", "ignore", "ignore"],
      env: spawnEnv(undefined, this.platform, this.pathEnv()),
    });
    const handle = { stop: () => p.kill() };
    this.speaking = handle;
    const done = () => {
      if (this.speaking === handle) this.speaking = null;
    };
    p.stdin?.on("error", () => {});
    p.on("error", done);
    p.once("close", done);
    const spawned = new Promise<void>((resolve, reject) => {
      p.once("spawn", resolve);
      p.once("error", reject);
    });
    p.stdin?.end(input);
    await spawned;
  }

  private async speakSsip(socket: string, spawn: string | null, text: string): Promise<void> {
    const pending = { stop: () => {} };
    let stopped = false;
    pending.stop = () => {
      stopped = true;
    };
    this.speaking = pending;
    const connection = await ssipConnect(socket).catch(async (error) => {
      if (!spawn) throw error;
      await this.spawnSpeechDispatcher(spawn);
      return ssipConnect(socket);
    });
    if (stopped || this.speaking !== pending) {
      connection.destroy();
      return;
    }
    const speech: SsipSpeech = await ssipSpeak(connection, text);
    if (stopped || this.speaking !== pending) return speech.stop();
    const handle = { stop: () => speech.stop() };
    this.speaking = handle;
    void speech.done.then(() => {
      if (this.speaking === handle) this.speaking = null;
    });
  }

  /** `speech-dispatcher --spawn` (what libspeechd runs): starts the user's server unless one
   * is already running, then exits. */
  private spawnSpeechDispatcher(bin: string): Promise<void> {
    return new Promise((resolve) => {
      const p = spawnChild(bin, ["--spawn"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: spawnEnv(undefined, this.platform, this.pathEnv()),
      });
      const timer = setTimeout(() => p.kill(), 10_000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      p.once("error", done);
      p.once("close", done);
    });
  }

  stop(): void {
    this.speaking?.stop();
    this.speaking = null;
  }

  async transcribe(audioBase64: string, mime: string): Promise<string> {
    const id = crypto.randomUUID();
    const work = join(this.dir, id);
    mkdirSync(work, { recursive: true });
    const file = join(work, `audio.${EXT[(mime.split(";")[0] ?? "").trim()] ?? "webm"}`);
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
