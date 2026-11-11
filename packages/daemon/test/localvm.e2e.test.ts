import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, LocalVmStatus, RemoteHost } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  lastAgentText,
  sendAndWait,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

setDefaultTimeout(30_000);

const TOKEN = `localvm-test-${crypto.randomUUID()}`;
const FAKE_SSH = join(import.meta.dir, "fixtures/fake-ssh.ts");
const FAKE_LIMA = join(import.meta.dir, "fixtures/fake-limactl.ts");

describe.skipIf(process.platform === "win32")("local VM (Lima) e2e", () => {
  let dataDir: string;
  let stateDir: string;
  let sshHome: string;
  let sshLog: string;
  let limaHome: string;
  let limaLog: string;
  let marker: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let bot: Agent;
  let vm: LocalVmStatus;
  let host: RemoteHost;

  const sshCalls = () =>
    (existsSync(sshLog) ? readFileSync(sshLog, "utf8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            opts: string[];
            target: string;
            remoteCmd: string;
            leakedEnv: string[];
          },
      );
  const waitStatus = async (pred: (s: LocalVmStatus) => boolean, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = (await c.request("localvm.status", {})) as LocalVmStatus;
      if (pred(s)) return s;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for status: ${JSON.stringify(s)}`);
      await Bun.sleep(150);
    }
  };

  beforeAll(async () => {
    dataDir = tmp("lv-data-");
    stateDir = tmp("lv-fake-");
    sshHome = tmp("lv-guest-");
    sshLog = join(tmp("lv-log-"), "ssh.jsonl");
    limaHome = tmp("lv-lima-");
    limaLog = join(limaHome, "lima.jsonl");
    marker = join(sshHome, "provisioned");
    daemon = await startDaemon(dataDir, tmp("lv-agents-"), TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      BOTO_SSH_COMMAND: JSON.stringify(["bun", FAKE_SSH]),
      BOTO_LIMA_COMMAND: JSON.stringify(["bun", FAKE_LIMA]),
      BOTO_LIMA_INSTANCE: "boto-test",
      BOTO_VM_READY_FILE: marker,
      BOTO_VM_READY_TIMEOUT_MS: "4000",
      BOTO_VM_READY_POLL_MS: "100",
      FAKE_ACP_STATE_DIR: stateDir,
      FAKE_SSH_HOME: sshHome,
      FAKE_SSH_LOG: sshLog,
      FAKE_LIMA_HOME: limaHome,
      FAKE_LIMA_LOG: limaLog,
      FAKE_LIMA_SSH_ADDRESS: "10.203.0.17",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    bot = await c.request("agents.create", { name: "Vera", provider: "devin", instructions: "" });
  });

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
  });

  test("status reports an absent VM before create", async () => {
    vm = await c.request("localvm.status", {});
    expect(vm.available).toBe(true);
    expect(vm.name).toBe("boto-test");
    expect(vm.state).toBe("absent");
    expect(vm.hostId).toBeNull();
  });

  test("create registers the VM host", async () => {
    vm = await c.request("localvm.create", {});
    expect(vm.state).toBe("stopped");
    expect(vm.hostId).toBeTruthy();
    host = (await c.request("hosts.list", {})).find((h) => h.id === vm.hostId)!;
    expect(host.kind).toBe("localvm");
    // wsl2 instances report a distro IP as sshAddress; vz/qemu report 127.0.0.1
    expect(host.target).toBe("lima@10.203.0.17");
    expect(host.port).toBeGreaterThan(0);
    // materialized under the daemon data dir and the shared home dirs
    expect(existsSync(join(dataDir, "vm", "boto-test.yaml"))).toBe(true);
  });

  test("install refuses to run before provisioning finishes", async () => {
    vm = await c.request("localvm.start", {});
    expect(vm.state).toBe("running");
    // The marker isn't written yet: prepare() polls it in the background and gives
    // up; a manual helper install must fail the same way, since an installed helper
    // would accept runs while the provider CLIs are still missing.
    vm = await waitStatus((s) => s.busy === null && s.detail !== null);
    await expect(c.request("localvm.install", {})).rejects.toThrow("preparar");
    const h = (await c.request("hosts.list", {})).find((x) => x.id === vm.hostId);
    expect(h?.root ?? null).toBeNull();
  });

  test("start runs provisioning wait then installs the helper", async () => {
    writeFileSync(marker, "ready");
    vm = await c.request("localvm.start", {});
    expect(vm.state).toBe("running");
    vm = await waitStatus((s) => s.installed);
    host = (await c.request("hosts.list", {})).find((h) => h.id === vm.hostId)!;
    expect(host.root).toBe(join(sshHome, ".boto"));
    expect(host.preflight?.firecrackerReady).toBe(false);
  });

  test("stop and restart keep the host row", async () => {
    await c.request("localvm.stop", {});
    vm = await c.request("localvm.status", {});
    expect(vm.state).toBe("stopped");
    expect(vm.hostId).toBe(host.id);
    await c.request("localvm.start", {});
    vm = await waitStatus((s) => s.state === "running" && s.installed);
  });

  test("placing a bot on the VM runs the provider inside it and shows a machine", async () => {
    const p = await c.request("placements.set", {
      agentId: bot.id,
      hostId: host.id,
      isolation: "none",
    });
    expect(p.hostId).toBe(host.id);
    const machines = await c.request("desktop.machines", {});
    expect(machines.some((m) => m.agentId === bot.id)).toBe(true);
    expect((await sendAndWait(c, bot.id, "echo:hello-vm")).status).toBe("completed");
    expect(await lastAgentText(c, bot.id)).toBe("hello-vm");
    expect(existsSync(join(sshHome, ".boto/agents", bot.id))).toBe(true);
    const run = sshCalls().find((l) => l.remoteCmd.includes(" run"))!;
    expect(run.opts).toContain("-R");
  }, 30000);

  test("desktop subscribe talks to guest-desktop inside the VM", async () => {
    const machines = await c.request("desktop.machines", {});
    const machine = machines.find((m) => m.agentId === bot.id)!;
    await c.request("desktop.subscribe", { machineId: machine.id });
    const deadline = Date.now() + 8000;
    for (;;) {
      const call = sshCalls().find((l) => l.remoteCmd.includes("guest-desktop"));
      if (call) {
        expect(call.remoteCmd).toContain("DISPLAY=:0");
        return;
      }
      if (Date.now() > deadline) throw new Error("guest-desktop was never spawned");
      await Bun.sleep(150);
    }
  });

  test("delete removes the instance, the host row and the placement", async () => {
    await c.request("localvm.delete", {});
    vm = await c.request("localvm.status", {});
    expect(vm.state).toBe("absent");
    expect(vm.hostId).toBeNull();
    expect((await c.request("hosts.list", {})).some((h) => h.kind === "localvm")).toBe(false);
    const placements = await c.request("placements.list", {});
    expect(placements.find((p) => p.agentId === bot.id)?.hostId ?? null).toBeNull();
  });
});
