import { expect, test } from "bun:test";
import { join } from "node:path";
import { AgentStore } from "../src/agents";
import { ChatStore } from "../src/chat-store";
import { openDatabase } from "../src/db";
import { removeDir, tmp } from "./helpers";

test("unattributed approvals never fan out to concurrent task scopes", async () => {
  const root = tmp("approval-scope-");
  const db = openDatabase(root);
  try {
    const agent = new AgentStore(db, join(root, "agents")).create({
      name: "Parallel",
      provider: "devin",
    });
    const chat = new ChatStore(db);
    for (const id of ["first", "second"])
      db.query(
        "INSERT INTO tasks (id,agent_id,title,prompt,situation,private,created_at,updated_at) VALUES (?,?,'private','secret','run',1,1,1)",
      ).run(id, agent.id);
    const orphan = { agentId: agent.id, turnId: null, createdAt: 20 };
    expect(chat.visibleTurn(null, "first", agent.id, 20)).toBe(false);
    expect(chat.visibleTurn(null, "second", agent.id, 20)).toBe(false);
    expect(chat.visibleTurn(null, undefined, agent.id, 20)).toBe(false);
    expect(chat.privateEventTasks("approval.updated", orphan)).toEqual([]);
    const turn = chat.createTurn(agent.id, null, "first");
    expect(chat.visibleTurn(turn.id, "first", agent.id, 20)).toBe(true);
    expect(chat.visibleTurn(turn.id, "second", agent.id, 20)).toBe(false);
    expect(chat.privateEventTasks("approval.updated", { ...orphan, turnId: turn.id })).toEqual([
      "first",
    ]);
    expect(chat.visibleTurn("missing-turn", "first", agent.id, 20)).toBe(false);
    db.query("DELETE FROM tasks").run();
    expect(chat.visibleTurn(null, undefined, agent.id, 20)).toBe(true);
    expect(chat.privateEventTasks("approval.updated", orphan)).toEqual([]);
  } finally {
    db.close();
    await removeDir(root);
  }
}, 30_000);
