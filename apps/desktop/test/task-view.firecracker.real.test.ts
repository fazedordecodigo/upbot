// The task view against a real Firecracker guest: the agent (fake ACP inside the microVM)
// uses the machine through the bridge, the user takes over with real mouse/keyboard input,
// the agent's hand-over request is answered from the card, Início lists the streaming
// machine, the stream survives a replaced microVM and stops once nobody needs it.
// Needs `bash packages/host/rootfs/build-rootfs.sh`, /dev/kvm access and a local sshd:
//   BOTO_REAL_FIRECRACKER=1 bun test apps/desktop/test/task-view.firecracker.real.test.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Machine } from "@boto/protocol";
import { chromium, type Page } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
import {
  makeFirecrackerHostRoot,
  removeFirecrackerHostRoot,
} from "../../../packages/host/test/firecracker-fixtures";
import { startVite } from "./vite";

const artifacts = resolve(process.env.BOTO_FC_ARTIFACTS ?? join(homedir(), ".boto/firecracker"));
const enabled =
  process.env.BOTO_REAL_FIRECRACKER === "1" &&
  existsSync("/usr/sbin/sshd") &&
  existsSync(join(artifacts, "rootfs.ext4"));

function run(command: string, args: string[], cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitForSsh(port: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((done, fail) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          done();
        });
        socket.once("error", fail);
      });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("private sshd did not accept connections");
}

const frameShown = (page: Page, desk: string) =>
  page.waitForFunction(
    (desk) => {
      const img = document.querySelector<HTMLImageElement>(`${desk} img.live-frame`);
      return !!img && img.complete && img.naturalWidth > 0;
    },
    desk,
    { timeout: 120000 },
  );

