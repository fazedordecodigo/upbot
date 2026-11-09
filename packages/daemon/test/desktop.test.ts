import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import type { ApprovalService } from "../src/approvals";
import { migrations } from "../src/db/migrations";
import { DesktopService, machineSlug } from "../src/desktop";
import { HostStore } from "../src/remote/hosts";

setDefaultTimeout(30000);

const FAKE_DESKTOP = join(import.meta.dir, "fixtures/fake-desktop-host.ts");

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    instructions: "",
    provider: "devin",
    workspacePath: `/tmp/${id}`,
  } as unknown as Agent;
}

describe("DesktopService (in-process, fake host stream)", () => {
  let db: Database;
  let hosts: HostStore;
  let desktop: DesktopService;
  const sent: { conn: string; event: string; data: unknown }[] = [];
  const machineEvents: unknown[] = [];
  const agents = new Map<string, Agent>([
    ["a1", agent("a1", "Código")],
    ["a2", agent("a2", "Código")],
    ["local", agent("local", "Local")],
  ]);
  const previous = process.env.BOTO_DESKTOP_COMMAND;

  beforeAll(() => {
    process.env.BOTO_DESKTOP_COMMAND = JSON.stringify(["bun", FAKE_DESKTOP]);
    db = new Database(":memory:");
    for (const sql of migrations) db.exec(sql);
    hosts = new HostStore(db);
    for (const id of ["a1", "a2"])
      db.query(
        "INSERT INTO agent_placement (agent_id, host_id, isolation, vcpus, mem_mib) VALUES (?, 'h1', 'firecracker', 2, 2048)",
      ).run(id);
    desktop = new DesktopService(
      db,
      hosts,
      (id) => agents.get(id) ?? null,
      (event, data) => machineEvents.push({ event, data }),
    );
    desktop.attach("c1", (event, data) => sent.push({ conn: "c1", event, data }));
    desktop.attach("c2", (event, data) => sent.push({ conn: "c2", event, data }));
  });

  afterAll(() => {
    desktop.stop();
    if (previous === undefined) delete process.env.BOTO_DESKTOP_COMMAND;
    else process.env.BOTO_DESKTOP_COMMAND = previous;
  });

  const until = async (pred: () => boolean, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await Bun.sleep(25);
    }
  };

  test("slugs are ascii, deterministic and numbered per agent", () => {
    expect(machineSlug("Código")).toBe("codigo");
    expect(machineSlug("  Ação & Reação!! ")).toBe("acao-reacao");
    expect(machineSlug("___")).toBe("maquina");
    const list = desktop.list();
    expect(list.map((m) => m.name).sort()).toEqual(["codigo-01", "codigo-02"]);
    expect(list.every((m) => m.status === "stopped" && m.controller === "agent")).toBe(true);
    expect(desktop.machineNameFor("a1")).toBe("codigo-01");
    expect(desktop.machineNameFor("local")).toBeUndefined();
    expect(desktop.remoteComputer("local")).toBeNull();
    expect(
      desktop
        .list()
        .map((m) => m.name)
        .sort(),
    ).toEqual(["codigo-01", "codigo-02"]);
  });

  test("releasing or detaching a desktop controller leaves browser takeover approvals pending", () => {
    const decisions: string[] = [];
    const service = new DesktopService(
      db,
      hosts,
      (id) => agents.get(id) ?? null,
      () => {},
    );
    service.approvals = {
      list: () => [{ id: "browser-login", kind: "takeover", status: "pending" }],
      respond: async ({ decision }: { decision: string }) => {
        decisions.push(decision);
      },
    } as unknown as ApprovalService;
    service.attach("owner", () => {});
    const machine = service.list()[0]!;
    try {
      service.takeover(machine.id, "owner");
      service.release(machine.id, "owner");
      service.takeover(machine.id, "owner");
      service.detach("owner");
      expect(decisions).toEqual([]);
    } finally {
      service.stop();
    }
  });

  test("agent computer actions reach the guest unless the user controls the machine", async () => {
    const m1 = desktop.list().find((m) => m.name === "codigo-01")!;
    const remote = desktop.remoteComputer("a1")!;
    const text = await remote.click(agents.get("a1")!, 40, 50, false);
    expect(text).toBe("pointer at (40, 50)");
    await until(() => desktop.list().find((m) => m.id === m1.id)?.status === "ready");
    expect(await remote.screenshot(agents.get("a1")!)).toContain(
      "/workspace/computer/screen-1.png",
    );
    await expect(remote.click(agents.get("a1")!, 1.5, 2, false)).rejects.toThrow(/integers/);
    await expect(remote.key(agents.get("a1")!, "c", ["ctrl", "x;rm"])).rejects.toThrow(/keysym/);

    expect(() => desktop.input(m1.id, "c1", [{ type: "mouse_move", x: 1, y: 1 }])).toThrow(
      /take over/,
    );
    desktop.takeover(m1.id, "c1");
    expect(desktop.list().find((m) => m.id === m1.id)?.controller).toBe("user");
    await expect(remote.click(agents.get("a1")!, 1, 1, false)).rejects.toThrow(/taken control/);
    await expect(remote.type(agents.get("a1")!, "x")).rejects.toThrow(/taken control/);
    expect(desktop.input(m1.id, "c1", [{ type: "mouse_move", x: 2, y: 3 }])).toEqual({ ok: true });
    expect(() => desktop.input(m1.id, "c2", [{ type: "mouse_move", x: 2, y: 3 }])).toThrow(
      /take over/,
    );
    expect(() => desktop.takeover(m1.id, "c2")).toThrow(/another window/);
    expect(() => desktop.release(m1.id, "c2")).toThrow(/another window/);
    desktop.release(m1.id, "c1");
    expect(desktop.list().find((m) => m.id === m1.id)?.controller).toBe("agent");
    expect(await remote.click(agents.get("a1")!, 7, 8, false)).toBe("pointer at (7, 8)");
    expect(
      machineEvents.filter((e) => (e as { event: string }).event === "desktop.machine").length,
    ).toBeGreaterThan(0);
  });

  test("frames and cursor events reach only the subscribers of that machine", async () => {
    const m1 = desktop.list().find((m) => m.name === "codigo-01")!;
    const m2 = desktop.list().find((m) => m.name === "codigo-02")!;
    sent.length = 0;
    desktop.subscribe(m1.id, "c1");
    desktop.subscribe(m2.id, "c2");
    await until(
      () =>
        sent.filter((s) => s.conn === "c1" && s.event === "desktop.frame").length >= 3 &&
        sent.filter((s) => s.conn === "c2" && s.event === "desktop.frame").length >= 3,
    );
    for (const s of sent) {
      const machineId = (s.data as { machineId: string }).machineId;
      expect(machineId).toBe(s.conn === "c1" ? m1.id : m2.id);
    }
    await desktop.remoteComputer("a1")!.click(agents.get("a1")!, 9, 9, false);
    await until(() => sent.some((s) => s.event === "desktop.cursor"));
    const cursors = sent.filter((s) => s.event === "desktop.cursor");
    expect(cursors.every((s) => s.conn === "c1")).toBe(true);
    expect(cursors[0]!.data).toMatchObject({ machineId: m1.id, x: 9, y: 9, kind: "click" });
    const thumb = await desktop.thumbnail(m2.id);
    expect(thumb.mime).toBe("image/jpeg");
    expect(thumb.dataBase64.length).toBeGreaterThan(0);

    desktop.unsubscribe(m1.id, "c1");
    const c1Frames = () =>
      sent.filter((s) => s.conn === "c1" && s.event === "desktop.frame").length;
    await Bun.sleep(300);
    const after = c1Frames();
    await Bun.sleep(400);
    expect(c1Frames()).toBe(after);

    desktop.takeover(m2.id, "c2");
    desktop.detach("c2");
    expect(desktop.list().find((m) => m.id === m2.id)?.controller).toBe("agent");
  });

  test("the stream stops once the agent is idle and nobody is watching", async () => {
    const m1 = desktop.list().find((m) => m.name === "codigo-01")!;
    sent.length = 0;
    desktop.subscribe(m1.id, "c1");
    await until(
      () => sent.filter((s) => s.conn === "c1" && s.event === "desktop.frame").length >= 2,
    );
    desktop.onAgentStatus({ agentId: "a1", status: "idle" });
    const before = sent.filter((s) => s.event === "desktop.frame").length;
    await until(() => sent.filter((s) => s.event === "desktop.frame").length > before + 1);
    expect(desktop.list().find((m) => m.id === m1.id)?.status).toBe("ready");
    machineEvents.length = 0;
    desktop.unsubscribe(m1.id, "c1");
    await until(() =>
      machineEvents.some(
        (e) =>
          (e as { data: { id: string; status: string } }).data.id === m1.id &&
          (e as { data: { status: string } }).data.status === "stopped",
      ),
    );
    expect(desktop.list().find((m) => m.id === m1.id)?.status).toBe("stopped");
    // a busy agent keeps its stream alive after the last viewer leaves
    const m2 = desktop.list().find((m) => m.name === "codigo-02")!;
    desktop.onAgentStatus({ agentId: "a2", status: "running" });
    desktop.subscribe(m2.id, "c1");
    await until(() => desktop.list().find((m) => m.id === m2.id)?.status === "ready");
    desktop.unsubscribe(m2.id, "c1");
    expect(desktop.list().find((m) => m.id === m2.id)?.status).toBe("ready");
    desktop.onAgentStatus({ agentId: "a2", status: "idle" });
    await until(() => desktop.list().find((m) => m.id === m2.id)?.status === "stopped");
  });

  test("rejects unknown machines", () => {
    expect(() => desktop.subscribe("nope", "c1")).toThrow(/machine not found/);
    expect(() => desktop.takeover("nope", "c1")).toThrow(/machine not found/);
  });
});
