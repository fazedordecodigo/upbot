import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AgentStore } from "./agents";
import { AgentsOverviewService, agentApprovalPolicy } from "./agents-overview";
import { ApprovalService } from "./approvals";
import { AppsService } from "./apps";
import { Bridge } from "./bridge";
import { BrowserService } from "./browser";
import { ChannelService } from "./channels";
import { ChatStore, QueueStore } from "./chat-store";
import { CollaborationService } from "./collaborations";
import { ComputerUse } from "./computer";
import { Connectors } from "./connectors";
import { openDatabase } from "./db";
import { getProfileDefaults } from "./db/settings";
import { DesktopService } from "./desktop";
import { EmailService } from "./email";
import { mergedPath } from "./env/login-path";
import { GatewayService } from "./gateways";
import { migrateLegacyHome } from "./legacy";
import { Marketplace } from "./marketplace";
import { runMcpBridge } from "./mcp-bridge";
import { MemoryStore } from "./memories";
import { MobileServer } from "./mobile";
import { PageLibrary } from "./pages";
import { botoContext, migrateDefaultBot } from "./persona";
import { ProfileService } from "./profile";
import { ProvidersService } from "./providers-service";
import { readyLine } from "./ready";
import { VmCredentials } from "./remote/credentials";
import { HostStore } from "./remote/hosts";
import { LocalVmService } from "./remote/localvm";
import { RoutineService } from "./routines";
import { Rpc } from "./rpc";
import { errorFields } from "./runtime/agent-runtime";
import { RuntimeManager } from "./runtime/runtime-manager";
import { SkillLibrary } from "./skills";
import { SubagentService } from "./subagents";
import { TaskService } from "./tasks";
import { TeamClient } from "./team";
import { TemplateService } from "./templates";
import { ToolPermissions } from "./tool-permissions";
import { Vault } from "./vault";
import { VERSION } from "./version";
import { Voice } from "./voice";

const ORIGIN_ALLOWLIST = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
]);

function parseArgs(argv: string[]): { dataDir: string; agentsRoot: string } {
  let dataDir: string | undefined;
  let agentsRoot = join(homedir(), "Boto", "agents");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--agents-root") {
      agentsRoot = argv[++i]!;
    }
  }
  if (!dataDir) {
    console.error("botod: --data-dir <path> is required");
    process.exit(2);
  }
  return { dataDir, agentsRoot };
}

function tokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function log(...args: unknown[]) {
  console.error("[botod]", ...args);
}

const LOGGED_ERROR_TYPES = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "RpcError"]);
function errorType(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return LOGGED_ERROR_TYPES.has(name) ? name : "Error";
}

/** Emits at most one line per key per minute so rejected-auth loops can't spam stderr. */
const LOG_LIMIT_MS = 60_000;
const logLimitedLast = new Map<string, number>();
function logLimited(event: string, key: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - (logLimitedLast.get(key) ?? 0) < LOG_LIMIT_MS) return;
  logLimitedLast.set(key, now);
  log(event, fields);
}

/** Reads the auth token from the first stdin line; refuses to start without one. */
function readTokenFromStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 10_000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      finish(line.trim() || null);
      // keep watching stdin for EOF (parent death)
      rl.on("close", () => shutdown(0, "stdin EOF"));
    });
    rl.once("close", () => finish(null));
    void timer;
  });
}

let shuttingDown = false;
let dbRef: { close(): void } | null = null;
let serverRef: { stop(): void } | null = null;
let runtimesRef: { closeAll(): Promise<void> } | null = null;
let gatewaysRef: { stopAll(): void } | null = null;
let approvalsSuspendRef: { suspend(): void } | null = null;
let desktopStopRef: { stop(): void } | null = null;

