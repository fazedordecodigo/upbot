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
let vite: ReturnType<typeof Bun.spawn> | undefined;
let state: string;
const token = `responsive-test-${crypto.randomUUID()}`;
const base = "http://localhost:1420";
const up = () =>
  fetch(base)
    .then((response) => response.ok)
    .catch(() => false);

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "boto-responsive-test-"));
  mkdirSync(join(state, "fake"));
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    BOTO_ACP_COMMAND_GROK: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: join(state, "fake"),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  if (!(await up())) {
    vite = Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420"], {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let i = 0; i < 300 && !(await up()); i++) await Bun.sleep(100);
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  vite?.kill();
  if (vite) await vite.exited;
  if (daemon) await stopDaemon(daemon, rpc, state);
  if (state) rmSync(state, { recursive: true, force: true });
}, 30000);

test("sidebar resizer resets with Enter and the Sheet fills the viewport height", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    const resizer = page.locator("#sb-resizer");
    await resizer.focus();
    await page.keyboard.press("End");
    expect(await resizer.getAttribute("aria-valuenow")).toBe("400");
    await page.keyboard.press("Enter");
    expect(await resizer.getAttribute("aria-valuenow")).toBe("272");
    expect(Math.round((await page.locator(".sidebar").boundingBox())?.width ?? 0)).toBe(272);

    for (const [width, height] of [
      [1023, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: "Abrir menu" }).click();
      const sheet = await page.locator("dialog.sheet[open]").boundingBox();
      expect(sheet?.y).toBe(0);
      expect(Math.round(sheet?.height ?? 0)).toBe(height);
      await page.keyboard.press("Escape");
      await page.locator("dialog.sheet[open]").waitFor({ state: "detached" });
    }
  } finally {
    await page.close();
  }
}, 60000);

test("theme toggle keeps the prototype moon icon and page heads keep actions inline", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  page.setDefaultTimeout(30000);
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    const toggle = page.getByRole("button", { name: "Tema escuro" });
    for (let i = 0; i < 2; i++) {
      expect(await toggle.locator("use").getAttribute("href")).toEndWith("#i-moon");
      await toggle.click();
    }
    for (const [view, action] of [
      ["Rotinas", "Nova rotina"],
      ["Agentes", "Novo agente"],
    ] as const) {
      await page.getByRole("button", { name: "Abrir menu" }).click();
      await page.locator("dialog.sheet").getByRole("button", { name: view, exact: true }).click();
      const head = page.locator(".view:not([hidden]) .page-head");
      const title = await head.locator("h1").boundingBox();
      const button = await head.getByRole("button", { name: action }).boundingBox();
      expect(button?.x).toBeGreaterThan((title?.x ?? 0) + 100);
      expect(button?.y ?? 0).toBeLessThan((title?.y ?? 0) + 200);
    }
  } finally {
    await page.close();
  }
}, 60000);

test("touch screens get 44px hit targets for switches and fields", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const hit = await page.locator("#private-switch").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const ys = [box.top - 10, box.bottom + 10];
      return ys.map((y) => document.elementFromPoint(x, y) === element);
    });
    expect(hit).toEqual([true, true]);
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.locator("dialog.sheet").getByRole("button", { name: "Configurações" }).click();
    await page.getByRole("tab", { name: "Você e a memória" }).click();
    const heights = await page
      .locator(".view:not([hidden]) :is(.input, .textarea, select)")
      .evaluateAll((items) =>
        items
          .filter((item) => item.getClientRects().length)
          .map((item) => item.getBoundingClientRect().height),
      );
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
}, 60000);
