import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonClient,
  FAKE_AGENT,
  readLog,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

test("routine attachments survive restart and are reused with routine context on every run", async () => {
  const data = tmp("routine-attachments-data-");
  const root = tmp("routine-attachments-bots-");
  const state = tmp("routine-attachments-acp-");
  const token = crypto.randomUUID();
  const env = {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: state,
    BOTO_ROUTINE_TICK_MS: "50",
  };
  let daemon = await startDaemon(data, root, token, env);
  let client = await DaemonClient.connect(daemon.port, token);
  const file = {
    name: "context.txt",
    mime: "text/plain",
    dataBase64: Buffer.from("saved context").toString("base64"),
  };
  try {
    const agent = await client.request("agents.create", { name: "Attachments", provider: "devin" });
    const routine = await client.request("routines.create", {
      agentId: agent.id,
      name: "Context routine",
      prompt: "echo:context",
      schedule: "every 1m",
      attachments: [file],
    });
    const saved = routine.attachments?.[0];
    if (!saved) throw new Error("Missing saved attachment");
    expect(saved?.name).toBe("context.txt");
    expect(readFileSync(saved.path, "utf8")).toBe("saved context");
    const directories = readdirSync(join(agent.workspacePath, "attachments"));
    await expect(
      client.request("routines.create", {
        agentId: agent.id,
        name: "Invalid",
        prompt: "x",
        attachments: Array.from({ length: 11 }, () => file),
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      client.request("routines.update", {
        id: routine.id,
        attachments: [
          { ...file, dataBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") },
        ],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(
      (await client.request("routines.list", {})).find((r) => r.id === routine.id)?.attachments,
    ).toEqual(routine.attachments);
    await stopDaemon(daemon, client, state);
    daemon = await startDaemon(data, root, token, env);
    client = await DaemonClient.connect(daemon.port, token);
    expect(
      (await client.request("routines.list", {})).find((r) => r.id === routine.id)?.attachments,
    ).toEqual(routine.attachments);
    for (let i = 0; i < 2; i++) {
      const run = await client.request("routines.run", { id: routine.id });
      if (!run.taskId) throw new Error("Routine did not create a task");
      const turn = await client.waitForEventWhere(
        "turn.ended",
        (event) => event.taskId === run.taskId,
      );
      expect(turn.status).toBe("completed");
      const history = await client.request("tasks.history", { id: run.taskId });
      expect(history.items.find((item) => item.kind === "user_message")?.attachments).toEqual(
        routine.attachments,
      );
      const db = new Database(join(data, "boto.db"), { readonly: true });
      try {
        const queued = db
          .query("SELECT prompt, meta_json FROM queue WHERE task_id = ?")
          .get(run.taskId) as { prompt: string; meta_json: string };
        expect(queued.prompt).toContain(saved.path);
        expect(queued.prompt).toContain('<routine name="Context routine" trigger="manual">');
        expect(JSON.parse(queued.meta_json)).toMatchObject({
          routine: { id: routine.id, trigger: "manual" },
          attachments: routine.attachments,
        });
      } finally {
        db.close();
      }
    }
    await client.request("routines.update", {
      id: routine.id,
      schedule: null,
      runAt: Date.now() + 300,
    });
    const ended = await client.waitForEventWhere(
      "turn.ended",
      (event) => event.agentId === agent.id,
    );
    expect(ended.status).toBe("completed");
    const runs = await client.request("routines.runs", { id: routine.id });
    expect(runs.some((run) => run.trigger === "schedule")).toBe(true);
    const prompts = readLog(state)
      .filter((entry) => entry.method === "session/prompt")
      .map((entry) => JSON.stringify(entry.params));
    expect(
      prompts.some(
        (prompt) =>
          prompt.includes(JSON.stringify(saved.path).slice(1, -1)) &&
          prompt.includes('trigger=\\"schedule\\"'),
      ),
    ).toBe(true);
    expect(readdirSync(join(agent.workspacePath, "attachments"))).toEqual(directories);
    const cleared = await client.request("routines.update", { id: routine.id, attachments: [] });
    expect(cleared.attachments).toEqual([]);
    const replacement = await client.request("routines.update", {
      id: routine.id,
      attachments: [{ ...file, name: "replacement.txt" }],
    });
    expect(replacement.attachments?.[0]?.name).toBe("replacement.txt");
  } finally {
    await stopDaemon(daemon, client, state);
    for (const dir of [data, root, state]) await removeDir(dir);
  }
}, 60_000);
