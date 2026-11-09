import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let page: Page;
let vite: ReturnType<typeof Bun.spawn>;
let state: string;
const token = `marketplace-${crypto.randomUUID()}`;
const base = "http://localhost:1420";
const registry = `file://${ROOT}/marketplace/index.json`;

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  expect(await check()).toBe(true);
}

beforeAll(async () => {
  state = mkdtempSync(join(homedir(), "boto-marketplace-test-"));
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    BOTO_MARKETPLACE_URL: registry,
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  vite = Bun.spawn([process.execPath, "run", "dev", "--port", "1420"], {
    cwd: join(ROOT, "apps/desktop"),
    stdout: "ignore",
    stderr: "inherit",
  });
  await until(async () =>
    fetch(base)
      .then((response) => response.ok)
      .catch(() => false),
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
  await page.locator('[data-nav="marketplace"]').click();
  await until(async () => (await page.locator("#mk-grid .mk-card").count()) > 0);
}, 30000);

afterAll(async () => {
  await browser?.close();
  rpc?.close();
  vite?.kill();
  daemon?.proc.kill();
  await Promise.all([vite?.exited, daemon?.proc.exited]);
  await stopTestChildren(state);
  if (state) rmSync(state, { recursive: true, force: true });
}, 30000);

test("builtin apps, keyboard tabs, search, category and empty filters use real registry", async () => {
  const apps = await rpc.request("marketplace.list", { kind: "app" });
  expect(await page.locator("#mk-grid .mk-card").count()).toBe(apps.items.length);
  expect(await page.locator('#mk-grid img[src="/assets/brands/notion-icon.svg"]').count()).toBe(1);
  await page.locator("#mk-tab-apps").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await page.locator("#mk-tab-skills").getAttribute("aria-selected")).toBe("true");
  await until(async () => (await page.locator("#mk-grid .mk-card").count()) === 3);
  await page.locator("#mk-search").fill("release-notes");
  await until(async () => (await page.locator("#mk-grid .mk-card").count()) === 1);
  expect(await page.locator("#mk-featured").count()).toBe(0);
  await page.locator("#mk-search").fill("");
  await page.getByRole("radio", { name: /Documentação/ }).click();
  await until(async () => (await page.locator("#mk-grid .mk-card").count()) === 1);
  expect(await page.locator("#mk-grid").innerText()).toContain("release-notes");
  await page.locator("#mk-search").fill("nada-corresponde-a-isto");
  await page.getByRole("heading", { name: "Nada encontrado" }).waitFor();
  await page.getByRole("button", { name: "Limpar filtros" }).click();
  await until(async () => (await page.locator("#mk-grid .mk-card").count()) === 3);
}, 30000);

test("skill installs and removes with confirmation, daemon state and focus restoration", async () => {
  const card = page.locator("#mk-grid .mk-card").filter({ hasText: "code-review" });
  await card.click();
  await page.locator("#mk-panel").waitFor();
  expect(await page.locator("#mkp-title").innerText()).toBe("code-review");
  await page.getByRole("button", { name: "Instalar", exact: true }).click();
  await page.locator("#mk-panel .badge-success").waitFor();
  expect((await rpc.request("skills.list", {})).some((skill) => skill.name === "code-review")).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await until(async () => card.evaluate((element) => element === document.activeElement));
  expect(await card.innerText()).toContain("Instalado");
  await card.click();
  await page.locator("#mk-panel").getByRole("button", { name: "Remover", exact: true }).click();
  await page.locator("#confirm-cancel").click();
  expect((await rpc.request("skills.list", {})).some((skill) => skill.name === "code-review")).toBe(
    true,
  );
  await page.locator("#mk-panel").getByRole("button", { name: "Remover", exact: true }).click();
  await page.locator("#confirm-ok").click();
  await page.getByRole("button", { name: "Instalar", exact: true }).waitFor();
  expect((await rpc.request("skills.list", {})).some((skill) => skill.name === "code-review")).toBe(
    false,
  );
  await page.keyboard.press("Escape");
  await until(async () => !(await card.innerText()).includes("Instalado"));
}, 30000);

test("app secret is required before installation and app removal uses connected id", async () => {
  await page.locator("#mk-tab-apps").click();
  const card = page.locator("#mk-grid .mk-card").filter({ hasText: "Notion" });
  await card.click();
  await page.getByRole("button", { name: "Instalar", exact: true }).click();
  expect(
    await page
      .locator('#mk-panel input[type="password"]')
      .evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
  ).toBe(true);
  expect((await rpc.request("apps.list", {})).some((app) => app.catalogId === "notion")).toBe(
    false,
  );
  await page.locator('#mk-panel input[type="password"]').fill("isolated-test-value");
  await page.getByRole("button", { name: "Instalar", exact: true }).click();
  await page.locator("#mk-panel .badge-success").waitFor();
  expect((await rpc.request("apps.list", {})).some((app) => app.catalogId === "notion")).toBe(true);
  await page.locator("#mk-panel").getByRole("button", { name: "Remover", exact: true }).click();
  await page.locator("#confirm-ok").click();
  await page.getByRole("button", { name: "Instalar", exact: true }).waitFor();
  expect((await rpc.request("apps.list", {})).some((app) => app.catalogId === "notion")).toBe(
    false,
  );
  await page.keyboard.press("Escape");
}, 30000);