test.skipIf(!enabled)(
  "real microVM desktop: live frames, agent cursor, takeover input, hand-over card, Início, replaced guest and teardown",
  async () => {
    const sshDir = tmp("fc-view-sshd-");
    const bundle = join(sshDir, "fake-acp-agent.js");
    run("bun", ["build", FAKE_AGENT, "--target=bun", "--outfile", bundle]);
    const root = makeFirecrackerHostRoot([
      { source: bundle, destination: "/opt/boto/fake-acp-agent.js" },
    ]);
    const sshPort = await freePort();
    const hostKey = join(sshDir, "host_key");
    const clientKey = join(sshDir, "client_key");
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], sshDir);
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey], sshDir);
    const authorizedKeys = join(sshDir, "authorized_keys");
    writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`), { mode: 0o600 });
    const knownHosts = join(sshDir, "known_hosts");
    const config = join(sshDir, "sshd_config");
    writeFileSync(
      config,
      [
        "AddressFamily inet",
        "ListenAddress 127.0.0.1",
        `Port ${sshPort}`,
        `HostKey ${hostKey}`,
        `PidFile ${join(sshDir, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        "StrictModes no",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "AllowStreamLocalForwarding yes",
        "AllowTcpForwarding yes",
        `SetEnv BOTO_HOST_ROOT=${root}`,
      ].join("\n"),
    );
    const sshd = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-f", config], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForSsh(sshPort);
    const dir = tmp("fc-view-");
    const token = crypto.randomUUID();
    const daemon = await startDaemon(join(dir, "data"), join(dir, "agents"), token, {
      FAKE_ACP_STATE_DIR: dir,
      BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify(["bun", "/opt/boto/fake-acp-agent.js"]),
      BOTO_SSH_COMMAND: JSON.stringify(["ssh", "-o", `UserKnownHostsFile=${knownHosts}`]),
      BOTO_VAULT_KEY: "12".repeat(32),
    });
    const vite = await startVite();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const client = await DaemonClient.connect(daemon.port, token);
    const shots = process.env.BOTO_TASK_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    try {
      await client.request("onboarding.complete", {});
      const agent = await client.request("agents.create", {
        name: "Código",
        provider: "devin",
        requireApproval: false,
      });
      let host = await client.request("hosts.create", {
        name: "Servidor local",
        target: `${userInfo().username}@127.0.0.1`,
        port: sshPort,
        identityFile: clientKey,
      });
      host = await client.request("hosts.install", { id: host.id });
      host = await client.request("hosts.check", { id: host.id });
      expect(host.preflight?.firecrackerReady).toBe(true);
      await client.request("placements.set", {
        agentId: agent.id,
        hostId: host.id,
        isolation: "firecracker",
        vcpus: 1,
        memMib: 1024,
      });
      await client.request("computer.setAccess", { agentIds: [agent.id] });
      const video = process.env.BOTO_TASK_VIDEO;
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        ...(video ? { recordVideo: { dir: video, size: { width: 1440, height: 900 } } } : {}),
      });
      page.setDefaultTimeout(20000);
      const shot = async (name: string) => {
        if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
      };
      const base = `http://localhost:1420/#port=${daemon.port}&token=${token}`;
      const task = await client.request("tasks.create", { agentId: agent.id, text: "echo: oi" });
      await page.goto(`${base}&task=${task.id}`);
      await frameShown(page, "#task-desk");
      const machines = await client.request("desktop.machines", {});
      const machine = machines.find((m) => m.agentId === agent.id);
      if (!machine) throw new Error("machine missing");
      expect(machine).toMatchObject({
        name: "codigo-01",
        status: "ready",
        width: 1280,
        height: 800,
      });
      expect(await page.locator("#task-desk .live-bar").innerText()).toContain("codigo-01");
      await shot("real-live-frame");

      // the agent inside the guest drives the real display through the bridge
      await page.addStyleTag({ content: ".live-click { animation-duration: 20s; }" });
      const click = await client.request("tasks.instruct", {
        id: task.id,
        text: 'mcp:computer_click {"x":640,"y":400}',
      });
      await page.locator("#task-desk .live-cursor").waitFor({ timeout: 60000 });
      await page.locator("#task-desk .live-click").waitFor();
      await client.waitForEventWhere("turn.ended", (turn) => turn.queueId === click.queueId, 60000);
      await page.getByText("tool-ok:pointer at (640, 400)", { exact: true }).waitFor();
      await shot("real-agent-cursor");

      // taking over sends real input: a right click opens the Openbox root menu in the guest
      await client.request("desktop.subscribe", { machineId: machine.id });
      const latestFrame = async () => {
        const mark = client.events.length;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const frames = client.events
            .slice(mark)
            .filter((e) => e.event === "desktop.frame")
            .map((e) => (e.data as { dataBase64: string }).dataBase64);
          if (frames.length >= 3) return frames[frames.length - 1] as string;
          await Bun.sleep(100);
        }
        throw new Error("the guest stopped sending frames");
      };
      const idle = await latestFrame();
      await page.locator("#ctl-takeover").click();
      await page.getByText("Você está no controle", { exact: true }).waitFor();
      const surface = await page.locator("#task-desk .live-surface").boundingBox();
      if (!surface) throw new Error("surface missing");
      await page.mouse.click(surface.x + surface.width / 2, surface.y + surface.height / 2, {
        button: "right",
      });
      await page.waitForTimeout(1000);
      const menuOpen = await latestFrame();
      expect(menuOpen).not.toBe(idle);
      await shot("real-takeover-menu");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);
      expect(await latestFrame()).not.toBe(menuOpen);
      const refused = await client.request("tasks.instruct", {
        id: task.id,
        text: 'mcp:computer_key {"key":"escape"}',
      });
      await client.waitForEventWhere(
        "turn.ended",
        (turn) => turn.queueId === refused.queueId,
        60000,
      );
      expect(await page.locator("#timeline").innerText()).toContain(
        "the user has taken control of codigo-01",
      );
      await page.locator("#ctl-takeover").click();
      await page.getByText("Você está no controle", { exact: true }).waitFor({ state: "hidden" });
      expect(
        (await client.request("desktop.machines", {})).find((m) => m.id === machine.id)?.controller,
      ).toBe("agent");

      // the agent asks for a hand: the card hands the machine over and giving it back
      // finishes the request
      const handover = await client.request("tasks.instruct", {
        id: task.id,
        text: 'mcp:request_takeover {"reason":"Preciso que você faça o login no site"}',
      });
      const card = page
        .locator(".task-card")
        .filter({ hasText: "precisa que você assuma o controle" });
      await card.waitFor({ timeout: 60000 });
      expect(await card.locator("h3").innerText()).toBe(
        "Código precisa que você assuma o controle.",
      );
      expect(await page.locator("#timeline").innerText()).not.toContain(
        "Take over the bot browser",
      );
      await page.locator("#task-meta").getByText("Aguardando você", { exact: true }).waitFor();
      await shot("real-handover-card");
      await card.getByRole("button", { name: "Assumir o controle", exact: true }).click();
      await page.getByText("Você está no controle", { exact: true }).waitFor();
      await card.getByRole("button", { name: "Devolver ao Boto", exact: true }).click();
      await client.waitForEventWhere(
        "turn.ended",
        (turn) => turn.queueId === handover.queueId,
        60000,
      );
      await card.getByText(/Concluída · \d{2}:\d{2}/).waitFor();
      await page
        .getByText(
          "tool-ok:the user finished in the browser; take a new browser_snapshot and continue",
          { exact: true },
        )
        .waitFor();
      await shot("real-handover-done");

      // the VM dialog takes the machine over while open and gives it back on close
      await page.getByRole("button", { name: "Abrir em tela cheia", exact: true }).click();
      await frameShown(page, "#vm-desk");
      await page.locator("#vm-desk").getByText("Você está no controle", { exact: true }).waitFor();
      expect(await page.locator("#vm-dialog header").innerText()).toContain("codigo-01");
      await shot("real-vm-dialog");
      await page.getByRole("button", { name: "Fechar e devolver a máquina", exact: true }).click();
      await page.locator("#vm-dialog").waitFor({ state: "hidden" });
      expect(
        (await client.request("desktop.machines", {})).find((m) => m.id === machine.id)?.controller,
      ).toBe("agent");

      // Início shows the working machine with a real frame
      const slow = await client.request("tasks.instruct", { id: task.id, text: "slow" });
      await client.waitForEventWhere(
        "turn.started",
        (turn) => turn.queueId === slow.queueId,
        60000,
      );
      await client.request("desktop.unsubscribe", { machineId: machine.id });
      await page.goto(base);
      await page.reload();
      await page.locator("#pc-card .ag-thumb img").waitFor({ timeout: 30000 });
      expect(await page.locator("#pc-card").innerText()).toContain("codigo-01");
      await shot("real-home-card");
      await page.goto(`${base}&task=${task.id}`);
      await page.reload();
      await frameShown(page, "#task-desk");
      await page.locator("#ctl-pause").click();
      await page.getByRole("button", { name: "Retomar", exact: true }).waitFor();
      await client.waitForEventWhere("turn.ended", (turn) => turn.queueId === slow.queueId, 60000);

      // a new task replaces the microVM under the open task view: the stream comes back
      const viewer = await DaemonClient.connect(daemon.port, token);
      const next = await client.request("tasks.create", { agentId: agent.id, text: "echo: B" });
      await viewer.waitForEventWhere(
        "desktop.machine",
        (m) => (m as Machine).id === machine.id && (m as Machine).status === "stopped",
        60000,
      );
      await viewer.waitForEventWhere(
        "desktop.machine",
        (m) => (m as Machine).id === machine.id && (m as Machine).status === "ready",
        120000,
      );
      viewer.close();
      await client.waitForEventWhere(
        "task.updated",
        (value) => value.id === next.id && value.situation === "done",
        120000,
      );
      await frameShown(page, "#task-desk");
      expect(await page.locator("#task-desk .live-bar").innerText()).toContain("Pronta");
      await shot("real-replaced-guest");

      // ending the task and leaving the view stops the stream
      await page.locator("#ctl-stop").click();
      await page.getByRole("button", { name: "Encerrar tarefa", exact: true }).click();
      await page.locator("#task-meta").getByText("Encerrada", { exact: true }).waitFor();
      expect(await page.locator("#ctl-takeover").getAttribute("title")).toBe(
        "Esta tarefa foi encerrada",
      );
      await page.goto(base);
      await page.reload();
      await page.getByText("Nenhuma área de trabalho ativa agora.", { exact: true }).waitFor();
      const deadline = Date.now() + 15000;
      let status: Machine["status"] | undefined;
      while (Date.now() < deadline) {
        status = (await client.request("desktop.machines", {})).find(
          (m) => m.id === machine.id,
        )?.status;
        if (status === "stopped") break;
        await Bun.sleep(200);
      }
      expect(status).toBe("stopped");
      await shot("real-stream-stopped");
      await page.close();
    } finally {
      client.close();
      await browser.close();
      await vite.stop();
      daemon.proc.kill();
      await daemon.proc.exited;
      sshd.kill("SIGTERM");
      await sshd.exited;
      await removeFirecrackerHostRoot(root);
      rmSync(sshDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  600000,
);