function shutdown(code: number, reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down", { reason, code });
  try {
    approvalsSuspendRef?.suspend();
  } catch {}
  try {
    desktopStopRef?.stop();
  } catch {}
  try {
    gatewaysRef?.stopAll();
  } catch {}
  const done = () => {
    try {
      serverRef?.stop();
    } catch {}
    try {
      dbRef?.close();
    } catch {}
    process.exit(code);
  };
  const p = runtimesRef?.closeAll() ?? Promise.resolve();
  p.catch((e) => log("closeAll failed", e)).finally(() => setTimeout(done, 50));
  setTimeout(() => {
    log("forced exit after 4s");
    process.exit(code);
  }, 4000).unref();
}

async function main() {
  if (process.argv[2] === "mcp-bridge") {
    await runMcpBridge();
    process.exit(0);
  }
  const { dataDir, agentsRoot } = parseArgs(process.argv.slice(2));
  const token = await readTokenFromStdin();
  if (!token) {
    console.error("botod: no auth token on stdin (first line required)");
    process.exit(2);
  }

  let approvalsRef: ApprovalService | null = null;
  let tasks: TaskService | null = null;
  let overviewRef: AgentsOverviewService | null = null;
  const db = openDatabase(dataDir);
  dbRef = db;
  const chat = new ChatStore(db);
  chat.interruptRunningTurns();
  migrateLegacyHome(db, agentsRoot, log);
  const store = new AgentStore(db, agentsRoot);
  migrateDefaultBot(db);
  const workspaceRoot = process.env.BOTO_WORKSPACE_ROOT || join(dirname(agentsRoot), "Workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const queue = new QueueStore(db);
  const hosts = new HostStore(db);
  const sockets = new Set<
    import("bun").ServerWebSocket<{ connId: string; taskIds: Set<string> }>
  >();
  let desktopRef: DesktopService | null = null;
  desktopStopRef = null;

  function broadcast(event: string, data: unknown) {
    const privateTasks = chat.privateEventTasks(event, data);
    const msg = JSON.stringify({ event, data });
    if (event === "agent.status")
      desktopRef?.onAgentStatus(data as { agentId: string; status: string });
    for (const ws of sockets) {
      try {
        if (privateTasks.length) {
          for (const taskId of privateTasks) {
            if (ws.data.taskIds.has(taskId))
              ws.send(JSON.stringify({ event: "task.event", data: { taskId, event, data } }));
          }
        } else ws.send(msg);
      } catch {}
    }
    if (!privateTasks.length) mobile.onEvent(event, data);
    if (!event.startsWith("task.")) {
      try {
        tasks?.onEvent(event, data);
      } catch (e) {
        log(`task event hook failed: event=${event} ${errorFields(e)}`);
      }
    }
    overviewRef?.onEvent(event);
    if (event === "turn.ended") {
      const turn = data as import("@boto/protocol").Turn;
      queueMicrotask(() => {
        void (async () => {
          approvalsRef?.onTurnEnded(turn.agentId, turn.id);
          const row = turn.queueId ? queue.row(turn.queueId) : null;
          collaborations.onTurnEnded(turn, row);
          if (chat.isPrivateTask(turn.taskId)) return;
          channels.onTurnEnded(turn, row);
          gateways.onTurnEnded(turn, row);
          team.onTurnEnded(turn, row);
          await subagents.onTurnEnded(turn, row);
        })().catch((e) => log("turn-ended hook failed", e));
      });
    }
  }

  const sharedRoot = process.env.BOTO_SHARED_ROOT || join(dirname(agentsRoot), "Shared");
  const bridge = new Bridge(store, () => runtimes, sharedRoot);
  const memories = new MemoryStore(db);
  const skills = new SkillLibrary(sharedRoot);
  const vault = new Vault(db, dataDir);
  const vmCredentials = new VmCredentials(vault);
  const runtimes = new RuntimeManager(
    store,
    chat,
    queue,
    broadcast,
    (id) => bridge.serversFor(id),
    (id, turnId, fresh) =>
      (fresh ? botoContext(workspaceRoot) : "") +
      memories.promptBlock(id, turnId, fresh, collaborations.sessionUsesMemory(turnId)) +
      (fresh ? skills.promptBlock((items) => memories.recordUsage(turnId, items)) : ""),
    (id) => hosts.launchFor(id, bridge.port),
    () => [workspaceRoot],
    (turnId) => memories.usage(turnId),
    (provider) => vmCredentials.apiKey(provider),
  );
  const subagents = new SubagentService(db, store, chat, queue, () => runtimes, hosts, broadcast);
  bridge.subagents = subagents;
  runtimesRef = runtimes;
  const channels = new ChannelService(db, store, chat, () => runtimes, broadcast);
  bridge.channels = channels;
  bridge.memories = memories;
  bridge.skills = skills;
  bridge.broadcast = broadcast;
  const routines = new RoutineService(db, store, () => runtimes, broadcast);
  const browser = new BrowserService(join(dataDir, "browser-profile"), broadcast);
  bridge.browser = browser;
  const providers = new ProvidersService(db, vmCredentials, broadcast);
  hosts.credentialEnv = (provider) => vmCredentials.env(provider);
  const computer = new ComputerUse(db);
  const desktop = new DesktopService(db, hosts, (id) => store.get(id), broadcast, log);
  desktopRef = desktop;
  desktopStopRef = desktop;
  hosts.machineNameFor = (id) => desktop.machineNameFor(id);
  computer.remote = (id) => desktop.remoteComputer(id);
  const voice = new Voice(join(dataDir, "voice"), mergedPath);
  bridge.vault = vault;
  const email = new EmailService(db, vault, broadcast);
  bridge.email = email;
  const apps = new AppsService(db, vault, broadcast);
  bridge.apps = apps;
  const approvals = new ApprovalService(db, vault, () => runtimes, broadcast, apps);
  approvals.interruptLeftovers();
  approvalsSuspendRef = approvals;
  bridge.approvals = approvals;
  desktop.approvals = approvals;
  const pages = new PageLibrary(db, workspaceRoot, broadcast);
  bridge.pages = pages;
  approvalsRef = approvals;
  approvals.addAskPolicy(agentApprovalPolicy(store));
  const overview = new AgentsOverviewService(
    store,
    queue,
    () => runtimes,
    () => approvalsRef,
    broadcast,
  );
  overviewRef = overview;
  bridge.connectors = new Connectors(vault);
  tasks = new TaskService(db, store, chat, queue, () => runtimes, broadcast, {
    pendingApprovals: () => approvals.list().filter((a) => a.status === "pending"),
    routines: () => routines.list(),
    defaults: () => getProfileDefaults(db),
  });
  tasks.recover();
  runtimes.tasks = tasks.hooks();
  const taskService = tasks;
  const collaborations = new CollaborationService(db, store, chat, () => runtimes, broadcast, {
    instructTask: (taskId, text) => taskService.instruct(taskId, text),
  });
  bridge.collaborations = collaborations;
  approvals.addAskPolicy(collaborations.askPolicy());
  routines.setTaskSink({
    create(p) {
      const task = taskService.create(
        {
          agentId: p.agentId,
          text: p.prompt,
          templateId: p.templateId ?? undefined,
          toolMode: p.toolMode,
          requireApproval: p.requireApproval,
          private: p.private,
        },
        {
          routineId: p.routineId,
          attachments: p.attachments,
          title: p.title,
          source: {
            prompt: p.sendPrompt,
            meta: {
              routine: { id: p.routineId, name: p.title, trigger: p.trigger },
              attachments: p.attachments,
            },
          },
        },
      );
      const row = db
        .query("SELECT id FROM queue WHERE task_id = ? AND agent_id = ?")
        .get(task.id, task.agentId) as { id: string } | null;
      return { taskId: task.id, queueId: row?.id ?? null };
    },
  });
  overview.setTaskResolver((queueId) => {
    const taskId = queue.row(queueId)?.task_id;
    if (!taskId) return null;
    const task = taskService.get(taskId);
    return { taskId, title: task.title };
  });
  overview.addMachineSource((agentId) =>
    desktop
      .list()
      .filter((m) => m.agentId === agentId)
      .map((m) => m.id),
  );
  desktop.taskFor = (agentId) => runtimes.currentTurn(agentId)?.taskId ?? null;
  bridge.tasksFor = (agentId) =>
    runtimes.activeTurns(agentId).flatMap((turn) => {
      const stored = chat.getTurn(turn.id);
      if (!stored) throw new Error("running turn policy unavailable");
      const taskId = stored.taskId;
      if (!taskId) return [];
      const task = taskService.runtimeInfo(taskId);
      if (!task || task.agentId !== agentId) throw new Error("running task policy unavailable");
      return [task];
    });
  bridge.computer = computer;
  const mobile = new MobileServer(db);
  const team = new TeamClient(db, store, chat, () => runtimes, vault, broadcast);
  const gateways = new GatewayService(db, store, chat, () => runtimes, vault, broadcast);
  gatewaysRef = gateways;
  const localvm = new LocalVmService(hosts, dataDir, broadcast, log);
  localvm.onHostChanged = () => broadcast("hosts.changed", {});
  void localvm.sync();
  // after every broadcast-referenced service exists: recover() may emit events
  collaborations.recover();
  const rpc = new Rpc(
    store,
    chat,
    queue,
    runtimes,
    broadcast,
    channels,
    memories,
    skills,
    routines,
    browser,
    {
      vault,
      templates: new TemplateService(db, broadcast),
      vmCredentials,
      providers,
      toolPermissions: new ToolPermissions(approvals, apps),
      computer,
      voice,
      gateways,
      email,
      apps,
      approvals,
      pages,
      marketplace: new Marketplace(db, skills, store, apps, providers),
      mobile,
      team,
      hosts,
      localvm,
      subagents,
      tasks: taskService,
      profile: new ProfileService(db, memories, broadcast),
      desktop,
      overview,
      collaborations,
    },
  );

  // warm the login-shell PATH cache so provider CLIs resolve like in a terminal
  const path = mergedPath();
  log(`PATH resolved (${path.split(":").length} entries)`);

  function checkOrigin(req: Request, route: string): Response | null {
    const origin = req.headers.get("origin");
    if (origin !== null && !ORIGIN_ALLOWLIST.has(origin)) {
      logLimited("auth.rejected", `${route}:403`, { route, status: 403, reason: "origin" });
      return new Response("forbidden origin", { status: 403 });
    }
    return null;
  }

  const server = Bun.serve<{ connId: string; taskIds: Set<string> }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const denied = checkOrigin(req, "/ws");
        if (denied) return denied;
        const reqToken = url.searchParams.get("token") ?? "";
        if (!tokenEqual(reqToken, token)) {
          logLimited("auth.rejected", "/ws:401", { route: "/ws", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req, { data: { connId: randomUUID(), taskIds: new Set<string>() } }))
          return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/bridge") {
        // called only by our mcp-bridge child processes, never by a browser
        if (req.method !== "POST" || req.headers.get("origin") !== null) {
          logLimited("auth.rejected", "/bridge:403", {
            route: "/bridge",
            status: 403,
            reason: req.headers.get("origin") !== null ? "origin" : "method",
          });
          return new Response("forbidden", { status: 403 });
        }
        const auth = req.headers.get("authorization") ?? "";
        const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const agentId = bridge.agentForToken(presented);
        if (!agentId) {
          const tokenFp = presented
            ? createHash("sha256").update(presented).digest("hex").slice(0, 8)
            : "none";
          logLimited("auth.rejected", `/bridge:401:${tokenFp}`, {
            route: "/bridge",
            status: 401,
            tokenFp,
          });
          return new Response("unauthorized", { status: 401 });
        }
        return req
          .json()
          .then((body) => bridge.handle(agentId, body as Record<string, unknown>))
          .then(
            (r) => Response.json(r),
            (e) => {
              const message = (e as Error).message;
              logLimited("bridge.error", `/bridge:error:${agentId}`, {
                agentId,
                errorType: errorType(e),
              });
              return new Response(message, { status: 400 });
            },
          );
      }
      const hook = /^\/hooks\/([\w-]+)$/.exec(url.pathname);
      if (hook) {
        const routineId = hook[1] ?? "";
        // local webhook trigger for a routine (curl, scripts); never from a browser page
        if (req.method !== "POST" || req.headers.get("origin") !== null) {
          const label = routines.exists(routineId) ? routineId : "unknown";
          logLimited("auth.rejected", `/hooks/:id:403:${label}`, {
            route: "/hooks/:id",
            status: 403,
            reason: req.headers.get("origin") !== null ? "origin" : "method",
            routineId: label,
          });
          return new Response("forbidden", { status: 403 });
        }
        const auth = req.headers.get("authorization") ?? "";
        const authz = routines.webhookAuth(
          routineId,
          auth.startsWith("Bearer ") ? auth.slice(7) : "",
        );
        if (authz.kind === "notFound") return new Response("not found", { status: 404 });
        if (authz.kind === "unauthorized") {
          const label = authz.known ? routineId : "unknown";
          logLimited("auth.rejected", `/hooks/:id:401:${label}`, {
            route: "/hooks/:id",
            status: 401,
            routineId: label,
          });
          return new Response("unauthorized", { status: 401 });
        }
        return req.text().then(
          (payload) => {
            const run = routines.run(authz.routineId, "webhook", payload);
            return Response.json(run, { status: run.error ? 409 : 202 });
          },
          () => new Response("bad request", { status: 400 }),
        );
      }
      const pageMatch = /^\/pages\/([\w-]+)$/.exec(url.pathname);
      if (pageMatch && req.method === "GET") {
        return pages.serve(pageMatch[1]!, url.searchParams.get("token") ?? "");
      }
      if (url.pathname === "/health") {
        const denied = checkOrigin(req, "/health");
        if (denied) return denied;
        const auth = req.headers.get("authorization") ?? "";
        const reqToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenEqual(reqToken, token)) {
          logLimited("auth.rejected", "/health:401", { route: "/health", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ ok: true, version: VERSION });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 48 * 1024 * 1024,
      open(ws) {
        sockets.add(ws);
        desktop.attach(ws.data.connId, (event, data) => {
          ws.send(JSON.stringify({ event, data }));
        });
      },
      close(ws) {
        sockets.delete(ws);
        desktop.detach(ws.data.connId);
      },
      async message(ws, msg) {
        const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
        try {
          ws.send(
            await rpc.handle(text, {
              id: ws.data.connId,
              watchTask: (id, watch) => {
                if (watch) ws.data.taskIds.add(id);
                else ws.data.taskIds.delete(id);
              },
            }),
          );
        } catch (e) {
          log("rpc error", e);
        }
      },
    },
  });

  serverRef = server;
  bridge.port = server.port ?? 0;
  pages.port = server.port ?? 0;
  runtimes.resumeAllQueues();
  routines.baseUrl = `http://127.0.0.1:${server.port}`;
  routines.start();
  gateways.startAll();
  mobile.rpc = (raw) => rpc.handle(raw);
  mobile.start();
  team.start();
  console.log(readyLine(server.port ?? 0));
  log(`listening on 127.0.0.1:${server.port}, data dir ${dataDir}`);

  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => shutdown(0, "SIGINT"));
}

main().catch((e) => {
  console.error("[botod] fatal", e);
  process.exit(1);
});
