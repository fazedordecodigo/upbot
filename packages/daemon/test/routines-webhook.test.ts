import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AgentStore } from "../src/agents";
import { openDatabase } from "../src/db";
import { RoutineService } from "../src/routines";
import { DaemonClient, FAKE_AGENT, startDaemon, stopDaemon, tmp } from "./helpers";

test("manual routine history exposes the completed turn and timestamps", async () => {
  const data = tmp("routine-history-data-");
  const root = tmp("routine-history-bots-");
  const fake = tmp("routine-history-fake-");
  const token = crypto.randomUUID();
  const daemon = await startDaemon(data, root, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: fake,
  });
  const client = await DaemonClient.connect(daemon.port, token);
  try {
    const bot = await client.request("agents.create", {
      name: "History bot",
      provider: "devin",
      instructions: "",
    });
    const routine = await client.request("routines.create", {
      agentId: bot.id,
      name: "History",
      prompt: "echo:history",
    });
    expect(await client.request("routines.runs", { id: routine.id })).toEqual([]);
    await client.request("routines.run", { id: routine.id });
    await client.waitForEventWhere("turn.ended", (event) => event.agentId === bot.id);
    const [run] = await client.request("routines.runs", { id: routine.id });
    expect(run?.trigger).toBe("manual");
    expect(run?.queueStatus).toBe("started");
    expect(run?.turn?.status).toBe("completed");
    expect(run?.turn?.startedAt).toBeNumber();
    expect(run?.turn?.endedAt).toBeNumber();
  } finally {
    await stopDaemon(daemon, client, fake);
    for (const path of [data, root, fake]) rmSync(path, { recursive: true, force: true });
  }
}, 20000);

describe("routine webhook authentication", () => {
  let dataDir: string;
  let agentsRoot: string;
  let db: ReturnType<typeof openDatabase>;
  let agents: AgentStore;
  let routines: RoutineService;
  let routineReads: number;

  beforeEach(() => {
    dataDir = tmp("routines-webhook-data-");
    agentsRoot = tmp("routines-webhook-agents-");
    db = openDatabase(dataDir);
    routineReads = 0;
    const query = db.query.bind(db);
    db.query = ((sql: string) => {
      if (sql.includes("FROM routines WHERE id = ?")) routineReads++;
      return query(sql);
    }) as typeof db.query;
    agents = new AgentStore(db, agentsRoot);
    routines = new RoutineService(
      db,
      agents,
      () => ({}) as never,
      () => {},
    );
  });

  afterEach(() => {
    db.close();
    for (const dir of [dataDir, agentsRoot])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function createRoutine() {
    const agent = agents.create({
      name: "Webhook test agent",
      provider: "devin",
      instructions: "",
    });
    const routine = routines.create({
      agentId: agent.id,
      name: "Webhook test routine",
      prompt: "test",
      webhook: true,
    });
    if (!routine.webhookToken) throw new Error("webhook token was not created");
    return { agent, routine, token: routine.webhookToken };
  }

  function auth(id: string, token: string) {
    routineReads = 0;
    const result = routines.webhookAuth(id, token);
    expect(routineReads).toBe(1);
    return result;
  }

  test("unknown routine ids are unauthorized and marked unknown", () => {
    expect(auth("missing-routine", "wrong")).toEqual({
      kind: "unauthorized",
      known: false,
    });
  });

  test("known webhook routines reject an incorrect token", () => {
    const { routine } = createRoutine();
    expect(auth(routine.id, "wrong")).toEqual({
      kind: "unauthorized",
      known: true,
    });
  });

  test("correct tokens authenticate to their routine", () => {
    const { routine, token } = createRoutine();
    expect(auth(routine.id, token)).toEqual({
      kind: "ok",
      routineId: routine.id,
    });
  });

  test("disabled webhook routines reject the correct token", () => {
    const { routine, token } = createRoutine();
    routines.update({ id: routine.id, enabled: false });
    expect(auth(routine.id, token)).toEqual({
      kind: "unauthorized",
      known: true,
    });
  });

  test("routines whose agents are soft-deleted are not found", () => {
    const { agent, routine, token } = createRoutine();
    expect(agents.softDelete(agent.id)).toBe(true);
    expect(auth(routine.id, token)).toEqual({ kind: "notFound" });
  });
});
