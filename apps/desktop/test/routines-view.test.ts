import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopDaemon,
} from "../../../packages/daemon/test/helpers";
import { startVite } from "./vite";

let browser: Browser;
let vite: Awaited<ReturnType<typeof startVite>> | undefined;
let daemon: DaemonHandle;
let rpc: DaemonClient;
let directory: string;
const token = crypto.randomUUID();
const base = "http://localhost:1420";

beforeAll(async () => {
  directory = mkdtempSync(join(homedir(), "routines-test-"));
  daemon = await startDaemon(join(directory, "data"), join(directory, "agents"), token, {
    BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: join(directory, "fake"),
    BOTO_ROUTINE_TICK_MS: "3600000",
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  vite = await startVite();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  await vite?.stop();
  if (daemon) await stopDaemon(daemon, rpc, join(directory, "fake"));
  if (directory) rmSync(directory, { recursive: true, force: true });
}, 30000);

async function openRoutines(page: Page) {
  await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
  await page.locator("#home-title").waitFor();
  if (await page.getByRole("button", { name: "Abrir menu", exact: true }).isVisible())
    await page.getByRole("button", { name: "Abrir menu", exact: true }).click();
  await page.locator('[data-nav="routines"]:visible').click();
  await page.locator("#routines-title").waitFor();
}

test("manual routines are visible with run, pause, resume and delete controls", async () => {
  const agent = await rpc.request("agents.create", { name: "Manual bot", provider: "devin" });
  const manual = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Manual report",
    prompt: "echo:report",
    private: false,
    requireApproval: false,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await openRoutines(page);
    const row = page.locator("#rt-manual .rt-row").filter({ hasText: "Manual report" });
    await row.waitFor();
    expect(await page.locator("#rt-manual-title").innerText()).toBe("Manuais");
    await row.getByRole("button", { name: "Pausar rotina", exact: true }).click();
    await row.getByText("Pausada", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Retomar rotina", exact: true }).click();
    await row.getByText("Ativa", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Executar agora", exact: true }).click();
    await page.getByText("Rotina iniciada", { exact: true }).waitFor();
    expect((await rpc.request("routines.runs", { id: manual.id })).length).toBeGreaterThan(0);
    await row.getByRole("button", { name: "Excluir rotina", exact: true }).click();
    await page.locator("#confirm-ok").click();
    await row.waitFor({ state: "detached" });
    expect(
      (await rpc.request("routines.list", {})).some((routine) => routine.id === manual.id),
    ).toBe(false);
  } finally {
    await page.close();
    if ((await rpc.request("routines.list", {})).some((routine) => routine.id === manual.id))
      await rpc.request("routines.delete", { id: manual.id });
  }
}, 30_000);

test("fresh daemon shows both empty states and the composer action", async () => {
  const page = await browser.newPage();
  try {
    await openRoutines(page);
    await page
      .getByText("Nenhuma rotina recorrente. Crie uma em Nova rotina ou a partir de um modelo.")
      .waitFor();
    await page
      .getByText("Nenhuma tarefa agendada. Crie uma a partir de um modelo ou use Nova rotina.")
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const action = await page.locator("#new-routine").boundingBox();
    const subtitle = await page.locator("#view-routines .page-sub").boundingBox();
    if (!action || !subtitle) throw new Error("missing routine header");
    expect(action.x).toBeGreaterThan(subtitle.x + subtitle.width);
    expect(action.y).toBeLessThan(subtitle.y + subtitle.height);
    await page.locator("#new-routine").click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("new");
    await page.locator("#composer-input").waitFor();
  } finally {
    await page.close();
  }
}, 30000);

test("real routines list, pause, resume, run, confirm deletion and events", async () => {
  const agent = await rpc.request("agents.create", { name: "Bot de operações", provider: "devin" });
  const recurring = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Resumo diário",
    prompt: "echo:resumo",
    schedule: "daily 08:00",
    private: true,
  });
  const once = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Entrega agendada",
    prompt: "echo:entrega",
    runAt: Date.now() + 3600000,
  });
  const page = await browser.newPage();
  try {
    await openRoutines(page);
    const row = page.locator("#rt-recurring .rt-row").filter({ hasText: recurring.name });
    await row.waitFor();
    expect(await row.innerText()).toContain("Todo dia às 08:00");
    expect(await row.innerText()).toContain(agent.name);
    expect(await row.innerText()).toContain("Próxima:");
    expect(await row.innerText()).toContain("Privada");
    await page.locator("#rt-once .rt-row").filter({ hasText: once.name }).waitFor();
    expect(await page.locator("#rt-once .rt-meta").innerText()).toContain("Em ");
    expect(await page.locator("#rt-once .rt-meta").innerText()).not.toContain("Próxima:");
    await row.getByRole("button", { name: "Pausar rotina", exact: true }).click();
    await row.getByText("Pausada", { exact: true }).waitFor();
    expect(
      (await rpc.request("routines.list", {})).find((r) => r.id === recurring.id)?.enabled,
    ).toBe(false);
    await row.getByRole("button", { name: "Retomar rotina", exact: true }).click();
    await row.getByText("Ativa", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Executar agora", exact: true }).click();
    await page.getByText("Rotina iniciada", { exact: true }).waitFor();
    expect(await rpc.request("routines.runs", { id: recurring.id })).toEqual([]);
    await row.getByRole("button", { name: "Excluir rotina", exact: true }).click();
    await page.locator("#confirm[open]").waitFor();
    expect(
      await page.locator("#confirm-cancel").evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator("#confirm").waitFor({ state: "hidden" });
    await row.getByRole("button", { name: "Excluir rotina", exact: true }).click();
    await page.locator("#confirm-ok").click();
    await row.waitFor({ state: "hidden" });
    expect(await rpc.request("routines.list", {})).toHaveLength(1);
    await page.getByText("Rotina excluída", { exact: true }).waitFor();
    await rpc.request("routines.create", {
      agentId: agent.id,
      name: "Resumo diário",
      prompt: "echo:resumo",
      schedule: "daily 08:00",
    });
    await rpc.request("routines.create", {
      agentId: agent.id,
      name: "Revisão semanal",
      prompt: "echo:revisão",
      schedule: "weekly mon 09:00",
      private: true,
    });
    await page.locator("#rt-recurring .rt-row").nth(1).waitFor();
    if (process.env.BOTO_ROUTINES_SHOTS) {
      const shots = process.env.BOTO_ROUTINES_SHOTS;
      mkdirSync(shots, { recursive: true });
      while (await page.locator(".toaster button").count())
        await page.locator(".toaster button").first().click();
      for (const theme of ["dark", "light"])
        for (const [width, height] of [
          [1440, 900],
          [1024, 768],
          [390, 844],
        ] as const) {
          await page.setViewportSize({ width, height });
          await page.evaluate(
            (theme) => document.documentElement.setAttribute("data-theme", theme),
            theme,
          );
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(shots, `app-${theme}-${width}x${height}.png`),
            fullPage: true,
          });
        }
    }
  } finally {
    await page.close();
  }
}, 60000);

