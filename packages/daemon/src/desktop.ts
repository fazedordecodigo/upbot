import type { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  Agent,
  DesktopCursorEvent,
  DesktopFrameEvent,
  DesktopInputEvent,
  DesktopThumbnail,
  Machine,
  MachineController,
  MachineStatus,
} from "@boto/protocol";
import type { ApprovalService } from "./approvals";
import type { RemoteComputer } from "./computer";
import { spawnEnv } from "./env/login-path";
import { envOverride } from "./env/vars";
import { BUN_PATH, HELPER, type HostStore, shq, sshArgs } from "./remote/hosts";
import { errorFields, RpcError } from "./runtime/agent-runtime";

/**
 * Live guest desktop ("Área de trabalho ao vivo"). One Machine per agent placed in a
 * Firecracker microVM; the service attaches to `boto-host desktop` on the agent's host,
 * which relays the NDJSON stream of the guest desktop agent (frames, thumbnails, cursor).
 *
 * Frames only reach WebSocket connections that subscribed to that machine, throttled to
 * FRAME_MAX_FPS. The controller is "agent" until a connection takes over; while the user
 * controls the machine the agent's computer tools are refused and only the owning
 * connection may send input. Names are deterministic slugs (`codigo-01`) persisted in
 * the `machines` table.
 */

export const FRAME_MAX_FPS = 10;
const FRAME_MIN_INTERVAL_MS = Math.floor(1000 / FRAME_MAX_FPS) - 5;
const THUMB_EVERY_MS = 5000;
const AGENT_ACTION_TIMEOUT_MS = 20000;
const THUMBNAIL_WAIT_MS = 8000;
const RECONNECT_BACKOFF_MS = 5000;
const MAX_LINE = 8 * 1024 * 1024;

type Send = (event: string, data: unknown) => void;

type GuestMessage = Record<string, unknown> & { type?: unknown };

type MachineState = {
  id: string;
  agentId: string;
  name: string;
  hostId: string | null;
  status: MachineStatus;
  controller: MachineController;
  owner: string | null;
  width: number;
  height: number;
  thumbnail: DesktopThumbnail | null;
  subscribers: Set<string>;
  child: ChildProcess | null;
  ready: boolean;
  lastFrameSentAt: number;
  lastSpawnAt: number;
  pending: Map<string, { resolve: (text: string) => void; reject: (e: Error) => void }>;
  thumbWaiters: ((t: DesktopThumbnail | null) => void)[];
};

export function machineSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return slug || "maquina";
}

export class DesktopService {
  private states = new Map<string, MachineState>();
  private connections = new Map<string, Send>();
  approvals: ApprovalService | null = null;

  constructor(
    private db: Database,
    private hosts: HostStore,
    private agentById: (id: string) => Agent | null,
    private broadcast: Send,
    private log: (msg: string, fields?: Record<string, unknown>) => void = () => {},
  ) {}

  // ---- connections (one per authenticated WebSocket) ----

  attach(connId: string, send: Send): void {
    this.connections.set(connId, send);
  }

  detach(connId: string): void {
    this.connections.delete(connId);
    for (const st of this.states.values()) {
      const wasSubscribed = st.subscribers.delete(connId);
      if (st.owner === connId) this.setController(st, "agent", null);
      if (wasSubscribed) this.applyStreamMode(st);
    }
  }

  // ---- machines ----

  /** Machine name sent to `boto-host run` so the guest hostname matches the UI. */
  machineNameFor(agentId: string): string | undefined {
    return this.machineFor(agentId)?.name;
  }

  list(): Machine[] {
    const out: Machine[] = [];
    for (const p of this.hosts.placements()) {
      if (p.isolation !== "firecracker") continue;
      const st = this.machineFor(p.agentId);
      if (st) out.push(this.view(st));
    }
    return out;
  }

