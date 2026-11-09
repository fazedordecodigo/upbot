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
    FAKE_ACP_NEW_DELAY_MS: "1500",
  });
  rpc = await DaemonClient.connect(daemon.port, token);
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
  expect(await page.locator(".ag-card-title").textContent()).toBe("Financeiro");
  expect(await page.locator(".ag-card .ag-card-role").textContent()).toBe("Confere notas fiscais");
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
  await page.locator(".ap-delete").click();
  await page.locator("#confirm-ok").click();
  await page.getByText("Nenhum agente ainda. Crie o primeiro para delegar tarefas.").waitFor();
  expect((await rpc.request("agents.list", {})).length).toBe(0);
}, 60000);

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