test("failed manual run reports the daemon error and restores action buttons", async () => {
  const agent = await rpc.request("agents.create", { name: "Bot removido", provider: "devin" });
  const routine = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Rotina sem bot",
    prompt: "echo:teste",
    schedule: "daily 08:00",
  });
  await rpc.request("agents.delete", { id: agent.id });
  let message = "";
  try {
    await rpc.request("routines.run", { id: routine.id });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message.length).toBeGreaterThan(0);
  const page = await browser.newPage();
  try {
    await openRoutines(page);
    const row = page.locator(".rt-row").filter({ hasText: routine.name });
    const button = row.getByRole("button", { name: "Executar agora", exact: true });
    await button.click();
    await page.locator(".toast").filter({ hasText: message }).waitFor();
    expect(await button.isEnabled()).toBe(true);
    expect(await rpc.request("routines.runs", { id: routine.id })).toHaveLength(0);
  } finally {
    await page.close();
  }
}, 30000);

test("returned run errors are shown without success and allow retry", async () => {
  const agent = await rpc.request("agents.create", { name: "Retry bot", provider: "devin" });
  const routine = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Retry report",
    prompt: "echo:report",
    private: false,
    requireApproval: false,
  });
  const db = new Database(join(directory, "data", "boto.db"));
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    db.exec(`CREATE TRIGGER fail_routine_task BEFORE INSERT ON tasks
      WHEN NEW.routine_id = '${routine.id}'
      BEGIN SELECT RAISE(ABORT, 'Routine task creation failed'); END`);
    const failed = await rpc.request("routines.run", { id: routine.id });
    expect(failed.error).toBe("Routine task creation failed");
    expect(failed.taskId).toBeNull();
    await openRoutines(page);
    const row = page.locator(".rt-row").filter({ hasText: routine.name });
    const button = row.getByRole("button", { name: "Executar agora", exact: true });
    await button.click();
    await page.locator(".toast").filter({ hasText: failed.error! }).waitFor();
    expect(await page.getByText("Rotina iniciada", { exact: true }).count()).toBe(0);
    expect(await button.isEnabled()).toBe(true);
    db.exec("DROP TRIGGER fail_routine_task");
    await button.click();
    await page.getByText("Rotina iniciada", { exact: true }).waitFor();
    const runs = await rpc.request("routines.runs", { id: routine.id });
    expect(runs.filter((run) => run.error === failed.error)).toHaveLength(2);
    expect(runs.some((run) => run.error === null && run.taskId !== null)).toBe(true);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_routine_task");
    db.close();
    await page.close();
    await rpc.request("routines.delete", { id: routine.id });
  }
}, 30_000);

test("manual routines create sidebar tasks whose tools wait for permission", async () => {
  const agent = await rpc.request("agents.create", {
    name: "Bot com permissão",
    provider: "devin",
  });
  const routine = await rpc.request("routines.create", {
    agentId: agent.id,
    name: "Rotina com permissão",
    prompt: "tool",
    schedule: "daily 08:00",
    requireApproval: true,
  });
  const page = await browser.newPage();
  try {
    await openRoutines(page);
    const row = page.locator(".rt-row").filter({ hasText: routine.name });
    await row.getByRole("button", { name: "Executar agora", exact: true }).click();
    const permission = await rpc.waitForEventWhere(
      "permission.requested",
      (event) => event.agentId === agent.id,
    );
    const [run] = await rpc.request("routines.runs", { id: routine.id });
    if (!run?.taskId) throw new Error("routine did not create a task");
    expect((await rpc.request("tasks.get", { id: run.taskId })).situation).toBe("wait");
    await page.locator(`[data-task-id="${run.taskId}"]:visible`).click();
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).waitFor();
    expect(
      (await rpc.request("permissions.list", {})).some(
        (item) => item.requestId === permission.requestId,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).click();
    await rpc.waitForEventWhere("turn.ended", (turn) => turn.queueId === run.queueId);
    expect((await rpc.request("tasks.get", { id: run.taskId })).situation).toBe("done");
  } finally {
    await page.close();
  }
}, 30000);
