import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
} from "../../../packages/daemon/test/helpers";
import { agentStatus, relativeTime } from "../src/agents/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let page: Page;
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
const deletedIds: string[] = [];
const token = `agents-view-${crypto.randomUUID()}`;

async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error("Condition did not become true within 30 seconds");
}

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "boto-agents-test-"));
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    BOTO_PROVIDER_COMMAND_CLAUDE: JSON.stringify(["definitely-missing-boto-config-provider"]),
    FAKE_ACP_NEW_DELAY_MS: "1500",
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  const ready = async () => {
    try {
      return (await fetch("http://localhost:1420")).ok;
    } catch {
      return false;
    }
  };
  if (!(await ready()))
    vite = Bun.spawn([process.execPath, "run", "dev", "--port", "1420"], {
      cwd: join(ROOT, "apps/desktop"),
      stdout: "ignore",
      stderr: "inherit",
    });
  await waitUntil(ready);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.method === "agents.delete") deletedIds.push(message.params.id);
    });
  });
  await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
}, 60000);

afterAll(async () => {
  await browser?.close();
  rpc?.close();
  await stopTestChildren(state);
  daemon?.proc.kill();
  if (daemon) await daemon.proc.exited;
  vite?.kill();
  if (vite) await vite.exited;
  if (state) rmSync(state, { recursive: true, force: true });
}, 30000);

test("relative time handles current, past and future timestamps", () => {
  expect(relativeTime(100000, 100000)).toBe("agora");
  expect(relativeTime(0, 180000)).toBe("há 3 min");
  expect(relativeTime(0, 7200000)).toBe("há 2 h");
  expect(relativeTime(0, 172800000)).toBe("há 2 dias");
  expect(relativeTime(200000, 100000)).toBe("agora");
});

