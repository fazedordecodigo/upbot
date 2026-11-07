import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS_SPEECH_SCRIPT } from "../src/voice";
import {
  DaemonClient,
  type DaemonHandle,
  ROOT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

// The daemon runs with its built-in voice defaults (no BOTO_TTS_COMMAND) and a PATH that
// holds only fake programs: PATH is the fake bin dir, the login shell is a fake that prints
// that PATH, and HOME is empty, so synthesizers installed on the host are never picked.

// Daemon startup allows 15s, and fixture output polling allows another 10s.
setDefaultTimeout(30_000);

const TOKEN = `voice-e2e-${crypto.randomUUID()}`;
const FAKE_TTS = join(ROOT, "packages/daemon/test/fixtures/fake-tts.ts");
const FAKE_SPEECHD = join(ROOT, "packages/daemon/test/fixtures/fake-speechd.ts");
const win = process.platform === "win32";

type Setup = {
  daemon: DaemonHandle;
  client: DaemonClient;
  root: string;
  out: string;
  runtime: string;
};

const running: Setup[] = [];
const servers: string[] = [];

afterEach(async () => {
  for (const pidFile of servers.splice(0)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")));
    } catch {}
  }
  for (const s of running.splice(0)) {
    await stopDaemon(s.daemon, s.client);
    await removeDir(s.root);
  }
});

