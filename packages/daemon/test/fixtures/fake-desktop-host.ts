#!/usr/bin/env bun
// Fake `boto-host desktop` for tests: speaks the guest desktop NDJSON protocol without a
// microVM. First stdin line = {agentId}. Emits tiny JPEG-looking frames at the requested
// fps, a thumbnail every `thumbEveryMs`, refuses `input` unless the controller is the user
// and `agent` unless it is the agent, and answers agent actions with cursor + done.
// Every accepted input batch is appended to $FAKE_DESKTOP_LOG as JSON lines.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const FRAME = process.env.FAKE_DESKTOP_FRAME_FILE
  ? readFileSync(process.env.FAKE_DESKTOP_FRAME_FILE).toString("base64")
  : Buffer.from("/9j/fake-frame").toString("base64");
const send = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (entry: object) => {
  if (process.env.FAKE_DESKTOP_LOG)
    appendFileSync(process.env.FAKE_DESKTOP_LOG, `${JSON.stringify(entry)}\n`);
};

let agentId = "";
let controller: "agent" | "user" = "agent";
let seq = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let thumbTimer: ReturnType<typeof setInterval> | undefined;
let pointer = { x: 0, y: 0 };

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (raw) => {
  if (!raw.trim()) return;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return send({ type: "error", code: "bad_json" });
  }
  if (!agentId) {
    agentId = String(m.agentId ?? "");
    if (!agentId) {
      process.stderr.write("boto-host: invalid desktop spec\n");
      process.exit(1);
    }
    log({ agentId, event: "connected" });
    setTimeout(
      () => send({ type: "ready", width: 1280, height: 800, name: `fake-${agentId}` }),
      20,
    );
    return;
  }
  switch (m.type) {
    case "stream": {
      const fps = Number(m.fps ?? 0);
      if (timer) clearInterval(timer);
      if (thumbTimer) clearInterval(thumbTimer);
      timer = undefined;
      thumbTimer = undefined;
      log({ agentId, event: "stream", fps });
      if (fps > 0)
        timer = setInterval(() => {
          seq += 1;
          send({ type: "frame", seq, mime: "image/jpeg", data: FRAME, width: 1280, height: 800 });
        }, 1000 / fps);
      send({ type: "thumb", mime: "image/jpeg", data: FRAME, width: 256, height: 160 });
      thumbTimer = setInterval(
        () => send({ type: "thumb", mime: "image/jpeg", data: FRAME, width: 256, height: 160 }),
        Math.max(Number(m.thumbEveryMs ?? 5000), 200),
      );
      break;
    }
    case "controller":
      controller = m.controller === "user" ? "user" : "agent";
      log({ agentId, event: "controller", controller });
      break;
    case "input":
    case "agent": {
      const source = m.type === "input" ? "user" : "agent";
      const id = typeof m.id === "string" ? m.id : undefined;
      if (controller !== source) {
        log({ agentId, event: "refused", source });
        return send({ type: "error", id, code: "not_controller" });
      }
      const events = Array.isArray(m.events) ? m.events : [];
      for (const e of events as Record<string, unknown>[])
        if (typeof e.x === "number" && typeof e.y === "number") pointer = { x: e.x, y: e.y };
      log({ agentId, event: "input", source, events });
      if (source === "agent") {
        send({ type: "cursor", x: pointer.x, y: pointer.y, kind: "click" });
        send({ type: "done", id, text: `pointer at (${pointer.x}, ${pointer.y})` });
      }
      break;
    }
    case "screenshot": {
      const id = typeof m.id === "string" ? m.id : undefined;
      if (controller !== "agent") return send({ type: "error", id, code: "not_controller" });
      send({
        type: "done",
        id,
        text: "/workspace/computer/screen-1.png",
        width: 1280,
        height: 800,
      });
      break;
    }
    default:
      send({ type: "error", code: "unknown_message" });
  }
});
rl.on("close", () => {
  log({ agentId, event: "closed" });
  process.exit(0);
});
