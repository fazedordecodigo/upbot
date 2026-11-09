import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

test("chat retains its native provider session across tasks and a daemon restart", async () => {
  const dirs = [tmp("scope-data-"), tmp("scope-agents-"), tmp("scope-provider-")];
  const token = crypto.randomUUID();
  const env = {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: dirs[2]!,
  };
  let daemon = await startDaemon(dirs[0]!, dirs[1]!, token, env);
  let client = await DaemonClient.connect(daemon.port, token);
  try {
    const agent = await client.request("agents.create", { name: "Scopes", provider: "devin" });
    const send = async (text: string) => {
      const { queueId } = await client.request("chat.send", { agentId: agent.id, text });
      await client.waitForEventWhere("turn.ended", (turn) => turn.queueId === queueId, 15_000);
    };
    const session = () => {
      const db = new Database(join(dirs[0]!, "boto.db"), { readonly: true });
      try {
        return db
          .query("SELECT session_id FROM agent_sessions WHERE agent_id = ?")
          .get(agent.id) as { session_id: string };
      } finally {
        db.close();
      }
    };
    await send("echo:chat context");
    const initial = session().session_id;
    const task = await client.request("tasks.create", {
      agentId: agent.id,
      text: "echo:task context",
    });
    await client.waitForEventWhere("turn.ended", (turn) => turn.taskId === task.id, 15_000);
    expect(session().session_id).toBe(initial);
    await send("echo:back to chat");
    expect(session().session_id).toBe(initial);
    await stopDaemon(daemon, client, dirs[2]!);
    daemon = await startDaemon(dirs[0]!, dirs[1]!, token, env);
    client = await DaemonClient.connect(daemon.port, token);
    await client.request("tasks.instruct", { id: task.id, text: "echo:task resumed" });
    await client.waitForEventWhere("turn.ended", (turn) => turn.taskId === task.id, 15_000);
    await send("echo:chat after restart");
    expect(session().session_id).toBe(initial);
    const loads = readLog(dirs[2]!).filter((row) => row.method === "session/load");
    expect(
      loads.filter((row) => (row.params as { sessionId: string }).sessionId === initial),
    ).toHaveLength(2);
  } finally {
    await stopDaemon(daemon, client, dirs[2]!);
    for (const dir of dirs) removeDir(dir);
  }
}, 60_000);
