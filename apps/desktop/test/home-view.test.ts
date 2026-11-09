import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopDaemon,
} from "../../../packages/daemon/test/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: ReturnType<typeof Bun.spawn>;
let state: string;
const token = `home-test-${crypto.randomUUID()}`;
const base = "http://localhost:1420";

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "boto-home-test-"));
  mkdirSync(join(state, "fake"));
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    BOTO_ACP_COMMAND_GROK: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: join(state, "fake"),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  vite = Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 300; i++) {
    if (
      await fetch(base)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    await Bun.sleep(100);
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60000);

test("home exposes a real daemon query error and retries after repair", async () => {
  const db = new Database(join(state, "data", "boto.db"));
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  try {
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "profile.name",
      "false",
    );
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    const error = page.locator("#view-home [role=alert]").filter({ hasText: "profile.name" });
    await error.waitFor();
    expect(await error.innerText()).toContain("Tentar de novo");
    db.query("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify("Emerson"),
      "profile.name",
    );
    await error.getByRole("button", { name: "Tentar de novo" }).click();
    await page.locator("#greeting").filter({ hasText: ", Emerson." }).waitFor();
    expect(await page.locator("#view-home [role=alert]").count()).toBe(0);
  } finally {
    db.query("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify("Emerson"),
      "profile.name",
    );
    db.close();
    await page.close();
  }
}, 60000);

afterAll(async () => {
  await browser?.close();
  vite?.kill();
  if (vite) await vite.exited;
  if (daemon) await stopDaemon(daemon, rpc, state);
  if (state) rmSync(state, { recursive: true, force: true });
}, 30000);

test("home reflects real profile, running and waiting tasks, deliveries and navigation", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await page.getByText("Nada em andamento agora.", { exact: true }).waitFor();
    expect(await page.getByText("Nada aguardando você.", { exact: true }).count()).toBe(1);
    expect(await page.getByText("Nenhuma entrega ainda.", { exact: true }).count()).toBe(1);
    expect(
      await page.getByText("Nenhuma área de trabalho ativa agora.", { exact: true }).count(),
    ).toBe(1);
    await rpc.request("profile.update", { name: "Emerson" });
    await page.locator("#greeting").filter({ hasText: ", Emerson." }).waitFor();
    const createAgent = (name: string) => rpc.request("agents.create", { name, provider: "grok" });
    const runner = await createAgent("Código");
    const waiter = await createAgent("Pesquisa");
    const writer = await createAgent("Resumo");
    await rpc.request("tasks.create", { agentId: runner.id, text: "slow", private: true });
    await page.locator("#lane-running .lane-item").waitFor();
    expect(await page.locator("#lane-running-count").innerText()).toBe("1");
    await rpc.request("tasks.create", { agentId: waiter.id, text: "tool" });
    await page
      .locator("#lane-waiting .lane-item")
      .filter({ hasText: "Permissão pendente: Fake tool" })
      .waitFor();
    expect(await page.locator("#lane-waiting-count").innerText()).toBe("1");
    await rpc.request("tasks.create", { agentId: writer.id, text: "echo:Resumo entregue" });
    await page.locator("#deliveries .delivery-item").waitFor();
    expect(await page.locator("#deliveries").innerText()).toContain("Resumo");
    if (process.env.HOME_SCREEN_DIR) {
      mkdirSync(process.env.HOME_SCREEN_DIR, { recursive: true });
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ["dark", "light"]) {
          if ((await page.locator("html").getAttribute("data-theme")) !== theme)
            await page.getByRole("button", { name: "Tema escuro" }).click();
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(process.env.HOME_SCREEN_DIR, `home-app-${width}-${theme}.png`),
          });
        }
      }
    }
    await page.locator("#deliveries .delivery-item").first().click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("task");
  } finally {
    await page.close();
  }
}, 60000);