async function setup(
  bins: string[],
  env: Record<string, string> = {},
  before?: (s: Omit<Setup, "daemon" | "client">) => Promise<void>,
): Promise<Setup> {
  const root = tmp("boto-voice-e2e-");
  const bin = join(root, "bin");
  const out = join(root, "out");
  const home = join(root, "home");
  const runtime = join(root, "run");
  for (const dir of [bin, out, home, runtime]) mkdirSync(dir, { recursive: true });
  chmodSync(runtime, 0o700);
  for (const name of bins) {
    const [fixture, args] =
      name === "speech-dispatcher" ? [FAKE_SPEECHD, ""] : [FAKE_TTS, ` ${name}`];
    if (win) {
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${fixture}"${args} %*\r\n`);
    } else {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nexec "${process.execPath}" "${fixture}"${args} "$@"\n`,
      );
      chmodSync(join(bin, name), 0o755);
    }
  }
  const shell = join(root, "login-shell");
  writeFileSync(shell, `#!/bin/sh\nprintf '__OA_PATH__%s__OA_PATH__' "$PATH"\n`);
  chmodSync(shell, 0o755);
  await before?.({ root, out, runtime });
  const daemon = await startDaemon(join(root, "data"), join(root, "agents"), TOKEN, {
    PATH: bin,
    SHELL: shell,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_RUNTIME_DIR: runtime,
    XDG_CACHE_HOME: join(home, ".cache"),
    SPEECHD_ADDRESS: "",
    BOTO_TTS_COMMAND: "",
    BOTO_STT_COMMAND: "",
    FAKE_TTS_DIR: out,
    ...env,
  });
  const client = await DaemonClient.connect(daemon.port, TOKEN);
  const s = { daemon, client, root, out, runtime };
  running.push(s);
  return s;
}

async function waitFor(file: string, done: (text: string) => boolean = () => true) {
  for (let i = 0; i < 500; i++) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (done(text)) return text;
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

const recorded = async (s: Setup, name: string) =>
  JSON.parse(await waitFor(join(s.out, `${name}.json`))) as { args: string[]; input: string };

async function startSpeechd(out: string, runtime: string, env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [FAKE_SPEECHD, "--serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, XDG_RUNTIME_DIR: runtime, FAKE_TTS_DIR: out, ...env },
  });
  p.unref();
  servers.push(join(out, "speechd.pid"));
  const socket = join(runtime, "speech-dispatcher", "speechd.sock");
  for (let i = 0; i < 500 && !existsSync(socket); i++) await Bun.sleep(20);
}

const TEXT = "Olá; $(touch pwned) `id` -h\n.linha 2\r\n.";

describe.skipIf(process.platform !== "linux")("voice defaults on Linux (daemon RPC)", () => {
  test("nothing installed: voice.status is false and voice.speak fails", async () => {
    const s = await setup(["spd-say"]);
    expect(await s.client.request("voice.status", {})).toEqual({ tts: false, stt: false });
    await expect(s.client.request("voice.speak", { text: "oi" })).rejects.toThrow(
      "text-to-speech is not available",
    );
  });

  test("espeak-ng is found and gets the text on stdin", async () => {
    const s = await setup(["espeak-ng", "espeak", "spd-say", "whisper"]);
    expect(await s.client.request("voice.status", {})).toEqual({ tts: true, stt: true });
    await s.client.request("voice.speak", { text: TEXT });
    expect(await recorded(s, "espeak-ng")).toEqual({ args: ["--stdin"], input: TEXT });
    expect(existsSync(join(s.out, "espeak.json"))).toBe(false);
  });

  test("espeak is used when espeak-ng is missing", async () => {
    const s = await setup(["espeak"]);
    expect((await s.client.request("voice.status", {})).tts).toBe(true);
    await s.client.request("voice.speak", { text: TEXT });
    expect(await recorded(s, "espeak")).toEqual({ args: ["--stdin"], input: TEXT });
  });

  test("a running Speech Dispatcher gets the text over its socket, not in argv", async () => {
    const s = await setup(["spd-say"], {}, ({ out, runtime }) => startSpeechd(out, runtime));
    expect(await s.client.request("voice.status", {})).toEqual({ tts: true, stt: false });
    await s.client.request("voice.speak", { text: TEXT });
    const log = await waitFor(join(s.out, "ssip.log"), (t) => t.includes("QUIT\r\n"));
    expect(log).toBe(
      [
        "SET SELF CLIENT_NAME boto:boto:tts",
        "SET SELF PRIORITY text",
        "SET SELF NOTIFICATION end on",
        "SET SELF NOTIFICATION cancel on",
        "SPEAK",
        "Olá; $(touch pwned) `id` -h",
        "..linha 2",
        "..",
        ".",
        "QUIT",
        "",
      ].join("\r\n"),
    );
    expect(existsSync(join(s.out, "spd-say.json"))).toBe(false);
    expect(existsSync(join(s.out, "spawn.log"))).toBe(false);
  });

  test("Speech Dispatcher is started with --spawn when its socket is missing", async () => {
    const s = await setup(["speech-dispatcher"]);
    servers.push(join(s.out, "speechd.pid"));
    expect((await s.client.request("voice.status", {})).tts).toBe(true);
    await s.client.request("voice.speak", { text: "oi" });
    expect(await waitFor(join(s.out, "ssip.log"), (t) => t.includes("QUIT\r\n"))).toContain(
      "SPEAK\r\noi\r\n.\r\n",
    );
    expect(readFileSync(join(s.out, "spawn.log"), "utf8")).toBe('["--spawn"]\n');
  });

  test("a socket left by a crashed Speech Dispatcher is recovered with --spawn", async () => {
    const s = await setup(["speech-dispatcher"], {}, async ({ out, runtime }) => {
      await startSpeechd(out, runtime);
      const pid = Number(readFileSync(join(out, "speechd.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
      for (let i = 0; i < 250; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await Bun.sleep(20);
      }
      rmSync(join(out, "ssip.log"), { force: true });
    });
    expect(existsSync(join(s.runtime, "speech-dispatcher", "speechd.sock"))).toBe(true);
    expect((await s.client.request("voice.status", {})).tts).toBe(true);
    await s.client.request("voice.speak", { text: "oi" });
    expect(await waitFor(join(s.out, "ssip.log"), (t) => t.includes("QUIT\r\n"))).toContain(
      "SPEAK\r\noi\r\n.\r\n",
    );
    expect(readFileSync(join(s.out, "spawn.log"), "utf8")).toBe('["--spawn"]\n');
  });

  test("a new voice.speak cancels the message still being spoken", async () => {
    const s = await setup([], {}, ({ out, runtime }) =>
      startSpeechd(out, runtime, { FAKE_SPEECHD_END_MS: "never" }),
    );
    await s.client.request("voice.speak", { text: "primeira" });
    await s.client.request("voice.speak", { text: "segunda" });
    const log = await waitFor(join(s.out, "ssip.log"), (t) => t.includes("segunda\r\n.\r\n"));
    const first = log.indexOf("primeira");
    const cancel = log.indexOf("CANCEL SELF\r\n");
    expect(first).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(first);
    expect(log.indexOf("segunda")).toBeGreaterThan(cancel);
  });

  test("BOTO_TTS_COMMAND keeps priority over the defaults", async () => {
    const s = await setup(["espeak-ng", "mytts"], {
      BOTO_TTS_COMMAND: JSON.stringify(["mytts", "-x"]),
    });
    await s.client.request("voice.speak", { text: TEXT });
    expect(await recorded(s, "mytts")).toEqual({ args: ["-x"], input: TEXT });
    expect(existsSync(join(s.out, "espeak-ng.json"))).toBe(false);
  });

  test("a missing BOTO_TTS_COMMAND binary is reported, not replaced by the default", async () => {
    const s = await setup(["espeak-ng"], {
      BOTO_TTS_COMMAND: JSON.stringify(["definitely-missing-boto-tts"]),
    });
    expect((await s.client.request("voice.status", {})).tts).toBe(false);
    await expect(s.client.request("voice.speak", { text: "oi" })).rejects.toThrow(
      "text-to-speech command not found: definitely-missing-boto-tts",
    );
  });
});

describe.skipIf(process.platform !== "darwin")("voice defaults on macOS (daemon RPC)", () => {
  test("say is found and gets the text on stdin", async () => {
    const s = await setup(["say"]);
    expect((await s.client.request("voice.status", {})).tts).toBe(true);
    await s.client.request("voice.speak", { text: TEXT });
    expect(await recorded(s, "say")).toEqual({ args: [], input: TEXT });
  });

  test("without say, voice.status is false", async () => {
    const s = await setup([]);
    expect((await s.client.request("voice.status", {})).tts).toBe(false);
  });
});

describe.skipIf(!win)("voice defaults on Windows (daemon RPC)", () => {
  test("Windows PowerShell runs the fixed System.Speech script with the text on stdin", async () => {
    const s = await setup(["powershell", "pwsh"]);
    expect((await s.client.request("voice.status", {})).tts).toBe(true);
    await s.client.request("voice.speak", { text: TEXT });
    expect(await recorded(s, "powershell")).toEqual({
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT],
      input: TEXT,
    });
    expect(existsSync(join(s.out, "pwsh.json"))).toBe(false);
  });
});
