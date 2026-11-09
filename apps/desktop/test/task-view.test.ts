import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  ROOT,
  readLog,
  startDaemon,
} from "../../../packages/daemon/test/helpers";

test("task timeline, real desktop stream, takeover, split, VM dialog and mobile tabs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boto-task-view-"));
  const token = crypto.randomUUID();
  const daemon = await startDaemon(join(dir, "data"), join(dir, "agents"), token, {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: dir,
    BOTO_VAULT_KEY: "12".repeat(32),
    BOTO_SSH_COMMAND: JSON.stringify([
      "bun",
      join(ROOT, "packages/daemon/test/fixtures/fake-ssh.ts"),
    ]),
    BOTO_DESKTOP_COMMAND: JSON.stringify([
      "bun",
      join(ROOT, "packages/daemon/test/fixtures/fake-desktop-host.ts"),
    ]),
    FAKE_SSH_HOME: join(dir, "ssh"),
    FAKE_DESKTOP_LOG: join(dir, "desktop.jsonl"),
    FAKE_DESKTOP_FRAME_FILE: join(dir, "frame.jpg"),
  });
  const running = await fetch("http://localhost:1420")
    .then((r) => r.ok)
    .catch(() => false);
  const vite = running
    ? null
    : Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420"], {
        cwd: ROOT,
        stdout: "ignore",
        stderr: "ignore",
      });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const client = await DaemonClient.connect(daemon.port, token);
  await client.request("onboarding.complete", {});
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (
        await fetch("http://localhost:1420")
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await Bun.sleep(50);
    }
    const agent = await client.request("agents.create", {
      name: "Código",
      provider: "devin",
      requireApproval: false,
    });
    await client.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Notes",
      secrets: {},
      command: ["bun", join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts")],
    });
    const task = await client.request("tasks.create", { agentId: agent.id, text: "tool" });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}&task=${task.id}`);
    await page
      .getByRole("button", { name: "Permitir nesta sessão", exact: true })
      .click()
      .catch(async (error) => {
        console.log(
          "task history:",
          JSON.stringify(await client.request("tasks.history", { id: task.id })),
        );
        console.log("render:", await page.locator("#main").innerText());
        throw error;
      });
    await page.getByText("permission:allow_once", { exact: true }).waitFor();
    expect(await page.locator("#ctl-takeover").isDisabled()).toBe(true);
    expect(await page.locator("#ctl-takeover").getAttribute("title")).toBe(
      "Este agente não tem uma área de trabalho",
    );
    expect(await page.locator("#task-desk").innerText()).toContain(
      "Este agente trabalha sem área de trabalho. Ela está disponível para agentes em uma microVM.",
    );
    await page.locator("#instruct-input").fill("echo: oi");
    await page.locator("#instruct-input").press("Enter");
    await page
      .locator(".task-message")
      .filter({ hasText: /^\s*oi$/ })
      .waitFor();
    expect(await page.locator("#timeline").innerText()).toMatch(/Permitido · \d{2}:\d{2}/);
    await page.locator("#instruct-input").fill("mcp:notes-create_note {}");
    await page.locator("#instruct-input").press("Enter");
    await page.getByRole("button", { name: "Aprovar", exact: true }).click();
    await page.getByText("tool-ok:note-created", { exact: true }).waitFor();
    expect(await page.locator("#timeline").innerText()).toMatch(/Aprovada · \d{2}:\d{2}/);

    const slow = await client.request("tasks.instruct", { id: task.id, text: "slow" });
    await client.waitForEventWhere("turn.started", (turn) => turn.queueId === slow.queueId);
    await page.locator("#ctl-pause").click();
    await page.getByRole("button", { name: "Retomar", exact: true }).waitFor();
    await client.waitForEventWhere("turn.ended", (turn) => turn.queueId === slow.queueId);
    expect((await client.request("tasks.get", { id: task.id })).situation).toBe("muted");
    await page.locator("#ctl-pause").click();
    await page.getByRole("button", { name: "Pausar", exact: true }).waitFor();
    await client.waitForEventWhere(
      "task.updated",
      (value) => value.id === task.id && value.situation === "done",
    );
    const next = await client.request("tasks.instruct", { id: task.id, text: "slow" });
    await client.waitForEventWhere("turn.started", (turn) => turn.queueId === next.queueId);
    await page.locator("#ctl-pause").click();
    await client.waitForEventWhere("turn.ended", (turn) => turn.queueId === next.queueId);

    const fixture = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await fixture.goto("http://localhost:1420");
    await fixture.setContent(
      '<html><body style="margin:0; background:#0c1416; color:#e8eeee; font:24px monospace; padding:48px"><h1>Área de trabalho de teste</h1><p>Stream do host de verificação</p></body></html>',
    );
    await fixture.screenshot({ path: join(dir, "frame.jpg"), type: "jpeg" });
    await fixture.close();
    let host = await client.request("hosts.create", {
      name: "Host de verificação",
      target: "bob@vps.example.com",
    });
    host = await client.request("hosts.install", { id: host.id });
    copyFileSync(
      join(ROOT, "packages/daemon/test/fixtures/fake-boto-host-ready.ts"),
      join(dir, "ssh/.boto/bin/boto-host.ts"),
    );
    host = await client.request("hosts.check", { id: host.id });
    expect(host.preflight?.firecrackerReady).toBe(true);
    await client.request("placements.set", {
      agentId: agent.id,
      hostId: host.id,
      isolation: "firecracker",
    });
    await page.locator("#task-desk .live-frame").waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>("#task-desk .live-frame");
      return img?.complete && img.naturalWidth > 0;
    });
    const machines = await client.request("desktop.machines", {});
    const machine = machines.find((m) => m.agentId === agent.id);
    if (!machine) throw new Error("machine missing");
    await client.request("computer.setAccess", { agentIds: [agent.id] });
    const session = readLog(dir).find((entry) => entry.method === "session/new");
    if (!session) throw new Error("fake ACP session missing");
    const spec = (
      session.params as { mcpServers: { name: string; env: { name: string; value: string }[] }[] }
    ).mcpServers.find((server) => server.name === "boto");
    const bridgeToken = spec?.env.find((entry) => entry.name === "BOTO_BRIDGE_TOKEN")?.value;
    if (!bridgeToken) throw new Error("bridge token missing");
    await page.addStyleTag({ content: ".live-click { animation-duration: 20s; }" });
    const click = await fetch(`http://127.0.0.1:${daemon.port}/bridge`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "computer_click", arguments: { x: 480, y: 320 } },
      }),
    });
    expect(click.ok).toBe(true);
    await page.locator("#task-desk .live-cursor").waitFor();
    await page.locator("#task-desk .live-click").waitFor();
    const key = await fetch(`http://127.0.0.1:${daemon.port}/bridge`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "computer_key", arguments: { key: "escape" } },
      }),
    });
    expect(key.ok).toBe(true);
    await page.waitForTimeout(400);
    // the click wave outlives the following key press and stays anchored at the click point
    expect(await page.locator("#task-desk .live-click").count()).toBe(1);
    const [wave, frame] = await Promise.all([
      page.locator("#task-desk .live-click").boundingBox(),
      page.locator("#task-desk img.live-frame").boundingBox(),
    ]);
    if (!wave || !frame) throw new Error("wave or frame missing");
    expect(Math.abs(wave.x + wave.width / 2 - (frame.x + (frame.width * 480) / 1280))).toBeLessThan(
      3,
    );
    expect(
      Math.abs(wave.y + wave.height / 2 - (frame.y + (frame.height * 320) / 800)),
    ).toBeLessThan(3);
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.locator("#pc-card .ag-thumb img").waitFor();
    expect(await page.locator("#pc-card").innerText()).toContain(machine.name);
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}&task=${task.id}`);
    await page.locator("#task-desk img.live-frame").waitFor();

    const shots = process.env.BOTO_TASK_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const capture = async (name: string, width: number, height: number, theme = "dark") => {
      await page.setViewportSize({ width, height });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (shots)
        await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    };
    await capture("1440-dark", 1440, 900);
    await capture("1440-light", 1440, 900, "light");
    await page.locator("#split").focus();
    const split = Number(await page.locator("#split").getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    expect(Number(await page.locator("#split").getAttribute("aria-valuenow"))).toBe(split + 2);
    await page.keyboard.press("Home");
    expect(await page.locator("#split").getAttribute("aria-valuenow")).toBe("30");
    expect(await page.evaluate(() => localStorage.getItem("boto.task-split"))).toBe("30");
    await page.keyboard.press("Enter");
    await client.request("desktop.takeover", { machineId: machine.id });
    await page.locator("#ctl-takeover").click();
    await page
      .getByText("Não foi possível concluir a ação. Tente de novo.", { exact: true })
      .waitFor();
    await page
      .getByRole("region", { name: "Avisos" })
      .getByRole("button", { name: "Fechar", exact: true })
      .click();
    await client.request("desktop.release", { machineId: machine.id });
    await page.locator("#ctl-takeover").click();
    await page.getByText("Você está no controle", { exact: true }).waitFor();
    await page.locator("#task-desk .live-surface").click({ position: { x: 100, y: 100 } });
    await page.keyboard.press("a");
    await page.locator("#task-desk .live-surface").dispatchEvent("wheel", { deltaY: 999 });
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      !(
        existsSync(join(dir, "desktop.jsonl")) &&
        readFileSync(join(dir, "desktop.jsonl"), "utf8").includes('"deltaY":100')
      )
    )
      await Bun.sleep(20);
    const input = readFileSync(join(dir, "desktop.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "input" && entry.source === "user");
    expect(
      input.some((entry) =>
        entry.events.some((event: { type: string }) => event.type === "mouse_down"),
      ),
    ).toBe(true);
    expect(input.every((entry) => entry.events.length <= 64)).toBe(true);
    expect(
      input.some((entry) =>
        entry.events.some(
          (event: { type: string; keysym?: string }) =>
            event.type === "key_down" && event.keysym === "a",
        ),
      ),
    ).toBe(true);
    expect(
      input.some((entry) =>
        entry.events.some(
          (event: { type: string; deltaY?: number }) =>
            event.type === "wheel" && event.deltaY === 100,
        ),
      ),
    ).toBe(true);
    await capture("1440-takeover", 1440, 900);
    await capture("1440-takeover-light", 1440, 900, "light");
    await page.locator("#ctl-takeover").click();
    await page.getByText("Você está no controle", { exact: true }).waitFor({ state: "hidden" });
    await capture("1024-dark", 1024, 768);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#tl-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    await capture("390-activity", 390, 844);
    await page.locator("#pane-tab-activity").focus();
    await page.keyboard.press("End");
    expect(await page.locator("#pane-tab-computer").getAttribute("aria-selected")).toBe("true");
    await capture("390-desktop", 390, 844);
    expect(await page.locator("#split").isVisible()).toBe(false);
    await page.keyboard.press("Home");
    expect(await page.locator("#pane-tab-activity").getAttribute("aria-selected")).toBe("true");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Abrir em tela cheia", exact: true }).click();
    await page.locator("#vm-desk").getByText("Você está no controle", { exact: true }).waitFor();
    await capture("1440-vm", 1440, 900);
    await page.keyboard.press("Escape");
    await page.locator("#vm-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => !document.querySelector('#task-desk .live-desk[data-owned="true"]'),
    );
    expect(
      (await client.request("desktop.machines", {})).find((m) => m.id === machine.id)?.controller,
    ).toBe("agent");
    await page.getByRole("button", { name: "Abrir em tela cheia", exact: true }).click();
    await page.locator("#vm-desk").getByText("Você está no controle", { exact: true }).waitFor();
    await capture("390-vm", 390, 844);
    await page.getByRole("button", { name: "Fechar e devolver a máquina", exact: true }).click();
    await page.locator("#vm-dialog").waitFor({ state: "hidden" });
    expect(
      (await client.request("desktop.machines", {})).find((m) => m.id === machine.id)?.controller,
    ).toBe("agent");
    await page.locator("#ctl-stop").click();
    await page.setViewportSize({ width: 1440, height: 900 });
    const stopDialog = await page.locator("#confirm-stop").boundingBox();
    expect(stopDialog?.width).toBeGreaterThan(520);
    await page.getByRole("button", { name: "Encerrar tarefa", exact: true }).click();
    await page.locator("#task-meta").getByText("Encerrada", { exact: true }).waitFor();
    expect(await page.locator("#instruct-input").isDisabled()).toBe(true);
    // leaving the finished task's view is what lets the idle machine's stream stop
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.getByText("Nenhuma área de trabalho ativa agora.", { exact: true }).waitFor();
    expect(
      (await client.request("desktop.machines", {})).find((m) => m.id === machine.id)?.status,
    ).toBe("stopped");
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}&task=missing`);
    await page.reload();
    await page.getByRole("button", { name: "Tentar de novo" }).waitFor();
    expect(await page.locator("#timeline").innerText()).not.toContain("permission:allow_once");
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const ReactModule = await load("/node_modules/.vite/deps/react.js");
      const React = ReactModule.default;
      const ReactDOM = await load("/node_modules/.vite/deps/react-dom_client.js");
      const createRoot = ReactDOM.createRoot ?? ReactDOM.default.createRoot;
      const { useTask } = await load("/src/hooks/useTask.ts");
      const { DaemonClient } = await load("/src/lib/daemon.ts");
      const client = new DaemonClient();
      const el = document.createElement("div");
      el.id = "hook-result";
      document.body.append(el);
      function Probe() {
        const state = useTask(client, undefined);
        return React.createElement(
          "pre",
          null,
          JSON.stringify({ loading: state.loading, items: state.items, task: state.task }),
        );
      }
      createRoot(el).render(React.createElement(Probe));
    });
    await page.waitForFunction(() =>
      document.querySelector("#hook-result")?.textContent?.includes('"loading":false'),
    );
    expect(JSON.parse(await page.locator("#hook-result").innerText())).toEqual({
      loading: false,
      items: [],
      task: null,
    });
  } finally {
    client.close();
    await browser.close();
    vite?.kill();
    daemon.proc.kill();
    await Promise.all([vite?.exited, daemon.proc.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 90000);
