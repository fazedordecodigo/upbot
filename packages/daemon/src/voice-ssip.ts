import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// Minimal SSIP client for Speech Dispatcher (the service behind spd-say). The text goes over
// the user's unix socket, never into a process argument list (visible to other local users)
// and never through spd-say's pipe mode (999-byte lines, `!-!` lines run as SSIP commands).

export type SsipAddress = { socket: string; custom: boolean };

/** Socket from SPEECHD_ADDRESS (`unix_socket[:path]`) or libspeechd's default path;
 * null for addresses this client does not speak (e.g. `inet_socket`). */
export function ssipAddress(env: NodeJS.ProcessEnv): SsipAddress | null {
  const runtime =
    env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  const fallback = join(runtime, "speech-dispatcher", "speechd.sock");
  const raw = env.SPEECHD_ADDRESS?.trim();
  if (!raw) return { socket: fallback, custom: false };
  if (raw === "unix_socket") return { socket: fallback, custom: false };
  if (raw.startsWith("unix_socket:")) {
    const path = raw.slice("unix_socket:".length);
    return path ? { socket: path, custom: true } : { socket: fallback, custom: false };
  }
  return null;
}

/** SSIP message body: CRLF lines, a leading "." doubled, terminated by a lone ".". */
export function ssipEscape(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${lines.join("\r\n")}\r\n.\r\n`;
}

export class SsipError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SsipError";
  }
}

const REPLY = /^(\d{3})([ -])/;
const END = "702";
const CANCELED = "703";

class Connection {
  private buffer = "";
  private waiters: { resolve: (code: string) => void; reject: (e: Error) => void }[] = [];
  private closed = false;
  onEvent: (code: string) => void = () => {};

  constructor(private socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }

  private read(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 65_536) return this.close();
    let index = this.buffer.indexOf("\r\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const match = REPLY.exec(line);
      if (match && match[2] === " ") {
        const code = match[1] as string;
        if (code.startsWith("7")) this.onEvent(code);
        else this.waiters.shift()?.resolve(code);
      }
      index = this.buffer.indexOf("\r\n");
    }
  }

  send(data: string): Promise<string> {
    if (this.closed)
      return Promise.reject(new SsipError("speech-dispatcher closed the connection"));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.socket.write(data);
    });
  }

  write(data: string) {
    if (!this.closed) this.socket.write(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new SsipError("speech-dispatcher closed the connection"));
    this.socket.destroy();
    this.onEvent(CANCELED);
  }
}

export function ssipConnect(socket: string, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ path: socket });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new SsipError("speech-dispatcher did not answer", "ETIMEDOUT"));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new SsipError("speech-dispatcher is not running", error.code));
    });
  });
}

export type SsipSpeech = { stop(): void; done: Promise<void> };

/** Queues `text` on an open SSIP socket. Resolves once the message is queued; the connection
 * stays open until Speech Dispatcher reports the end (or cancel) so `stop()` can cancel it. */
export async function ssipSpeak(
  socket: Socket,
  text: string,
  opts: { timeoutMs?: number; maxSpeechMs?: number } = {},
): Promise<SsipSpeech> {
  const conn = new Connection(socket);
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const quit = () => {
    conn.write("QUIT\r\n");
    socket.end();
    setTimeout(() => conn.close(), 1000).unref?.();
  };
  conn.onEvent = (code) => {
    if (code === END || code === CANCELED) {
      quit();
      finish();
    }
  };
  const setup = setTimeout(() => conn.close(), opts.timeoutMs ?? 5000);
  const expect = async (data: string, ok: (code: string) => boolean) => {
    const code = await conn.send(data);
    if (!ok(code)) throw new SsipError("speech-dispatcher rejected the request", code);
  };
  try {
    const success = (code: string) => code.startsWith("2");
    await expect("SET SELF CLIENT_NAME boto:boto:tts\r\n", success);
    await expect("SET SELF PRIORITY text\r\n", success);
    await expect("SET SELF NOTIFICATION end on\r\n", success);
    await expect("SET SELF NOTIFICATION cancel on\r\n", success);
    await expect("SPEAK\r\n", (code) => code === "230");
    await expect(ssipEscape(text), (code) => code === "225");
  } catch (error) {
    conn.close();
    throw error;
  } finally {
    clearTimeout(setup);
  }
  const cap = setTimeout(quit, opts.maxSpeechMs ?? 15 * 60_000);
  cap.unref?.();
  void done.then(() => clearTimeout(cap));
  return {
    done,
    stop() {
      conn.write("CANCEL SELF\r\n");
      quit();
      finish();
    },
  };
}
