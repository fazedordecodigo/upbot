import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { type Browser, chromium } from "playwright-core";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
import { startVite } from "./vite";

let daemon: DaemonHandle;
let rpc: DaemonClient;
let browser: Browser;
let vite: Awaited<ReturnType<typeof startVite>> | undefined;
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
  vite = await startVite();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  await vite?.stop();
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

test("palette keeps keyboard selections visible and opens the selected real task", async () => {
  const agent = await rpc.request("agents.create", { name: "Busca", provider: "devin" });
  await rpc.request("queue.pause", { agentId: agent.id });
  for (let n = 0; n < 22; n++)
    await rpc.request("tasks.create", {
      agentId: agent.id,
      text: `echo:Resultado teclado ${n}`,
      private: false,
    });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${base}/#port=${daemon.port}&token=${token}`);
    await page.locator("#home-title").waitFor();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("Resultado teclado");
    await until(async () => (await page.getByRole("option").count()) === 20);
    const visible = () =>
      page.locator('[role="option"][aria-selected="true"]').evaluate((el) => {
        const list = document.getElementById("command-list")?.getBoundingClientRect();
        const option = el.getBoundingClientRect();
        return Boolean(list && option.top >= list.top && option.bottom <= list.bottom);
      });
    for (let n = 0; n < 19; n++) await page.keyboard.press("ArrowDown");
    await until(visible);
    expect(await page.getByRole("combobox").getAttribute("aria-activedescendant")).toBe(
      "command-option-19",
    );
    await page.keyboard.press("ArrowDown");
    await until(visible);
    expect(await page.getByRole("combobox").getAttribute("aria-activedescendant")).toBe(
      "command-option-0",
    );
    await page.keyboard.press("ArrowUp");
    await until(visible);
    const selected = await rpc.request("tasks.search", { query: "Resultado teclado", limit: 20 });
    await page.keyboard.press("Enter");
    await until(async () => (await page.locator("#main").getAttribute("data-view")) === "task");
    await until(
      async () => (await page.locator("#task-title").innerText()) === selected.tasks[19]?.title,
    );
    expect(await page.locator("#task-title").innerText()).toBe(selected.tasks[19]?.title);
  } finally {
    await page.close();
  }
}, 60000);

test("crash reconnect invalidates old permissions without granting them; live permissions still work", async () => {
  let target = daemon.port;
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    const upstream = createConnection({ port: target, host: "127.0.0.1" });
    for (const peer of [socket, upstream]) {
      sockets.add(peer);
      peer.on("close", () => sockets.delete(peer));
    }
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  const page = await browser.newPage();
  try {
    const agent = await rpc.request("agents.create", { name: "Reinício", provider: "devin" });
    const task = await rpc.request("tasks.create", {
      agentId: agent.id,
      text: "tool",
      private: false,
    });
    await page.goto(`${base}/#port=${address.port}&token=${token}&task=${task.id}`);
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).waitFor();
    expect((await rpc.request("permissions.list", {})).some((p) => p.agentId === agent.id)).toBe(
      true,
    );
    await stopDaemon(daemon, rpc, dirs[2]);
    stopped = true;
    await until(
      async () =>
        (await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).count()) ===
        0,
    );
    daemon = await startDaemon(dirs[0], dirs[1], token, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: dirs[2],
    });
    stopped = false;
    target = daemon.port;
    rpc = await DaemonClient.connect(daemon.port, token);
    await page.getByText("Este pedido não está mais disponível.", { exact: true }).waitFor();
    expect((await rpc.request("tasks.get", { id: task.id })).situation).toBe("muted");
    expect(await rpc.request("permissions.list", {})).toEqual([]);
    expect(
      (await rpc.request("tasks.history", { id: task.id })).items.some(
        (i) => i.kind === "agent_message" && i.text.includes("permission:allow"),
      ),
    ).toBe(false);
    await page.reload();
    await page.getByText("Este pedido não está mais disponível.", { exact: true }).waitFor();
    const next = await rpc.request("tasks.create", {
      agentId: agent.id,
      text: "tool",
      private: false,
    });
    await page.locator(`[data-task-id="${next.id}"]`).click();
    expect(
      await page.getByText("Este pedido não está mais disponível.", { exact: true }).count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Permitir nesta sessão", exact: true }).click();
    await page.getByText("permission:allow_once", { exact: true }).waitFor();
    expect(await rpc.request("permissions.list", {})).toEqual([]);
    const input = page.locator("#instruct-input");
    await input.fill("echo:instrução teclado");
    await input.press("Shift+Enter");
    await input.press("x");
    expect(await input.inputValue()).toBe("echo:instrução teclado\nx");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect(await input.inputValue()).toBe("echo:instrução teclado\nx");
    await input.press("Enter");
    await until(async () => (await input.inputValue()) === "");
    await until(async () =>
      (await rpc.request("tasks.history", { id: next.id })).items.some(
        (i) => i.kind === "user_message" && i.text === "echo:instrução teclado\nx",
      ),
    );
  } finally {
    await page.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}, 90000);

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
