import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  removeDir,
  startDaemon,
  stopDaemon,
} from "../../../packages/daemon/test/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: ReturnType<typeof Bun.spawn>;
let state: string;
const token = `templates-${crypto.randomUUID()}`;
const base = "http://localhost:1420";

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), "boto-templates-ui-"));
  daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    BOTO_MARKETPLACE_URL: `file://${join(ROOT, "marketplace/index.json")}`,
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  await rpc.request("agents.create", { name: "Modelos", provider: "devin" });
  vite = Bun.spawn(
    [process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420", "--strictPort"],
    { cwd: ROOT, stdout: "ignore", stderr: "inherit" },
  );
  await until(async () => {
    if (vite.exitCode !== null) throw new Error("Vite exited before startup");
    return fetch(base)
      .then((response) => response.ok)
      .catch(() => false);
  }, 15_000);
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  vite?.kill();
  await vite?.exited;
  if (daemon) await stopDaemon(daemon, rpc);
  if (state) await removeDir(state);
}, 30_000);

async function until(check: () => Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  expect(await check()).toBe(true);
}

async function openTemplates(page: Page) {
  if (await page.getByRole("button", { name: "Abrir menu" }).isVisible()) {
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.locator('#sheet [data-nav="templates"]').click();
  } else await page.locator('#sidebar [data-nav="templates"]').click();
  await page.locator("#templates-title").waitFor();
}

test("real template cards match daemon data and hand off to the composer without starting work", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    const templates = await rpc.request("templates.list", {});
    for (const selected of ["ci", "research", "sales", "inbox"]) {
      await openTemplates(page);
      await until(async () => (await page.locator(".template").count()) === templates.length);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("templates-title");
      for (const template of templates) {
        const card = page.locator(`[data-template="${template.id}"]`);
        expect(await card.locator(".template-name").innerText()).toBe(template.name);
        expect(await card.locator(".template-desc").innerText()).toBe(template.description);
        expect(await card.locator("use").getAttribute("href")).toBe(
          `/assets/icons.svg#i-${template.icon}`,
        );
      }
      expect(await page.locator('[data-template="ci"] .template-meta').innerText()).toBe(
        "Agora · com aprovação",
      );
      expect(await page.locator('[data-template="research"] .template-meta').innerText()).toBe(
        "Agora · só navegador",
      );
      expect(await page.locator('[data-template="sales"] .template-meta').innerText()).toBe(
        "Rotina · segunda às 9h",
      );
      expect(await page.locator('[data-template="inbox"] .template-meta').innerText()).toBe(
        "Rotina · todo dia às 8h",
      );
      await page.locator(`[data-template="${selected}"]`).focus();
      await page.keyboard.press("Enter");
      await page.locator("#view-new").waitFor();
      expect((await rpc.request("tasks.list", {})).items).toHaveLength(0);
      expect(await rpc.request("routines.list", {})).toHaveLength(0);
    }
    await openTemplates(page);
    await page.getByRole("button", { name: "Tarefa em branco" }).click();
    await page.locator("#view-new").waitFor();
  } finally {
    await page.close();
  }
}, 30_000);

test("template changes, hiding, restoration and genuine empty sections update live", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const builtins = await rpc.request("templates.list", {});
  let customId: string | undefined;
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await openTemplates(page);
    await until(async () => (await page.locator(".template").count()) === builtins.length);
    const custom = await rpc.request("templates.create", {
      kind: "routine",
      name: "Revisão de arquivos",
      description: "Conferir os arquivos do projeto.",
      prompt: "echo:files",
      icon: "folder",
      schedule: "every 2h",
      requireApproval: true,
    });
    customId = custom.id;
    await page.getByText(custom.name, { exact: true }).waitFor();
    expect(await page.locator(`[data-template="${custom.id}"] .template-meta`).innerText()).toBe(
      "Rotina · a cada 2 horas",
    );
    await rpc.request("templates.update", { id: custom.id, name: "Revisão atualizada" });
    await page.getByText("Revisão atualizada", { exact: true }).waitFor();
    for (const template of [...builtins, custom])
      await rpc.request("templates.delete", { id: template.id });
    await until(async () => (await page.locator(".template").count()) === 0);
    expect(await page.getByText("Nenhum modelo para executar uma vez.").isVisible()).toBe(true);
    expect(await page.getByText("Nenhum modelo de rotina.").isVisible()).toBe(true);
    await rpc.request("templates.restore", { id: "ci" });
    await page.locator('[data-template="ci"]').waitFor();
    expect(await page.getByText("Nenhum modelo para executar uma vez.").count()).toBe(0);
    expect(await page.getByText("Nenhum modelo de rotina.").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await page.close();
    for (const template of builtins) await rpc.request("templates.restore", { id: template.id });
    if (customId) {
      const remaining = await rpc.request("templates.list", {});
      if (remaining.some((template) => template.id === customId))
        await rpc.request("templates.delete", { id: customId });
    }
  }
}, 30_000);

test("an unavailable connection never substitutes sample templates and reload recovers real data", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=invalid`);
    await openTemplates(page);
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain(
      "Não consegui carregar os modelos.",
    );
    expect(await page.locator(".template").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Tentar de novo" }).isDisabled()).toBe(true);
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await page.reload();
    await openTemplates(page);
    await until(async () => (await page.locator(".template").count()) === 6);
    expect(await page.getByRole("alert").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);