  private machineFor(agentId: string): MachineState | null {
    const placement = this.hosts.placement(agentId);
    if (placement.isolation !== "firecracker") return null;
    const agent = this.agentById(agentId);
    if (!agent) return null;
    for (const st of this.states.values()) if (st.agentId === agentId) return st;
    let row = this.db
      .query("SELECT id, name, host_id FROM machines WHERE agent_id = ?")
      .get(agentId) as { id: string; name: string; host_id: string | null } | null;
    if (!row) {
      const slug = machineSlug(agent.name);
      const n = (
        this.db.query("SELECT COUNT(*) AS n FROM machines WHERE name LIKE ?").get(`${slug}-%`) as {
          n: number;
        }
      ).n;
      let name = `${slug}-${String(n + 1).padStart(2, "0")}`;
      for (let i = n + 2; this.db.query("SELECT 1 FROM machines WHERE name = ?").get(name); i++)
        name = `${slug}-${String(i).padStart(2, "0")}`;
      row = { id: randomUUID(), name, host_id: placement.hostId };
      this.db
        .query(
          "INSERT INTO machines (id, agent_id, name, host_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(row.id, agentId, name, placement.hostId, Date.now());
    } else if (row.host_id !== placement.hostId) {
      this.db.query("UPDATE machines SET host_id = ? WHERE id = ?").run(placement.hostId, row.id);
      row.host_id = placement.hostId;
    }
    const st: MachineState = {
      id: row.id,
      agentId,
      name: row.name,
      hostId: row.host_id,
      status: "stopped",
      controller: "agent",
      owner: null,
      width: 0,
      height: 0,
      thumbnail: null,
      subscribers: new Set(),
      child: null,
      ready: false,
      lastFrameSentAt: 0,
      lastSpawnAt: 0,
      pending: new Map(),
      thumbWaiters: [],
    };
    this.states.set(st.id, st);
    return st;
  }

  private view(st: MachineState): Machine {
    return {
      id: st.id,
      name: st.name,
      agentId: st.agentId,
      hostId: st.hostId,
      status: st.status,
      controller: st.controller,
      width: st.width,
      height: st.height,
      taskId: null,
      thumbnailAt: st.thumbnail?.at ?? null,
    };
  }

  private get(machineId: string): MachineState {
    const st = this.states.get(machineId);
    if (
      st &&
      this.hosts.placement(st.agentId).isolation === "firecracker" &&
      this.agentById(st.agentId)
    )
      return st;
    if (!st) {
      const row = this.db.query("SELECT agent_id FROM machines WHERE id = ?").get(machineId) as {
        agent_id: string;
      } | null;
      const loaded = row ? this.machineFor(row.agent_id) : null;
      if (loaded && loaded.id === machineId) return loaded;
    }
    throw new RpcError("not_found", "machine not found");
  }

  private emitMachine(st: MachineState) {
    this.broadcast("desktop.machine", this.view(st));
  }

  // ---- RPC ----

  subscribe(machineId: string, connId: string): Machine {
    const st = this.get(machineId);
    if (!this.connections.has(connId))
      throw new RpcError("bad_request", "desktop streaming needs a WebSocket connection");
    st.subscribers.add(connId);
    this.ensure(st);
    this.applyStreamMode(st);
    return this.view(st);
  }

  unsubscribe(machineId: string, connId: string): { ok: true } {
    const st = this.get(machineId);
    st.subscribers.delete(connId);
    this.applyStreamMode(st);
    return { ok: true };
  }

  async thumbnail(machineId: string): Promise<DesktopThumbnail> {
    const st = this.get(machineId);
    if (st.thumbnail) return st.thumbnail;
    this.ensure(st);
    const thumb = await new Promise<DesktopThumbnail | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), THUMBNAIL_WAIT_MS);
      st.thumbWaiters.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
    });
    if (!thumb) throw new RpcError("not_found", "no thumbnail yet; the machine is not streaming");
    return thumb;
  }

  takeover(machineId: string, connId: string): Machine {
    const st = this.get(machineId);
    if (!this.connections.has(connId))
      throw new RpcError("bad_request", "taking over needs a WebSocket connection");
    if (
      st.controller === "user" &&
      st.owner !== connId &&
      st.owner &&
      this.connections.has(st.owner)
    )
      throw new RpcError("busy", "another window already controls this machine");
    this.setController(st, "user", connId);
    this.ensure(st);
    return this.view(st);
  }

  release(machineId: string, connId: string): Machine {
    const st = this.get(machineId);
    if (
      st.controller === "user" &&
      st.owner !== connId &&
      st.owner &&
      this.connections.has(st.owner)
    )
      throw new RpcError("busy", "another window controls this machine");
    this.setController(st, "agent", null);
    return this.view(st);
  }

  input(machineId: string, connId: string, events: DesktopInputEvent[]): { ok: true } {
    const st = this.get(machineId);
    if (st.controller !== "user" || st.owner !== connId)
      throw new RpcError("bad_request", "take over the machine before sending input");
    if (!st.child || !st.ready) throw new RpcError("busy", "the machine desktop is not ready");
    this.write(st, { type: "input", events });
    return { ok: true };
  }

  // ---- agent (computer tool) side ----

  /** Remote Computer Use for agents whose desktop is a microVM; null keeps the local backend. */
  remoteComputer(agentId: string): RemoteComputer | null {
    const st = this.machineFor(agentId);
    if (!st) return null;
    return {
      screenshot: async () => {
        const text = await this.agentAction(st, { type: "screenshot" });
        return `saved a screenshot of the machine ${st.name} (${st.width}x${st.height}) to ${text} inside your workspace (click coordinates are in screen pixels)`;
      },
      click: async (_agent, x, y, double) => {
        const px = Number(x);
        const py = Number(y);
        if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0)
          throw new Error("x and y must be non-negative integers");
        return this.agentAction(st, {
          type: "agent",
          events: [{ type: "click", x: px, y: py, button: 1, double }],
        });
      },
      type: async (_agent, text) => {
        if (!text) throw new Error("text is required");
        return this.agentAction(st, { type: "agent", events: [{ type: "type", text }] });
      },
      key: async (_agent, key, modifiers) => {
        const mods = Array.isArray(modifiers)
          ? modifiers.filter((m): m is string => typeof m === "string")
          : [];
        const combo = [...mods, key].join("+");
        if (!/^[A-Za-z0-9_]{1,32}(\+[A-Za-z0-9_]{1,32}){0,4}$/.test(combo))
          throw new Error("key must be an X keysym name with up to four modifiers");
        return this.agentAction(st, { type: "agent", events: [{ type: "key", keysym: combo }] });
      },
    };
  }

  private async agentAction(st: MachineState, message: Record<string, unknown>): Promise<string> {
    if (st.controller === "user")
      throw new Error(
        `the user has taken control of ${st.name}; wait until they hand it back before using the computer`,
      );
    this.ensure(st);
    await this.waitReady(st);
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        st.pending.delete(id);
        reject(new Error("the machine desktop did not respond in time"));
      }, AGENT_ACTION_TIMEOUT_MS);
      st.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(st, { ...message, id });
    });
  }

  private waitReady(st: MachineState): Promise<void> {
    if (st.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + AGENT_ACTION_TIMEOUT_MS;
      const tick = () => {
        if (st.ready) return resolve();
        if (!st.child || Date.now() > deadline)
          return reject(new Error(`the machine ${st.name} is not running`));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /** Called on every `agent.status` broadcast so running microVMs get thumbnails. */
  onAgentStatus(data: { agentId: string; status: string }): void {
    if (data.status !== "running" && data.status !== "starting") return;
    const st = this.machineFor(data.agentId);
    if (st) this.ensure(st);
  }

  stop(): void {
    for (const st of this.states.values()) this.closeChild(st);
  }

  // ---- stream ----

  private setController(st: MachineState, controller: MachineController, owner: string | null) {
    const changed = st.controller !== controller || st.owner !== owner;
    st.controller = controller;
    st.owner = owner;
    if (st.child && st.ready) this.write(st, { type: "controller", controller });
    if (controller === "agent" && changed) this.finishTakeoverApprovals(st.agentId);
    if (changed) this.emitMachine(st);
  }

  private finishTakeoverApprovals(agentId: string) {
    if (!this.approvals) return;
    for (const a of this.approvals.list(agentId)) {
      if (a.kind !== "takeover" || a.status !== "pending") continue;
      this.approvals.respond({ id: a.id, decision: "done" }).catch((e) => {
        this.log("desktop takeover approval", { error: errorFields(e) });
      });
    }
  }

  private applyStreamMode(st: MachineState) {
    if (!st.child || !st.ready) return;
    const live = [...st.subscribers].some((c) => this.connections.has(c));
    this.write(st, { type: "stream", fps: live ? FRAME_MAX_FPS : 0, thumbEveryMs: THUMB_EVERY_MS });
  }

  private write(st: MachineState, message: Record<string, unknown>) {
    try {
      st.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {}
  }

  private command(st: MachineState): [string, string[]] | null {
    const override = envOverride("BOTO_DESKTOP_COMMAND");
    if (override) return [override[0] as string, override.slice(1)];
    const placement = this.hosts.placement(st.agentId);
    const host = placement.hostId ? this.hosts.get(placement.hostId) : null;
    if (!host?.root) return null;
    return sshArgs(host, [], `${BUN_PATH} exec bun ${shq(`${host.root}/${HELPER}`)} desktop`);
  }

  private ensure(st: MachineState) {
    if (st.child) return;
    if (Date.now() - st.lastSpawnAt < RECONNECT_BACKOFF_MS) return;
    const cmd = this.command(st);
    if (!cmd) {
      st.status = "error";
      this.emitMachine(st);
      return;
    }
    st.lastSpawnAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(cmd[0], cmd[1], {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv(),
      });
    } catch (e) {
      st.status = "error";
      this.log("desktop spawn", { error: errorFields(e) });
      this.emitMachine(st);
      return;
    }
    st.child = child;
    st.ready = false;
    st.status = "starting";
    this.emitMachine(st);
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.write(`${JSON.stringify({ agentId: st.agentId })}\n`);
    let buffer: Buffer = Buffer.alloc(0);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        const nl = buffer.indexOf(10);
        if (nl < 0) {
          if (buffer.length > MAX_LINE) buffer = Buffer.alloc(0);
          return;
        }
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (!line.length || line.length > MAX_LINE) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line.toString("utf8"));
        } catch {
          continue;
        }
        if (msg && typeof msg === "object" && !Array.isArray(msg))
          this.onGuestMessage(st, child, msg as GuestMessage);
      }
    });
    child.stderr?.on("data", () => {});
    child.on("close", (code) => {
      if (st.child !== child) return;
      st.child = null;
      const wasReady = st.ready;
      st.ready = false;
      st.status = wasReady || code === 0 ? "stopped" : "error";
      if (!wasReady && code !== 0) this.log("desktop stream ended", { code });
      for (const p of st.pending.values()) p.reject(new Error("the machine desktop went away"));
      st.pending.clear();
      for (const w of st.thumbWaiters.splice(0)) w(null);
      if (st.controller === "user") this.setController(st, "agent", null);
      this.emitMachine(st);
    });
  }

  private closeChild(st: MachineState) {
    const child = st.child;
    if (!child) return;
    st.child = null;
    try {
      child.stdin?.end();
      child.kill("SIGTERM");
    } catch {}
  }

  private onGuestMessage(st: MachineState, child: ChildProcess, m: GuestMessage) {
    if (st.child !== child) return;
    switch (m.type) {
      case "ready": {
        st.ready = true;
        st.status = "ready";
        if (typeof m.width === "number") st.width = m.width;
        if (typeof m.height === "number") st.height = m.height;
        this.write(st, { type: "controller", controller: st.controller });
        this.applyStreamMode(st);
        this.emitMachine(st);
        break;
      }
      case "frame": {
        const now = Date.now();
        if (now - st.lastFrameSentAt < FRAME_MIN_INTERVAL_MS) return;
        if (typeof m.data !== "string" || typeof m.seq !== "number") return;
        st.lastFrameSentAt = now;
        const frame: DesktopFrameEvent = {
          machineId: st.id,
          seq: m.seq,
          mime: typeof m.mime === "string" ? m.mime : "image/jpeg",
          dataBase64: m.data,
          width: typeof m.width === "number" ? m.width : st.width,
          height: typeof m.height === "number" ? m.height : st.height,
        };
        this.toSubscribers(st, "desktop.frame", frame);
        break;
      }
      case "thumb": {
        if (typeof m.data !== "string") return;
        const first = !st.thumbnail;
        st.thumbnail = {
          mime: typeof m.mime === "string" ? m.mime : "image/jpeg",
          dataBase64: m.data,
          at: new Date().toISOString(),
        };
        for (const w of st.thumbWaiters.splice(0)) w(st.thumbnail);
        if (first) this.emitMachine(st);
        break;
      }
      case "cursor": {
        if (typeof m.x !== "number" || typeof m.y !== "number") return;
        const kind = m.kind;
        const cursor: DesktopCursorEvent = {
          machineId: st.id,
          x: m.x,
          y: m.y,
          kind: kind === "click" || kind === "type" || kind === "key" ? kind : "move",
        };
        this.toSubscribers(st, "desktop.cursor", cursor);
        break;
      }
      case "done": {
        if (typeof m.id !== "string") return;
        const p = st.pending.get(m.id);
        if (!p) return;
        st.pending.delete(m.id);
        p.resolve(typeof m.text === "string" ? m.text : "ok");
        break;
      }
      case "error": {
        const code = typeof m.code === "string" ? m.code : "unknown";
        if (typeof m.id === "string") {
          const p = st.pending.get(m.id);
          if (p) {
            st.pending.delete(m.id);
            p.reject(
              new Error(
                code === "not_controller"
                  ? `the user controls ${st.name}; wait until they hand it back`
                  : `the machine desktop refused the action (${code})`,
              ),
            );
          }
        } else this.log("desktop guest error", { code });
        break;
      }
      default:
        break;
    }
  }

  private toSubscribers(st: MachineState, event: string, data: unknown) {
    for (const connId of st.subscribers) {
      const send = this.connections.get(connId);
      if (!send) {
        st.subscribers.delete(connId);
        continue;
      }
      try {
        send(event, data);
      } catch {}
    }
  }
}
