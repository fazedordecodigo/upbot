import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Machine, RemoteHost } from "@boto/protocol";
import { DaemonClient, startDaemon, stopDaemon, tmp } from "./helpers";

setDefaultTimeout(30000);

const TOKEN = "desktop-token";
const FAKE_SSH = join(import.meta.dir, "fixtures/fake-ssh.ts");
const FAKE_DESKTOP = join(import.meta.dir, "fixtures/fake-desktop-host.ts");
const READY_HELPER = join(import.meta.dir, "fixtures/fake-boto-host-ready.ts");

describe("desktop.* (daemon e2e with a fake host desktop stream)", () => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  let c: DaemonClient;
  let c2: DaemonClient;
  let sshHome: string;
  let desktopLog: string;
  let exitFile: string;
  let a1: Agent;
  let a2: Agent;
  let host: RemoteHost;
  let m1: Machine;
  let m2: Machine;

  const logEntries = () =>
    existsSync(desktopLog)
      ? readFileSync(desktopLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  beforeAll(async () => {
    sshHome = tmp("desk-home-");
    desktopLog = join(tmp("desk-log-"), "desktop.jsonl");
    exitFile = join(tmp("desk-exit-"), "vm-gone");
    daemon = await startDaemon(tmp("desk-data-"), tmp("desk-agents-"), TOKEN, {
      BOTO_SSH_COMMAND: JSON.stringify(["bun", FAKE_SSH]),
      BOTO_DESKTOP_COMMAND: JSON.stringify(["bun", FAKE_DESKTOP]),
      FAKE_SSH_HOME: sshHome,
      FAKE_DESKTOP_LOG: desktopLog,
      FAKE_DESKTOP_EXIT_FILE: exitFile,
      XDG_SESSION_TYPE: "wayland",
      DISPLAY: "",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    c2 = await DaemonClient.connect(daemon.port, TOKEN);
    a1 = await c.request("agents.create", { name: "Código", provider: "devin", instructions: "" });
    a2 = await c.request("agents.create", { name: "Código", provider: "devin", instructions: "" });
    host = await c.request("hosts.create", { name: "vps", target: "bob@vps.example.com" });
    host = await c.request("hosts.install", { id: host.id });
    // the fake host reports a Firecracker-ready preflight so placements accept isolation "firecracker"
    copyFileSync(READY_HELPER, join(sshHome, ".boto/bin/boto-host.ts"));
    host = await c.request("hosts.check", { id: host.id });
    expect(host.preflight?.firecrackerReady).toBe(true);
    for (const a of [a1, a2])
      await c.request("placements.set", {
        agentId: a.id,
        hostId: host.id,
        isolation: "firecracker",
      });
  });

  afterAll(async () => {
    c2.close();
    await stopDaemon(daemon, c, undefined);
    rmSync(sshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("desktop.machines lists one named machine per microVM agent", async () => {
    expect(await c.request("computer.access", { agentId: a1.id })).toMatchObject({
      available: true,
    });
    if (process.platform === "linux")
      expect(await c.request("computer.access", {})).toMatchObject({ available: false });
    const machines = await c.request("desktop.machines", {});
    expect(machines.map((m) => m.name).sort()).toEqual(["codigo-01", "codigo-02"]);
    m1 = machines.find((m) => m.agentId === a1.id)!;
    m2 = machines.find((m) => m.agentId === a2.id)!;
    expect(m1).toMatchObject({
      hostId: host.id,
      status: "stopped",
      controller: "agent",
      taskId: null,
      thumbnailAt: null,
    });
    const again = await c.request("desktop.machines", {});
    expect(again.find((m) => m.agentId === a1.id)?.id).toBe(m1.id);
    const overview = await c.request("agents.overview", {});
    expect(overview.agents.find((a) => a.agentId === a1.id)?.machines).toEqual([m1.id]);
    expect(overview.agents.find((a) => a.agentId === a2.id)?.machines).toEqual([m2.id]);
  });

  test("subscribe streams frames only to the subscribed connection and machine", async () => {
    const machine = await c.request("desktop.subscribe", { machineId: m1.id });
    expect(machine.id).toBe(m1.id);
    const ready = await c.waitForEventWhere(
      "desktop.machine",
      (d) => d.id === m1.id && d.status === "ready",
      15000,
    );
    expect(ready).toMatchObject({ width: 1280, height: 800, name: m1.name });
    const frame = await c.waitForEventWhere("desktop.frame", (d) => d.machineId === m1.id, 15000);
    expect(frame).toMatchObject({ machineId: m1.id, mime: "image/jpeg", width: 1280, height: 800 });
    expect(typeof frame.dataBase64).toBe("string");
    await c2.request("desktop.subscribe", { machineId: m2.id });
    await c2.waitForEventWhere("desktop.frame", (d) => d.machineId === m2.id, 15000);
    await Bun.sleep(500);
    const frameIds = (client: DaemonClient) =>
      client.events
        .filter((e) => e.event === "desktop.frame")
        .map((e) => (e.data as { machineId: string }).machineId);
    expect(frameIds(c2).length).toBeGreaterThan(0);
    expect(frameIds(c2).every((id) => id === m2.id)).toBe(true);
    expect(frameIds(c).every((id) => id === m1.id)).toBe(true);
    const thumb = await c.request("desktop.thumbnail", { machineId: m1.id });
    expect(thumb.mime).toBe("image/jpeg");
    expect(thumb.dataBase64.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(thumb.at))).toBe(false);
    expect((await c.request("desktop.machines", {})).find((m) => m.id === m1.id)?.thumbnailAt).toBe(
      thumb.at,
    );
  });

  test("input is rejected without a takeover and accepted only from the owner", async () => {
    const events = [{ type: "mouse_move" as const, x: 10, y: 20 }];
    await expect(c.request("desktop.input", { machineId: m1.id, events })).rejects.toThrow(
      /take over/,
    );
    await expect(
      c.request("desktop.input", {
        machineId: m1.id,
        events: [{ type: "click", x: 1, y: 1 }] as never,
      }),
    ).rejects.toThrow();
    await expect(c.request("desktop.input", { machineId: m1.id, events: [] })).rejects.toThrow();
    const taken = await c.request("desktop.takeover", { machineId: m1.id });
    expect(taken.controller).toBe("user");
    await c2.waitForEventWhere(
      "desktop.machine",
      (d) => d.id === m1.id && d.controller === "user",
      10000,
    );
    await expect(c2.request("desktop.takeover", { machineId: m1.id })).rejects.toThrow(
      /another window/,
    );
    await expect(c2.request("desktop.input", { machineId: m1.id, events })).rejects.toThrow(
      /take over/,
    );
    expect(await c.request("desktop.input", { machineId: m1.id, events })).toEqual({ ok: true });
    const deadline = Date.now() + 10000;
    while (
      !logEntries().some((e) => e.event === "input" && e.source === "user") &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    const accepted = logEntries().filter((e) => e.event === "input");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ agentId: a1.id, source: "user", events });
    expect(logEntries().some((e) => e.event === "controller" && e.controller === "user")).toBe(
      true,
    );
    const released = await c.request("desktop.release", { machineId: m1.id });
    expect(released.controller).toBe("agent");
    await expect(c.request("desktop.input", { machineId: m1.id, events })).rejects.toThrow(
      /take over/,
    );
  });

  test("closing the owner's connection hands the machine back to the agent", async () => {
    const taken = await c2.request("desktop.takeover", { machineId: m2.id });
    expect(taken.controller).toBe("user");
    c2.close();
    const back = await c.waitForEventWhere(
      "desktop.machine",
      (d) => d.id === m2.id && d.controller === "agent",
      10000,
    );
    expect(back.controller).toBe("agent");
    await expect(c.request("desktop.unsubscribe", { machineId: m1.id })).resolves.toEqual({
      ok: true,
    });
    await expect(c.request("desktop.subscribe", { machineId: "nope" })).rejects.toThrow(
      /machine not found/,
    );
  });

  test("placement RPC reconnects viewers on a different host and closes local transfers", async () => {
    const created = await c.request("hosts.create", {
      name: "second",
      target: "bob@second.example.com",
    });
    await c.request("hosts.install", { id: created.id });
    copyFileSync(READY_HELPER, join(sshHome, ".boto/bin/boto-host.ts"));
    await c.request("hosts.check", { id: created.id });
    const machine = (await c.request("desktop.machines", {})).find((m) => m.agentId === a2.id)!;
    await c.request("desktop.subscribe", { machineId: machine.id });
    await c.request("desktop.thumbnail", { machineId: machine.id });
    const mark = c.events.length;
    await c.request("placements.set", {
      agentId: a2.id,
      hostId: created.id,
      isolation: "firecracker",
    });
    expect(
      c.events
        .slice(mark)
        .some(
          (event) =>
            event.event === "desktop.machine" && (event.data as Machine).hostId === created.id,
        ),
    ).toBe(true);
    expect((await c.request("desktop.machines", {})).find((m) => m.id === machine.id)?.hostId).toBe(
      created.id,
    );
    await c.request("desktop.thumbnail", { machineId: machine.id });
    await c.request("placements.set", { agentId: a2.id, hostId: null, isolation: "none" });
    expect((await c.request("desktop.machines", {})).some((m) => m.id === machine.id)).toBe(false);
    await expect(c.request("desktop.thumbnail", { machineId: machine.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("placement RPC reconnects an existing subscriber on the same host without another subscribe", async () => {
    const agent = await c.request("agents.create", { name: "Same host", provider: "devin" });
    const placement = { agentId: agent.id, hostId: host.id, isolation: "firecracker" as const };
    await c.request("placements.set", placement);
    const viewer = await DaemonClient.connect(daemon.port, TOKEN);
    try {
      const machine = (await viewer.request("desktop.machines", {})).find(
        (m) => m.agentId === agent.id,
      )!;
      await viewer.request("desktop.subscribe", { machineId: machine.id });
      await viewer.waitForEventWhere(
        "desktop.machine",
        (m) => m.id === machine.id && m.status === "ready",
        10000,
      );
      await viewer.waitForEventWhere(
        "desktop.frame",
        (frame) => frame.machineId === machine.id,
        10000,
      );
      await c.request("placements.set", { ...placement, isolation: "none" });
      expect(
        await viewer.waitForEventWhere(
          "desktop.machine",
          (m) => m.id === machine.id && m.status === "stopped",
          10000,
        ),
      ).toMatchObject({ hostId: host.id, width: 0, height: 0, thumbnailAt: null });
      await c.request("placements.set", placement);
      expect(
        await viewer.waitForEventWhere(
          "desktop.machine",
          (m) => m.id === machine.id && m.status === "ready",
          10000,
        ),
      ).toMatchObject({ hostId: host.id, width: 1280, height: 800 });
      expect(
        await viewer.waitForEventWhere(
          "desktop.frame",
          (frame) => frame.machineId === machine.id,
          10000,
        ),
      ).toMatchObject({ width: 1280, height: 800 });
      expect(
        logEntries().filter((entry) => entry.agentId === agent.id && entry.event === "connected"),
      ).toHaveLength(2);
    } finally {
      viewer.close();
    }
  });

  test("a stream that ends under a viewer comes back once the guest is reachable again", async () => {
    // a new turn replaces the agent's microVM: the host desktop stream ends while the task
    // view is still subscribed, so the daemon must attach to the new guest on its own
    const viewer = await DaemonClient.connect(daemon.port, TOKEN);
    try {
      await viewer.request("desktop.subscribe", { machineId: m1.id });
      await viewer.waitForEventWhere(
        "desktop.machine",
        (d) => d.id === m1.id && d.status === "ready",
        15000,
      );
      writeFileSync(exitFile, "");
      const gone = await viewer.waitForEventWhere(
        "desktop.machine",
        (d) => d.id === m1.id && d.status === "stopped",
        10000,
      );
      expect(gone.status).toBe("stopped");
      rmSync(exitFile, { force: true });
      const back = await viewer.waitForEventWhere(
        "desktop.machine",
        (d) => d.id === m1.id && d.status === "ready",
        15000,
      );
      expect(back).toMatchObject({ id: m1.id, status: "ready", controller: "agent" });
      await viewer.waitForEventWhere("desktop.frame", (d) => d.machineId === m1.id, 15000);
      expect(logEntries().filter((e) => e.event === "vm_gone").length).toBe(1);
      // without a viewer or a running agent the stream stays closed
      await viewer.request("desktop.unsubscribe", { machineId: m1.id });
      await viewer.waitForEventWhere(
        "desktop.machine",
        (d) => d.id === m1.id && d.status === "stopped",
        10000,
      );
      const mark = viewer.events.length;
      await Bun.sleep(6000);
      expect(
        viewer.events
          .slice(mark)
          .filter((e) => e.event === "desktop.machine" && (e.data as Machine).status !== "stopped"),
      ).toEqual([]);
      expect(
        (await viewer.request("desktop.machines", {})).find((m) => m.id === m1.id)?.status,
      ).toBe("stopped");
    } finally {
      viewer.close();
    }
  });
});
