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
  startDaemon,
  stopDaemon,
} from "../../../packages/daemon/test/helpers";
import { startVite } from "./vite";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: Awaited<ReturnType<typeof startVite>> | undefined;
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
  vite = await startVite();
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
    const error = page
      .locator("#view-home [role=alert]")
      .filter({ hasText: "Não consegui carregar os dados." });
    await error.waitFor();
    expect(await error.innerText()).toContain("Tentar de novo");
    expect(await error.innerText()).not.toContain("profile.name");
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
  await vite?.stop();
  if (daemon) await stopDaemon(daemon, rpc, state);
  if (state) rmSync(state, { recursive: true, force: true });
}, 30000);

test("home reflects real profile, running and waiting tasks, deliveries and navigation", async () => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ...(process.env.HOME_SCREEN_DIR ? { recordVideo: { dir: process.env.HOME_SCREEN_DIR } } : {}),
  });
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
    const running = await rpc.request("tasks.create", {
      agentId: runner.id,
      text: "slow",
    });
    await page.locator("#lane-running .lane-item").waitFor();
    const privateRunner = await createAgent("Private runner");
    await rpc.request("tasks.create", { agentId: privateRunner.id, text: "slow", private: true });
    expect(await page.locator("#lane-running-count").innerText()).toBe("1");
    await rpc.request("tasks.create", { agentId: waiter.id, text: "tool" });
    await page
      .locator("#lane-waiting .lane-item")
      .filter({ hasText: "Permissão pendente: Fake tool" })
      .waitFor();
    expect(await page.locator("#lane-waiting-count").innerText()).toBe("1");
    const db = new Database(join(state, "data", "boto.db"));
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      const row = db.query("SELECT * FROM tasks WHERE id = ?").get(running.id) as Record<
        string,
        string | number | null
      >;
      const columns = Object.keys(row);
      const insert = db.query(
        `INSERT INTO tasks (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      db.transaction(() => {
        for (let i = 0; i < 201; i++) {
          const paused = {
            ...row,
            id: `home-paused-${i}`,
            situation: "muted",
            private: 0,
            created_at: Date.now() + i,
          };
          insert.run(...columns.map((column) => paused[column as keyof typeof paused] ?? null));
        }
      }).immediate();
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("#lane-running-count")?.textContent === "202",
      );
      if (process.env.HOME_SCREEN_DIR)
        await page.screenshot({
          path: join(process.env.HOME_SCREEN_DIR, "home-after-pagination.png"),
        });
    } finally {
      db.query("DELETE FROM tasks WHERE id LIKE 'home-paused-%'").run();
      db.close();
    }
    await page.reload();
    await rpc.request("tasks.create", { agentId: writer.id, text: "echo:Resumo entregue" });
    await page.locator("#deliveries .delivery-item").filter({ hasText: "Resumo" }).waitFor();
    expect(await page.locator("#deliveries").innerText()).toContain("Resumo");
    const completedDb = new Database(join(state, "data", "boto.db"));
    completedDb.exec("PRAGMA busy_timeout = 5000");
    try {
      const row = completedDb.query("SELECT * FROM tasks WHERE id = ?").get(running.id) as Record<
        string,
        string | number | null
      >;
      const columns = Object.keys(row);
      const insert = completedDb.query(
        `INSERT INTO tasks (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      completedDb
        .transaction(() => {
          for (let i = 0; i < 201; i++) {
            const completed = {
              ...row,
              id: `home-completed-${i}`,
              situation: "done",
              private: 0,
              created_at: Date.now() + i,
            };
            insert.run(
              ...columns.map((column) => completed[column as keyof typeof completed] ?? null),
            );
          }
        })
        .immediate();
    } finally {
      completedDb.close();
    }
    await page.reload();
    await page.locator("#lane-running .lane-item").waitFor();
    expect(await page.locator("#lane-running").innerText()).not.toContain("Private runner");
    await page
      .locator("#lane-waiting .lane-item")
      .filter({ hasText: "Permissão pendente: Fake tool" })
      .waitFor();
    expect(await page.locator("#lane-running-count").innerText()).toBe("1");
    expect(await page.locator("#lane-waiting-count").innerText()).toBe("1");
    if (process.env.HOME_SCREEN_DIR) {
      mkdirSync(process.env.HOME_SCREEN_DIR, { recursive: true });
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [768, 1024],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ["dark", "light"]) {
          if ((await page.locator("html").getAttribute("data-theme")) !== theme)
            await page.getByRole("button", { name: "Tema escuro" }).click();
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(
              process.env.HOME_SCREEN_DIR,
              `home-${process.env.HOME_PHASE ?? "after"}-app-${width}-${theme}.png`,
            ),
          });
        }
      }
    }
    await page.locator("#deliveries .delivery-item").first().click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("task");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-nav="home"]').click();
    await page.locator("#lane-running .lane-item").first().click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("task");
    await page.locator('[data-nav="home"]').click();
    await page.locator("#lane-waiting .lane-item").first().click();
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).waitFor();
    expect((await rpc.request("permissions.list", {})).length).toBe(1);
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).click();
    await page.locator('[data-nav="home"]').click();
    await page.getByText("Nada aguardando você.", { exact: true }).waitFor();
    await page
      .locator("#view-home")
      .getByRole("button", { name: "Nova tarefa", exact: true })
      .click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("new");
    await stopDaemon(daemon, rpc, state, "SIGTERM");
    daemon = await startDaemon(join(state, "data"), join(state, "agents"), token, {
      BOTO_ACP_COMMAND_GROK: JSON.stringify([process.execPath, FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: join(state, "fake"),
    });
    rpc = await DaemonClient.connect(daemon.port, token);
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await page.reload();
    await page.locator("#greeting").filter({ hasText: ", Emerson." }).waitFor();
    await page.locator("#deliveries .delivery-item").first().waitFor();
  } finally {
    await page.close();
    if (process.env.HOME_SCREEN_DIR)
      await page
        .video()
        ?.saveAs(
          join(
            process.env.HOME_SCREEN_DIR,
            `home-${process.env.HOME_PHASE ?? "after"}-mainflow.webm`,
          ),
        );
  }
}, 60000);