test("source failures are non-blocking, without raw registry errors", async () => {
  const missing = `file://${state}/missing-registry.json`;
  await rpc.request("marketplace.setSources", { urls: [registry, missing] });
  await page.locator("#mk-tab-skills").click();
  await page.getByText(`Não foi possível carregar ${missing}.`, { exact: true }).waitFor();
  expect(await page.locator("#mk-grid .mk-card").count()).toBe(3);
  expect(await page.locator(".mk-notice").innerText()).not.toContain("ENOENT");
  await rpc.request("marketplace.setSources", { urls: [registry] });
  await page.locator("#mk-tab-apps").click();
}, 30000);

test("plugin includes resolve to installed skill names on removal", async () => {
  await page.locator("#mk-tab-plugins").click();
  await page.locator("#mk-grid .mk-card").first().click();
  expect(await page.locator("#mkp-body li").count()).toBe(3);
  await page.getByRole("button", { name: "Instalar", exact: true }).click();
  await page.locator("#mk-panel .badge-success").waitFor();
  expect((await rpc.request("skills.list", {})).length).toBe(3);
  await page.locator("#mk-panel").getByRole("button", { name: "Remover", exact: true }).click();
  await page.locator("#confirm-ok").click();
  await page.getByRole("button", { name: "Instalar", exact: true }).waitFor();
  expect((await rpc.request("skills.list", {})).length).toBe(0);
  await page.keyboard.press("Escape");
}, 30000);

test("empty types stay honest and checksum install failures stay inline", async () => {
  const custom = join(state, "registry.json");
  writeFileSync(custom, JSON.stringify({ version: 1, items: [] }));
  await rpc.request("marketplace.setSources", { urls: [`file://${custom}`] });
  await page.locator("#mk-tab-skills").click();
  await page.getByText("Nenhum item neste tipo ainda.", { exact: true }).waitFor();
  const entry = JSON.parse(readFileSync(join(ROOT, "marketplace/index.json"), "utf8")).items[0];
  writeFileSync(
    custom,
    JSON.stringify({
      version: 1,
      items: [
        { ...entry, url: `${ROOT}/marketplace/skills/code-review.md`, sha256: "0".repeat(64) },
      ],
    }),
  );
  await page.locator("#mk-tab-apps").click();
  await page.locator("#mk-tab-skills").click();
  await page.locator("#mk-grid .mk-card").filter({ hasText: "code-review" }).click();
  await page.getByRole("button", { name: "Instalar", exact: true }).click();
  await page.locator("#mk-panel [role=alert]").waitFor();
  expect(await page.locator("#mk-panel [role=alert]").innerText()).toContain("checksum mismatch");
  expect((await rpc.request("skills.list", {})).length).toBe(0);
  expect(await page.getByRole("button", { name: "Instalar", exact: true }).isEnabled()).toBe(true);
  await page.keyboard.press("Escape");
  await rpc.request("marketplace.setSources", { urls: [registry] });
  await page.locator("#mk-tab-apps").click();
}, 30000);

test("responsive grids, themes and sheet match the shared prototype skeleton", async () => {
  const shots = process.env.MARKETPLACE_SCREEN_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  await page.locator('.toast button[aria-label="Fechar"]').evaluateAll((buttons) => {
    for (const button of buttons) (button as HTMLButtonElement).click();
  });
  for (const [width, height, columns] of [
    [1440, 900, 3],
    [1024, 768, 3],
    [768, 1024, 2],
    [390, 844, 1],
  ] as const) {
    await page.setViewportSize({ width, height });
    await until(async () => (await page.locator("#mk-grid .mk-card").count()) > 0);
    expect(
      await page
        .locator("#mk-grid")
        .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length),
    ).toBe(columns);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const theme of ["dark", "light"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page.getByRole("button", { name: "Tema escuro" }).click();
      await until(
        async () =>
          (await page.locator(".sb-logo").getAttribute("src")) ===
          (theme === "light" ? "/assets/boto-logo-claro.svg" : "/assets/boto-logo.svg"),
      );
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      if (shots)
        await page.screenshot({
          path: join(shots, `app-${width}-${theme}.png`),
          animations: "disabled",
        });
    }
  }
  await page.locator("#mk-grid .mk-card").filter({ hasText: "Notion" }).click();
  expect(
    await page.locator("#mk-panel").evaluate((panel) => panel.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(320);
  if (shots) await page.screenshot({ path: join(shots, "app-sheet-390-light.png") });
  await page.mouse.click(10, 400);
  await until(async () => !(await page.locator("#mk-panel").count()));
}, 30000);
