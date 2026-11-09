import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: ReturnType<typeof Bun.spawn>;
let stopped = false;
const token = crypto.randomUUID();
const dirs: string[] = [];
const base = "http://localhost:1420";
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(50);
  }
}
beforeAll(async () => {
  dirs.push(tmp("shell-data-"), tmp("shell-agents-"), tmp("shell-acp-"));
  daemon = await startDaemon(dirs[0], dirs[1], token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: dirs[2],
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  vite = Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  await until(async () =>
    fetch(base)
      .then((r) => r.ok)
      .catch(() => false),
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  vite?.kill();
  await vite?.exited;
  if (daemon && !stopped) await stopDaemon(daemon, rpc, dirs[2]);
  for (const dir of dirs) await removeDir(dir);
}, 60000);

test("real shell profile, counts, task history, privacy and accent-insensitive search", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await page.locator("#home-title").waitFor();
    await until(async () =>
      (await page.locator(".sb-history").innerText()).includes("Nenhuma tarefa ainda."),
    );
    await rpc.request("profile.update", { name: "Ana Souza" });
    await until(async () => (await page.locator("[data-user-avatar]").innerText()) === "AS");
    expect(await page.locator("[data-user-name]").innerText()).toBe("Ana Souza");
    const agent = await rpc.request("agents.create", {
      name: "Boto de teste",
      provider: "devin",
      instructions: "",
    });
    await until(async () => (await page.locator("[data-agent-count]").innerText()) === "1");
    await rpc.request("routines.create", {
      agentId: agent.id,
      name: "Revisão",
      prompt: "echo:oi",
      schedule: "daily 08:00",
    });
    await until(async () => (await page.locator("[data-routine-count]").innerText()) === "1");
    const done = await rpc.request("tasks.create", {
      agentId: agent.id,
      text: "echo:relatório",
      requireApproval: false,
    });
    await until(async () => (await rpc.request("tasks.get", { id: done.id })).situation === "done");
    await until(
      async () =>
        (await page
          .locator(`.sb-group:has(h2:text-is("Concluídas")) [data-task-id="${done.id}"]`)
          .count()) === 1,
    );
    const slow = await rpc.request("tasks.create", {
      agentId: agent.id,
      text: "slow",
      requireApproval: false,
    });
    await page
      .locator(`.sb-group:has(h2:text-is("Em andamento")) [data-task-id="${slow.id}"]`)
      .waitFor();
    const secret = await rpc.request("tasks.create", {
      agentId: agent.id,
      text: "slow",
      private: true,
      requireApproval: false,
    });
    await page.waitForTimeout(200);
    expect(await page.locator(`[data-task-id="${secret.id}"]`).count()).toBe(0);
    await page.locator(`[data-task-id="${done.id}"]`).click();
    expect(await page.locator("#main").getAttribute("data-view")).toBe("task");
    expect(await page.locator(`[data-task-id="${done.id}"]`).getAttribute("aria-current")).toBe(
      "page",
    );
    await page.getByRole("switch", { name: "Privada" }).click();
    await until(async () => (await rpc.request("profile.get", {})).defaults.private);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("RELATORIO");
    await page.getByRole("option", { name: /relatório/ }).waitFor();
    await page.keyboard.press("Enter");
    await until(async () => !(await page.locator("#command").isVisible()));
    expect(await page.locator(`[data-task-id="${done.id}"]`).getAttribute("aria-current")).toBe(
      "page",
    );
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("inexistente-12345");
    await until(
      async () =>
        (await page.locator("#command-empty").innerText()) ===
        "Nenhum resultado para “inexistente-12345”.",
    );
    expect(await page.getByRole("option").count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Abrir menu", exact: true }).click();
    await page.locator(`#sheet [data-task-id="${done.id}"]`).click();
    await until(async () => !(await page.locator("#sheet").isVisible()));
  } finally {
    await page.close();
  }
}, 60000);

test("daemon disconnect reports search failure and reverts the private default", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await until(
      async () =>
        (await page.getByRole("switch", { name: "Privada" }).getAttribute("aria-checked")) ===
        "true",
    );
    await stopDaemon(daemon, rpc, dirs[2]);
    stopped = true;
    await page.getByRole("switch", { name: "Privada" }).click();
    await page.getByText("Não foi possível atualizar o modo privado.").waitFor();
    expect(await page.getByRole("switch", { name: "Privada" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("relatorio");
    await until(
      async () => (await page.locator("#command-empty").innerText()) === "Não foi possível buscar.",
    );
  } finally {
    await page.close();
  }
}, 60000);