test("real agents can be created, delegated to, configured, filtered and deleted", async () => {
  await page.getByText("Nenhum agente ainda. Crie o primeiro para delegar tarefas.").waitFor();
  await page.locator("#new-agent").click();
  expect((await page.locator("#agent-new").boundingBox())?.width).toBe(760);
  expect(
    await page
      .locator("#an-approval-help")
      .evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe("500");
  expect(
    await page
      .locator("#agent-new .label-opt")
      .evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe("500");
  await page.locator("#an-create").click();
  expect(await page.locator("#an-name-error").textContent()).toBe("Dê um nome ao agente.");
  await page.locator("#an-name").fill("Financeiro");
  await page.locator("#an-role").fill("Confere notas fiscais");
  await page.locator("#an-approval").click();
  await page.locator("#an-create").click();
  await page
    .getByText("provider is required. Escolha um provedor de IA em Configurações.")
    .waitFor();
  await rpc.request("providers.setDefault", { provider: "devin" });
  await page.locator("#an-create").click();
  await page.locator("#agent-panel[open]").waitFor();
  const agent = (await rpc.request("agents.list", {}))[0];
  if (!agent) throw new Error("Agent not created");
  expect(agent.requireApproval).toBe(false);
  await page.locator("#ap-config-model").waitFor();
  expect(await page.locator('#agent-panel [role="alert"]').count()).toBe(0);
  expect(await page.locator(".ag-card-title").textContent()).toBe("Financeiro");
  expect(await page.locator(".ag-card .ag-card-role").textContent()).toBe("Confere notas fiscais");
  await waitUntil(
    async () =>
      (await page.locator(".ag-card .status").first().textContent())?.includes("Livre") === true,
  );
  expect(await page.locator(".ag-card .status").first().textContent()).toContain("Livre");
  expect(await page.locator(".ag-stat-value").first().textContent()).toBe("1");
  await page.locator("#ap-add-btn").click();
  expect(await page.locator("#ap-add-input").getAttribute("aria-invalid")).toBe("true");
  await page.locator("#ap-add-input").fill("echo: hi");
  await page.locator("#ap-add-input").press("Control+Enter");
  await waitUntil(async () => (await rpc.request("tasks.list", {})).items.length === 1);
  await waitUntil(async () => (await page.locator(".ag-stat-value").nth(1).textContent()) === "1");
  await waitUntil(
    async () =>
      (await page.locator(".ag-card .status").first().textContent())?.includes("Livre") === true,
  );
  await page.locator('#agent-panel [role="switch"]').click();
  await waitUntil(async () => (await rpc.request("agents.list", {}))[0]?.requireApproval === true);
  await page.getByRole("button", { name: "Fechar painel do agente" }).click();
  await page.getByRole("radio", { name: "Trabalhando" }).click();
  await page.getByText("Nenhum agente nesta situação.").waitFor();
  expect(await page.locator(".ag-card").count()).toBe(0);
  await page.getByRole("radio", { name: "Trabalhando" }).press("Home");
  await page.locator(".ag-card").waitFor();
  expect(await page.getByRole("radio", { name: "Todos" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await page.getByRole("button", { name: "Abrir painel" }).click();
  expect(await page.locator("#confirm").count()).toBe(0);
  await page.locator(".ap-delete").click();
  await page.locator("#confirm[open]").waitFor();
  expect(await page.locator("#confirm").count()).toBe(1);
  expect(await page.locator("#view-agents #confirm").count()).toBe(0);
  expect(await page.locator("#confirm-title").textContent()).toBe("Excluir Financeiro?");
  expect(await page.locator("#confirm-desc").textContent()).toBe(
    "O agente sai do quadro e a fila dele é cancelada. A pasta de trabalho fica no computador.",
  );
  await page.locator("#confirm-cancel").click();
  await page.locator("#confirm").waitFor({ state: "detached" });
  expect(deletedIds).toEqual([]);
  expect((await rpc.request("agents.list", {})).map((item) => item.id)).toContain(agent.id);
  await page.locator(".ap-delete").click();
  await page.locator("#confirm[open]").waitFor();
  await page.locator("#confirm-ok").click();
  await page.getByText("Nenhum agente ainda. Crie o primeiro para delegar tarefas.").waitFor();
  expect((await rpc.request("agents.list", {})).length).toBe(0);
  expect(deletedIds).toEqual([agent.id]);
}, 60000);

test("unknown overview numbers are honest during loading and RPC failure, then recover", async () => {
  const pendingPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let mode: "delay" | "fail" | "live" = "delay";
  let release: (() => void) | undefined;
  await pendingPage.routeWebSocket(`ws://127.0.0.1:${daemon.port}/ws*`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((payload) => {
      const message = JSON.parse(String(payload));
      if (message.method !== "agents.overview" || mode === "live") {
        server.send(payload);
      } else if (mode === "delay") {
        release = () => server.send(payload);
      } else {
        socket.send(
          JSON.stringify({ id: message.id, error: { code: "internal", message: "QA failure" } }),
        );
      }
    });
  });
  async function openAgents() {
    await pendingPage.getByRole("button", { name: "Abrir menu" }).click();
    await pendingPage.getByRole("button", { name: "Agentes", exact: true }).click();
  }
  async function expectUnknown() {
    expect(await pendingPage.locator(".ag-stat-value").allTextContents()).toEqual([
      "a definir",
      "a definir",
      "a definir",
      "a definir",
    ]);
    expect(await pendingPage.locator(".ag-filter-count").count()).toBe(0);
    expect(
      await pendingPage
        .locator(".ag-stat-value")
        .evaluateAll((elements) =>
          elements.every((element) => element.scrollWidth <= element.clientWidth),
        ),
    ).toBe(true);
  }
  try {
    await pendingPage.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await openAgents();
    await pendingPage.getByText("Carregando agentes…").waitFor();
    await waitUntil(async () => !!release);
    await expectUnknown();
    mode = "live";
    release?.();
    await pendingPage
      .getByText("Nenhum agente ainda. Crie o primeiro para delegar tarefas.")
      .waitFor();
    expect(await pendingPage.locator(".ag-stat-value").allTextContents()).toEqual([
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(await pendingPage.locator(".ag-filter-count").allTextContents()).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    mode = "fail";
    await pendingPage.reload();
    await openAgents();
    await pendingPage.getByText("Não foi possível carregar os agentes.").waitFor();
    await expectUnknown();
    mode = "live";
    await pendingPage.getByRole("button", { name: "Tentar de novo" }).click();
    await pendingPage
      .getByText("Nenhum agente ainda. Crie o primeiro para delegar tarefas.")
      .waitFor();
    expect(await pendingPage.locator(".ag-stat-value").first().textContent()).toBe("0");
  } finally {
    await pendingPage.close();
  }
}, 60000);

test("agent config startup errors show the real message and retry the RPC", async () => {
  const agent = await rpc.request("agents.create", { name: "Unavailable", provider: "claude" });
  const requests = new Set<string>();
  const errors: string[] = [];
  const errorPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  errorPage.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.method === "agents.configOptions") requests.add(message.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (requests.has(message.id) && message.error) errors.push(message.error.message);
    });
  });
  try {
    let expectedMessage = "";
    try {
      await rpc.request("agents.configOptions", { agentId: agent.id });
      throw new Error("Expected missing provider to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_unavailable" });
      expectedMessage = (error as Error).message;
    }
    await errorPage.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await errorPage.getByRole("button", { name: /^Agentes/ }).click();
    await errorPage.getByRole("button", { name: "Abrir painel" }).click();
    const alert = errorPage.locator('#agent-panel [role="alert"]');
    await alert.waitFor();
    expect(await alert.textContent()).toBe(expectedMessage);
    expect(expectedMessage).toContain("definitely-missing-boto-config-provider");
    await waitUntil(async () => errors.length === requests.size && errors.length > 0);
    const before = errors.length;
    await errorPage.getByRole("button", { name: "Tentar de novo", exact: true }).click();
    await waitUntil(async () => errors.length > before);
    expect(errors.at(-1)).toBe(expectedMessage);
    expect(await alert.textContent()).toBe(expectedMessage);
  } finally {
    await errorPage.close();
    await rpc.request("agents.delete", { id: agent.id });
  }
}, 30000);

test("status helpers distinguish paused and failed agents", async () => {
  const agent = await rpc.request("agents.create", { name: "Ajuda" });
  const overview = (await rpc.request("agents.overview", {})).agents.find(
    (item) => item.agentId === agent.id,
  );
  if (!overview) throw new Error("Missing overview");
  expect(agentStatus(overview).text).toBe("Livre");
  expect(agentStatus({ ...overview, paused: true }).text).toBe("Fila pausada");
  expect(agentStatus({ ...overview, situation: "error", error: "Falhou" }).text).toBe("Com erro");
  await rpc.request("agents.delete", { id: agent.id });
}, 30000);

test("machine thumbnails refresh, survive RPC errors and do not leak between agent panels", async () => {
  const first = await rpc.request("agents.create", { name: "Desktop one", provider: "devin" });
  const second = await rpc.request("agents.create", { name: "Desktop two", provider: "devin" });
  const desktopPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const machines = [first, second].map((agent, index) => ({
    id: `test-machine-${index}`,
    name: `desktop-${index}`,
    agentId: agent.id,
    hostId: null,
    status: "ready",
    controller: "agent",
    width: 1280,
    height: 800,
    taskId: null,
    thumbnailAt: null,
  }));
  let failure = false;
  let brokenImage = false;
  let frames = 0;
  await desktopPage.routeWebSocket(`ws://127.0.0.1:${daemon.port}/ws*`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((payload) => {
      const message = JSON.parse(String(payload));
      if (message.method === "desktop.machines") {
        socket.send(JSON.stringify({ id: message.id, result: machines }));
      } else if (message.method === "desktop.thumbnail") {
        frames++;
        const result = {
          mime: "image/svg+xml",
          dataBase64: brokenImage
            ? "invalid"
            : Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><text y="40">${message.params.machineId}-${frames}</text></svg>`,
              ).toString("base64"),
          at: new Date().toISOString(),
        };
        socket.send(
          JSON.stringify(
            failure
              ? { id: message.id, error: { code: "not_found", message: "no thumbnail yet" } }
              : { id: message.id, result },
          ),
        );
      } else server.send(payload);
    });
    server.onMessage((payload) => {
      const message = JSON.parse(String(payload));
      const overview = message.event === "agents.overviewChanged" ? message.data : message.result;
      if (overview?.summary && Array.isArray(overview.agents)) {
        for (const row of overview.agents) {
          row.machines = machines
            .filter((machine) => machine.agentId === row.agentId)
            .map((machine) => machine.id);
        }
        socket.send(JSON.stringify(message));
      } else socket.send(payload);
    });
  });
  try {
    await desktopPage.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await desktopPage.getByRole("button", { name: "Abrir menu" }).click();
    await desktopPage.getByRole("button", { name: /^Agentes/ }).click();
    const firstCard = desktopPage
      .locator(".ag-card")
      .filter({ has: desktopPage.getByText(first.name, { exact: true }) });
    await firstCard.locator("img").waitFor();
    const original = await firstCard.locator("img").getAttribute("src");
    await waitUntil(async () => (await firstCard.locator("img").getAttribute("src")) !== original);
    expect(await firstCard.locator("img").getAttribute("src")).not.toBe(original);
    expect(
      await firstCard
        .locator("img")
        .evaluate(
          (image: HTMLImageElement) =>
            Math.abs(image.clientWidth / image.clientHeight - 1.6) < 0.02,
        ),
    ).toBe(true);
    await firstCard.getByRole("button", { name: "Abrir painel" }).click();
    await desktopPage.locator('#agent-panel img[alt="Tela da máquina desktop-0"]').waitFor();
    await desktopPage.getByRole("button", { name: "Fechar painel do agente" }).click();
    const secondCard = desktopPage
      .locator(".ag-card")
      .filter({ has: desktopPage.getByText(second.name, { exact: true }) });
    await secondCard.getByRole("button", { name: "Abrir painel" }).click();
    await desktopPage.locator('#agent-panel img[alt="Tela da máquina desktop-1"]').waitFor();
    expect(
      await desktopPage.locator('#agent-panel img[alt="Tela da máquina desktop-0"]').count(),
    ).toBe(0);
    failure = true;
    await desktopPage.locator("#agent-panel .ag-thumb-placeholder").waitFor({ timeout: 15000 });
    expect(await desktopPage.locator("#agent-panel .ag-thumb img").count()).toBe(0);
    failure = false;
    await desktopPage.locator("#agent-panel .ag-thumb img").waitFor({ timeout: 15000 });
    brokenImage = true;
    await desktopPage.locator("#agent-panel .ag-thumb-placeholder").waitFor({ timeout: 15000 });
    expect(await desktopPage.locator("#agent-panel .ag-thumb img").count()).toBe(0);
  } finally {
    await desktopPage.close();
    await rpc.request("agents.delete", { id: first.id });
    await rpc.request("agents.delete", { id: second.id });
  }
}, 60000);

test("capture real board, panel and create dialog in both themes", async () => {
  const shots = process.env.AGENTS_SCREEN_DIR;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const agent = await rpc.request("agents.create", {
    name: "Financeiro",
    role: "Confere notas fiscais e atualiza a planilha do financeiro",
  });
  await rpc.request("agents.create", { name: "Código", role: "Revisa código e prepara correções" });
  await rpc.request("tasks.create", { agentId: agent.id, text: "echo: hi" });
  await waitUntil(async () => (await page.locator(".ag-card").count()) === 2);
  await page.locator(".toast").last().waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["dark", "light"])
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width as number, height: height as number });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(shots, `app-board-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Abrir painel" }).first().click();
      await page.locator("#agent-panel").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      await page.screenshot({ path: join(shots, `app-panel-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Fechar painel do agente" }).click();
      await page.locator("#new-agent").click();
      await page.screenshot({ path: join(shots, `app-new-${width}-${theme}.png`) });
      await page.locator("#agent-new").getByRole("button", { name: "Cancelar" }).click();
    }
  const prototype = await browser.newPage();
  await prototype.goto("http://127.0.0.1:8765/docs/design/index.html");
  await prototype.locator('[data-nav="agents"]').first().click();
  for (const theme of ["dark", "light"])
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      await prototype.setViewportSize({ width: width as number, height: height as number });
      await prototype.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await prototype.evaluate(() => document.fonts.ready);
      await prototype.screenshot({ path: join(shots, `prototype-board-${width}-${theme}.png`) });
      for (const surface of ["agent-panel", "agent-new"]) {
        await prototype
          .locator(`#${surface}`)
          .evaluate((element: HTMLDialogElement) => element.showModal());
        await prototype.screenshot({
          path: join(shots, `prototype-${surface}-${width}-${theme}.png`),
        });
        await prototype
          .locator(`#${surface}`)
          .evaluate((element: HTMLDialogElement) => element.close());
      }
    }
  await prototype.close();
}, 60000);
