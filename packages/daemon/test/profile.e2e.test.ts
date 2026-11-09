import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Agent, ProfileDefaults, Turn } from "@boto/protocol";
import { ChatItem, Profile } from "@boto/protocol";
import { openDatabase } from "../src/db";
import { migrations } from "../src/db/migrations";
import { getProfileDefaults } from "../src/db/settings";
import { MemoryStore } from "../src/memories";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  removeDir,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const defaults: ProfileDefaults = {
  private: false,
  requireApproval: true,
  delegationMode: "now",
  toolMode: "both",
};

describe("profile and memory provenance e2e", () => {
  const token = `profile-${crypto.randomUUID()}`;
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let sharedRoot: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let peer: DaemonClient;

  async function change(
    method: "profile.update" | "profile.forget" | "onboarding.complete" | "onboarding.reset",
    params: unknown = {},
  ) {
    const event = peer.waitForEvent("profile.changed");
    const result = Profile.parse(await c.request(method, params));
    expect(await event).toEqual(result);
    expect(Profile.safeParse(result).success).toBe(true);
    return Profile.parse(result);
  }

  async function turn(agent: Agent, text: string): Promise<Turn> {
    const { queueId } = await c.request("chat.send", { agentId: agent.id, text });
    const ended = await c.waitForEventWhere("turn.ended", (t) => t.queueId === queueId, 30000);
    expect(ended.status).toBe("completed");
    return ended;
  }

  function lastPrompt(): string {
    const request = readLog(stateDir)
      .filter((r) => r.method === "session/prompt")
      .at(-1);
    if (!request) throw new Error("expected a recorded session prompt");
    return (request.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "";
  }

  beforeAll(async () => {
    dataDir = tmp("profile-data-");
    agentsRoot = tmp("profile-agents-");
    stateDir = tmp("profile-fake-");
    sharedRoot = tmp("profile-shared-");
    daemon = await startDaemon(dataDir, agentsRoot, token, {
      BOTO_DEFAULT_BOT: "off",
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_SHARED_ROOT: sharedRoot,
    });
    c = await DaemonClient.connect(daemon.port, token);
    peer = await DaemonClient.connect(daemon.port, token);
  }, 30000);

  afterAll(async () => {
    c?.close();
    peer?.close();
    if (daemon) {
      daemon.proc.kill("SIGKILL");
      await daemon.proc.exited;
    }
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir, sharedRoot]) if (dir) await removeDir(dir);
  }, 30000);

  test("returns real unset defaults and validates the stored defaults helper", async () => {
    expect(await c.request("profile.get", {})).toEqual({
      name: "",
      about: "",
      onboardingCompletedAt: null,
      defaults,
      theme: null,
      sidebarWidth: null,
    });
    const db = openDatabase(dataDir);
    try {
      expect(getProfileDefaults(db)).toEqual(defaults);
    } finally {
      db.close();
    }
    await expect(c.request("profile.get", { unknown: true })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(c.request("memories.usage", { turnId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      ChatItem.safeParse({
        id: "legacy",
        seq: 1,
        agentId: "a",
        turnId: null,
        kind: "agent_message",
        text: "old",
        createdAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(true);
  }, 30000);

  test("profile defaults drive new tasks while explicit task settings win", async () => {
    const agent = await c.request("agents.create", { name: "Defaults", provider: "devin" });
    await c.request("queue.pause", { agentId: agent.id });
    try {
      await change("profile.update", {
        defaults: { private: true, toolMode: "browser", requireApproval: true },
      });
      const inherited = await c.request("tasks.create", {
        agentId: agent.id,
        text: "echo:defaults",
      });
      expect(inherited).toMatchObject({
        private: true,
        toolMode: "browser",
        requireApproval: true,
      });
      const explicit = await c.request("tasks.create", {
        agentId: agent.id,
        text: "echo:override",
        private: false,
        toolMode: "terminal",
        requireApproval: false,
      });
      expect(explicit).toMatchObject({
        private: false,
        toolMode: "terminal",
        requireApproval: false,
      });
      await c.request("tasks.stop", { id: inherited.id });
      await c.request("tasks.stop", { id: explicit.id });
    } finally {
      await change("profile.update", { defaults });
      await c.request("agents.delete", { id: agent.id });
    }
  }, 30000);

  test("enforces 40/600 limits, strict nested partial updates and every preference boundary", async () => {
    const atLimit = await change("profile.update", {
      name: "n".repeat(40),
      about: "a".repeat(600),
      defaults: { private: true },
      theme: "light",
      sidebarWidth: 220,
    });
    expect(atLimit.defaults).toEqual({ ...defaults, private: true });
    for (const params of [
      { name: "n".repeat(41) },
      { about: "a".repeat(601) },
      { extra: true },
      { defaults: { extra: true } },
      { defaults: { private: "true" } },
      { defaults: { requireApproval: "true" } },
      { defaults: { delegationMode: "routine" } },
      { defaults: { toolMode: "shell" } },
      { theme: "system" },
      { sidebarWidth: 219 },
      { sidebarWidth: 401 },
      { onboardingCompletedAt: -1 },
    ])
      await expect(c.request("profile.update", params)).rejects.toMatchObject({
        code: "bad_request",
      });
    expect(await c.request("profile.get", {})).toEqual(atLimit);
    for (const delegationMode of ["now", "scheduled", "approval"] as const) {
      expect(
        (await change("profile.update", { defaults: { delegationMode } })).defaults.delegationMode,
      ).toBe(delegationMode);
    }
    for (const toolMode of ["both", "browser", "terminal"] as const) {
      expect((await change("profile.update", { defaults: { toolMode } })).defaults.toolMode).toBe(
        toolMode,
      );
    }
    expect(
      (await change("profile.update", { sidebarWidth: 400, theme: "dark" })).sidebarWidth,
    ).toBe(400);
    const db = openDatabase(dataDir);
    try {
      expect(getProfileDefaults(db)).toMatchObject({
        private: true,
        delegationMode: "approval",
        toolMode: "terminal",
      });
      expect(new MemoryStore(db).userProfile()?.text).toHaveLength(600);
    } finally {
      db.close();
    }
  }, 30000);

  test("completes and reopens onboarding without losing preferences", async () => {
    const before = await c.request("profile.get", {});
    const completed = await change("onboarding.complete");
    expect(completed.onboardingCompletedAt).toBeGreaterThan(0);
    expect((await change("onboarding.complete")).onboardingCompletedAt).toBe(
      completed.onboardingCompletedAt,
    );
    expect(await change("onboarding.reset")).toEqual({ ...before, onboardingCompletedAt: null });
    await expect(c.request("onboarding.complete", { ignored: true })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(c.request("onboarding.reset", { ignored: true })).rejects.toMatchObject({
      code: "bad_request",
    });
  }, 30000);

  test("injects user memory for two agents, isolates agent memories and records exact per-turn usage", async () => {
    await change("profile.update", { name: "Emerson", about: "Prefiro respostas em português." });
    const a = await c.request("agents.create", { name: "Profile A", provider: "devin" });
    const b = await c.request("agents.create", { name: "Profile B", provider: "devin" });
    const ma = await c.request("memories.add", { agentId: a.id, text: "Only A knows amber." });
    const mb = await c.request("memories.add", { agentId: b.id, text: "Only B knows violet." });
    await c.request("skills.save", {
      name: "profile-skill",
      description: "Shared skill",
      body: "Useful steps",
    });
    const db = openDatabase(dataDir);
    const profileId = new MemoryStore(db).userProfile()?.id ?? "";
    db.close();
    await expect(
      c.request("memories.update", { id: profileId, text: "overwrite profile" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(c.request("memories.delete", { id: profileId })).rejects.toMatchObject({
      code: "not_found",
    });

    for (const [agent, own, other] of [
      [a, ma, mb],
      [b, mb, ma],
    ] as const) {
      const ended = await turn(agent, "echo:profile ready");
      const prompt = lastPrompt();
      expect(prompt).toContain("<user_profile>\nPrefiro respostas em português.\n</user_profile>");
      expect(prompt).toContain(own.text);
      expect(prompt).not.toContain(other.text);
      const usage = await c.request("memories.usage", { turnId: ended.id });
      expect(usage).toEqual({
        count: 3,
        kinds: ["profile", "agent", "skill"],
        items: [
          { id: profileId, text: "Prefiro respostas em português.", kind: "profile" },
          { id: own.id, text: own.text, kind: "agent" },
          { id: "profile-skill", text: "profile-skill: Shared skill", kind: "skill" },
        ],
      });
      const { items } = await c.request("chat.history", { agentId: agent.id });
      const response = items.find((i) => i.turnId === ended.id && i.kind === "agent_message");
      expect(response).toMatchObject({
        text: "profile ready",
        memoryUsage: { count: 3, kinds: usage.kinds },
      });
      const created = c.events.find(
        (e) => e.event === "item.created" && (e.data as { id: string }).id === response?.id,
      )?.data;
      expect(created).toMatchObject({ memoryUsage: { count: 3, kinds: usage.kinds } });
    }

    await change("profile.update", { about: "Agora prefiro respostas curtas." });
    const next = await turn(a, "echo:updated");
    expect(lastPrompt()).toContain("<user_profile>\nAgora prefiro respostas curtas.");
    expect(lastPrompt()).not.toContain("<agent_memories>");
    expect(await c.request("memories.usage", { turnId: next.id })).toEqual({
      count: 1,
      kinds: ["profile"],
      items: [{ id: profileId, text: "Agora prefiro respostas curtas.", kind: "profile" }],
    });

    const before = await c.request("profile.get", {});
    const forgotten = await change("profile.forget");
    expect(forgotten).toEqual({ ...before, name: "", about: "" });
    expect(await c.request("memories.usage", { turnId: next.id })).toEqual({
      count: 1,
      kinds: ["profile"],
      items: [{ id: profileId, text: "", kind: "profile" }],
    });
    expect(await c.request("memories.list", { agentId: a.id })).toEqual([ma]);
    const empty = await turn(a, "echo:forgotten");
    expect(lastPrompt()).not.toContain("<user_profile>");
    expect(await c.request("memories.usage", { turnId: empty.id })).toEqual({
      count: 0,
      kinds: [],
      items: [],
    });
    await expect(c.request("profile.forget", { unknown: true })).rejects.toMatchObject({
      code: "bad_request",
    });

    await change("profile.update", { about: "Perfil para sessão retomada." });
    await c.request("agents.setConfig", { agentId: a.id, configId: "mode", value: "ask-all" });
    const resumed = await turn(a, "echo:resumed");
    expect(lastPrompt()).toContain("<user_profile>\nPerfil para sessão retomada.");
    expect((await c.request("memories.usage", { turnId: resumed.id })).kinds).toContain("profile");
    await c.request("agents.newSession", { agentId: b.id });
    const fresh = await turn(b, "echo:fresh");
    expect(lastPrompt()).toContain(mb.text);
    expect(lastPrompt()).not.toContain(ma.text);
    expect((await c.request("memories.usage", { turnId: fresh.id })).count).toBe(3);
  }, 60000);
});

test("profile migration preserves existing live and deleted agent memories", async () => {
  const dir = tmp("profile-migrate-");
  const legacy = new Database(join(dir, "boto.db"));
  try {
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const [i, sql] of migrations.slice(0, 22).entries()) {
      legacy.exec(sql);
      legacy.query("INSERT INTO schema_migrations VALUES (?, 1)").run(i + 1);
    }
    legacy.exec(
      "INSERT INTO agents (id, name, provider, workspace_path, created_at, updated_at) VALUES ('a', 'A', 'devin', '/a', 1, 1)",
    );
    legacy.exec(
      "INSERT INTO memories VALUES ('old', 'a', 'keep', 1, 2, NULL), ('deleted', 'a', 'gone', 1, 2, 3)",
    );
  } finally {
    legacy.close();
  }
  try {
    const db = openDatabase(dir);
    try {
      expect(new MemoryStore(db).list("a")).toEqual([
        { id: "old", agentId: "a", text: "keep", createdAt: 1, updatedAt: 2 },
      ]);
      expect(db.query("SELECT kind, deleted_at FROM memories WHERE id = 'deleted'").get()).toEqual({
        kind: "agent",
        deleted_at: 3,
      });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await removeDir(dir);
  }
}, 30000);
