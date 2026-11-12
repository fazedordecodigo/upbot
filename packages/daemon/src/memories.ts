import type { Database } from "bun:sqlite";
import type { Memory, MemoryUsageItem, MemoryUsageResult } from "@boto/protocol";

const PROMPT_BUDGET = 8_000;

type Row = { id: string; agent_id: string; text: string; created_at: number; updated_at: number };

const toMemory = (r: Row): Memory => ({
  id: r.id,
  agentId: r.agent_id,
  text: r.text,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class MemoryStore {
  constructor(private db: Database) {}

  list(agentId: string): Memory[] {
    const rows = this.db
      .query(
        "SELECT * FROM memories WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all(agentId) as Row[];
    return rows.map(toMemory);
  }

  get(id: string): Memory | null {
    const r = this.db
      .query("SELECT * FROM memories WHERE id = ? AND agent_id IS NOT NULL AND deleted_at IS NULL")
      .get(id) as Row | null;
    return r ? toMemory(r) : null;
  }

  add(agentId: string, text: string): Memory {
    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO memories (id, agent_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, agentId, text.trim(), now, now);
    return this.get(id)!;
  }

  update(id: string, text: string): Memory | null {
    this.db
      .query(
        "UPDATE memories SET text = ?, updated_at = ? WHERE id = ? AND agent_id IS NOT NULL AND deleted_at IS NULL",
      )
      .run(text.trim(), Date.now(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db
      .query(
        "UPDATE memories SET deleted_at = ? WHERE id = ? AND agent_id IS NOT NULL AND deleted_at IS NULL",
      )
      .run(Date.now(), id);
    return r.changes > 0;
  }

  userProfile(): { id: string; text: string } | null {
    return this.db
      .query(
        "SELECT id, text FROM memories WHERE kind = 'profile' AND agent_id IS NULL AND deleted_at IS NULL",
      )
      .get() as { id: string; text: string } | null;
  }

  setUserProfile(text: string): void {
    const existing = this.userProfile();
    if (!text) {
      this.db.query("UPDATE turn_memory_usage SET text = '' WHERE kind = 'profile'").run();
      this.db.query("DELETE FROM memories WHERE kind = 'profile'").run();
      return;
    }
    const now = Date.now();
    if (existing) {
      this.db
        .query("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?")
        .run(text, now, existing.id);
    } else {
      this.db
        .query(
          "INSERT INTO memories (id, agent_id, kind, text, created_at, updated_at) VALUES (?, NULL, 'profile', ?, ?, ?)",
        )
        .run(crypto.randomUUID(), text, now, now);
    }
  }

  recordUsage(turnId: string, items: MemoryUsageItem[]): void {
    this.db.transaction(() => {
      const insert = this.db.query(
        "INSERT OR IGNORE INTO turn_memory_usage (turn_id, memory_id, kind, text) VALUES (?, ?, ?, ?)",
      );
      for (const item of items) insert.run(turnId, item.id, item.kind, item.text);
    })();
  }

  usage(turnId: string): MemoryUsageResult {
    const items = this.db
      .query(
        "SELECT memory_id AS id, text, kind FROM turn_memory_usage WHERE turn_id = ? ORDER BY rowid",
      )
      .all(turnId) as MemoryUsageItem[];
    return { count: items.length, kinds: [...new Set(items.map((m) => m.kind))], items };
  }

  promptBlock(
    agentId: string,
    turnId?: string,
    includeAgent = true,
    includeProfile = true,
  ): string {
    const lines: string[] = [];
    const used: MemoryUsageItem[] = [];
    let total = 0;
    for (const m of includeAgent ? this.list(agentId).reverse() : []) {
      const line = `- [${m.id}] ${m.text}`;
      if (total + line.length > PROMPT_BUDGET && lines.length > 0) break;
      lines.unshift(line);
      used.unshift({ id: m.id, text: m.text, kind: "agent" });
      total += line.length + 1;
    }
    const profile = includeProfile ? this.userProfile() : null;
    if (profile) used.unshift({ ...profile, kind: "profile" });
    if (turnId) this.recordUsage(turnId, used);
    const userBlock = profile ? `<user_profile>\n${profile.text}\n</user_profile>\n\n` : "";
    return (
      userBlock +
      (lines.length === 0
        ? ""
        : `<agent_memories>\nThings you chose to remember earlier (manage them with the boto remember/forget tools):\n${lines.join("\n")}\n</agent_memories>\n\n`)
    );
  }
}
