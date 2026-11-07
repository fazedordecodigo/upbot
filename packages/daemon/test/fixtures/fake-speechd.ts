// Fake Speech Dispatcher for tests. `bun fake-speechd.ts --spawn` (what Boto runs as
// `speech-dispatcher --spawn`) starts the server below in the background and waits for its
// socket (unless a server already answers there). `bun fake-speechd.ts --serve` listens on
// $XDG_RUNTIME_DIR/speech-dispatcher/speechd.sock, answers SSIP and appends every byte it
// receives to $FAKE_TTS_DIR/ssip.log. The pid goes to $FAKE_TTS_DIR/speechd.pid.
// FAKE_SPEECHD_END_MS (default 100) delays the END notification after a message is queued;
// "never" keeps the message speaking until it is cancelled.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const runtime = process.env.XDG_RUNTIME_DIR;
const logDir = process.env.FAKE_TTS_DIR;
if (!runtime || !logDir) process.exit(2);
const socket = join(runtime, "speech-dispatcher", "speechd.sock");
const mode = process.argv[2];

function listening(): Promise<boolean> {
  if (!existsSync(socket)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = createConnection({ path: socket });
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

if (mode === "--spawn") {
  appendFileSync(join(logDir, "spawn.log"), `${JSON.stringify(process.argv.slice(2))}\n`);
  if (!(await listening())) {
    spawn(process.execPath, [import.meta.path, "--serve"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }).unref();
    for (let i = 0; i < 250 && !(await listening()); i++) await Bun.sleep(20);
  }
  process.exit((await listening()) ? 0 : 1);
}

if (mode === "--serve") {
  mkdirSync(join(runtime, "speech-dispatcher"), { recursive: true });
  // Like speech-dispatcher, replace a socket file left behind by a server that died.
  rmSync(socket, { force: true });
  writeFileSync(join(logDir, "speechd.pid"), String(process.pid));
  const endMs = process.env.FAKE_SPEECHD_END_MS ?? "100";
  let messages = 0;
  type State = { buffer: string; data: boolean };
  Bun.listen<State>({
    unix: socket,
    socket: {
      open(s) {
        s.data = { buffer: "", data: false };
      },
      data(s, chunk) {
        const text = new TextDecoder().decode(chunk);
        appendFileSync(join(logDir, "ssip.log"), text);
        s.data.buffer += text;
        let index = s.data.buffer.indexOf("\r\n");
        while (index >= 0) {
          const line = s.data.buffer.slice(0, index);
          s.data.buffer = s.data.buffer.slice(index + 2);
          if (s.data.data) {
            if (line === ".") {
              s.data.data = false;
              const id = ++messages;
              s.write(`225-${id}\r\n225 OK MESSAGE QUEUED\r\n`);
              if (endMs !== "never")
                setTimeout(() => s.write(`702-${id}\r\n702-1\r\n702 END\r\n`), Number(endMs));
            }
          } else if (line === "SPEAK") {
            s.data.data = true;
            s.write("230 OK RECEIVING DATA\r\n");
          } else if (line === "QUIT") {
            s.write("231 HAPPY HACKING\r\n");
            s.end();
          } else if (line.startsWith("CANCEL")) {
            s.write("210 OK CANCELED\r\n");
          } else {
            s.write("200 OK\r\n");
          }
          index = s.data.buffer.indexOf("\r\n");
        }
      },
    },
  });
  setTimeout(() => process.exit(0), 60_000);
}
