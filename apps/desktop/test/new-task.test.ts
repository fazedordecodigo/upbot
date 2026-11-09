import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Agent, Task } from "@boto/protocol";
import { whenToRoutine } from "@boto/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
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
let vite: ReturnType<typeof Bun.spawn> | undefined;
let base: string;
let alpha: Agent;
let beta: Agent;
const token = `new-task-${crypto.randomUUID()}`;
const dirs: string[] = [];
const T = 60_000;

async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  expect(await check()).toBe(true);
}

beforeAll(async () => {
  const data = tmp("new-task-data-");
  const agents = tmp("new-task-agents-");
  const state = tmp("new-task-acp-");
  dirs.push(data, agents, state);
  daemon = await startDaemon(data, agents, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: state,
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  alpha = await rpc.request("agents.create", { name: "Alpha", provider: "devin" });
  beta = await rpc.request("agents.create", { name: "Beta", provider: "devin" });
  base = "http://localhost:1420";
  if (
    !(await fetch(base)
      .then((response) => response.ok)
      .catch(() => false))
  )
    vite = Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1420"], {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "pipe",
    });
  await until(
    () =>
      fetch(base)
        .then((response) => response.ok)
        .catch(() => false),
    30_000,
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, T);

afterAll(async () => {
  await browser?.close();
  vite?.kill();
  await vite?.exited;
  if (daemon) await stopDaemon(daemon, rpc, dirs[2]);
  for (const dir of dirs) await removeDir(dir);
}, T);

async function app(templateId?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const route = templateId
    ? `/test/fixtures/new-task.html?templateId=${encodeURIComponent(templateId)}`
    : "/";
  await page.goto(`${base}${route}#port=${daemon.port}&token=${token}`);
  if (!templateId) {
    await page.locator("#home-title").waitFor();
    await page.keyboard.press("Control+Shift+O");
  }
  await page.locator("#composer-input").waitFor();
  await until(() => page.locator("#composer-input").isEnabled());
  return page;
}

async function choose(page: Page, trigger: string, label: string) {
  await page.locator(trigger).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function taskByPrompt(prompt: string) {
  let found: Task | undefined;
  await until(async () => {
    found = (await rpc.request("tasks.list", { includePrivate: true })).items.find(
      (task) => task.prompt === prompt,
    );
    return Boolean(found);
  });
  if (!found) throw new Error("Task missing");
  return found;
}

test(
  "Nova tarefa delegates to the chosen real agent with tools, approval policy and attachments",
  async () => {
    const page = await app();
    try {
      expect(await page.locator("#send").isDisabled()).toBe(true);
      await page.locator("#composer-input").fill("echo:delegada pelo composer");
      await choose(page, "#agent-trigger", "Beta");
      await choose(page, "#where-trigger", "Só terminal Código, scripts e arquivos");
      await page.locator("#approval-switch").click();
      await page.locator("#file-input").setInputFiles({
        name: "contexto.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Contexto real do teste"),
      });
      expect(await page.locator("#composer-files").innerText()).toContain("contexto.txt");
      await page.locator("#composer-input").press("Control+Enter");
      await until(async () => (await page.locator("#main").getAttribute("data-view")) === "task");
      const task = await taskByPrompt("echo:delegada pelo composer");
      expect(task).toMatchObject({
        agentId: beta.id,
        toolMode: "terminal",
        requireApproval: false,
        private: false,
      });
      await until(
        async () => (await rpc.request("tasks.get", { id: task.id })).situation === "done",
        30_000,
      );
      const history = await rpc.request("tasks.history", { id: task.id });
      expect(
        history.items.some(
          (item) =>
            item.kind === "user_message" &&
            item.attachments?.some((file) => file.name === "contexto.txt"),
        ),
      ).toBe(true);
      expect(history.items.some((item) => item.kind === "agent_message")).toBe(true);
    } finally {
      await page.close();
    }
  },
  T,
);

test(
  "timing presets persist real one-shot and recurring routines without starting a task",
  async () => {
    const page = await app();
    try {
      for (const [when, label] of [
        ["in1h", "Daqui a 1 hora"],
        ["tomorrow", "Amanhã às 8h"],
        ["daily", "Todo dia às 8h"],
        ["weekly", "Toda segunda às 9h"],
      ] as const) {
        const prompt = `echo:rotina ${when}`;
        await page.locator("#composer-input").fill(prompt);
        await choose(page, "#agent-trigger", "Beta");
        await choose(page, "#when-trigger", label);
        const before = Date.now();
        await page.locator("#send").click();
        await until(
          async () => (await page.locator("#main").getAttribute("data-view")) === "routines",
        );
        const routine = (await rpc.request("routines.list", {})).find(
          (routine) => routine.prompt === prompt,
        );
        expect(routine).toMatchObject({
          agentId: beta.id,
          enabled: true,
          webhook: false,
          toolMode: "both",
          requireApproval: true,
          private: false,
        });
        const expected = whenToRoutine(when, before);
        expect(routine?.schedule).toBe(expected?.schedule ?? null);
        if (when === "in1h")
          expect(Math.abs((routine?.runAt ?? 0) - (expected?.runAt ?? 0))).toBeLessThan(10_000);
        else expect(routine?.runAt).toBe(expected?.runAt ?? null);
        expect((await rpc.request("routines.runs", { id: routine?.id ?? "" })).length).toBe(0);
        await page.keyboard.press("Control+Shift+O");
        await until(() => page.locator("#composer-input").isEnabled());
      }
    } finally {
      await page.close();
    }
  },
  T,
);

test(
  "private toggle is sent per task and agent deletion does not silently switch the recipient",
  async () => {
    await rpc.request("queue.pause", { agentId: alpha.id });
    const page = await app();
    try {
      await page.locator("#composer-input").fill("echo:tarefa privada");
      await page.locator("#private-switch").click();
      expect(await page.locator("#hero-private").isVisible()).toBe(true);
      await page.locator("#send").click();
      const task = await taskByPrompt("echo:tarefa privada");
      expect(task).toMatchObject({ private: true, agentId: alpha.id, requireApproval: true });
      expect((await rpc.request("tasks.list", {})).items.some((item) => item.id === task.id)).toBe(
        false,
      );
      await until(async () => (await page.locator("#main").getAttribute("data-view")) === "task");
      await rpc.request("tasks.stop", { id: task.id });
      await page.keyboard.press("Control+Shift+O");
      await until(() => page.locator("#composer-input").isEnabled());
      const disposable = await rpc.request("agents.create", {
        name: "Temporário",
        provider: "devin",
      });
      await until(async () => await page.locator("#agent-trigger").isEnabled());
      await choose(page, "#agent-trigger", "Temporário");
      await page.locator("#composer-input").fill("Não trocar o agente");
      await rpc.request("agents.delete", { id: disposable.id });
      await until(() => page.locator("#send").isDisabled());
      expect(await page.locator("#new-task-status").innerText()).toContain("Escolha outro agente");
      expect(await page.locator("#composer-input").inputValue()).toBe("Não trocar o agente");
    } finally {
      await page.close();
      await rpc.request("queue.resume", { agentId: alpha.id });
    }
  },
  T,
);

test(
  "template params prefill from templates.use and create nothing until Delegar",
  async () => {
    for (const schedule of [null, "daily 08:00", "every 2h"]) {
      const template = await rpc.request("templates.create", {
        kind: schedule ? "routine" : "task",
        name: "Modelo de teste",
        prompt: `echo:modelo ${schedule ?? "agora"}`,
        toolMode: "browser",
        requireApproval: false,
        ...(schedule ? { schedule } : {}),
      });
      const beforeTasks = (await rpc.request("tasks.list", {})).items.length;
      const beforeRoutines = (await rpc.request("routines.list", {})).length;
      const page = await app(template.id);
      try {
        expect(await page.locator("#composer-input").inputValue()).toBe(template.prompt);
        expect(await page.locator("#where-label").innerText()).toBe("Só navegador");
        expect(await page.locator("#approval-switch").getAttribute("aria-checked")).toBe("false");
        expect(await page.locator("#when-label").innerText()).toBe(
          schedule === "daily 08:00" ? "Todo dia às 8h" : (schedule ?? "Agora"),
        );
        expect((await rpc.request("tasks.list", {})).items.length).toBe(beforeTasks);
        expect((await rpc.request("routines.list", {})).length).toBe(beforeRoutines);
        await page.locator("#send").click();
        await until(
          async () =>
            (await page.locator("#main").getAttribute("data-view")) ===
            (schedule ? "routines" : "task"),
        );
        if (schedule) {
          const created = (await rpc.request("routines.list", {})).find(
            (routine) => routine.templateId === template.id,
          );
          expect(created).toMatchObject({
            schedule,
            templateId: template.id,
            prompt: template.prompt,
            toolMode: "browser",
            requireApproval: false,
          });
          expect(await page.locator("#main").getAttribute("data-route-id")).toBe(created?.id ?? "");
        } else {
          const task = await taskByPrompt(template.prompt);
          expect(task).toMatchObject({
            templateId: template.id,
            toolMode: "browser",
            requireApproval: false,
          });
          expect(await page.locator("#main").getAttribute("data-route-id")).toBe(task.id);
        }
      } finally {
        await page.close();
      }
    }
  },
  T,
);

test(
  "keyboard menus restore focus and attachments cannot be silently discarded by scheduling",
  async () => {
    const page = await app();
    try {
      await page.locator("#when-trigger").focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      expect(await page.locator("#when-label").innerText()).toBe("Toda segunda às 9h");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("when-trigger");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      expect(await page.getByRole("menu").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("when-trigger");
      await page.locator("#composer-input").fill("Uma tarefa com anexo");
      const privateSwitch = page.locator("#private-switch");
      if ((await privateSwitch.getAttribute("aria-checked")) === "true")
        await privateSwitch.click();
      await page.locator("#file-input").setInputFiles({
        name: "arquivo.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("arquivo"),
      });
      expect(await page.locator("#send").isEnabled()).toBe(true);
      await page.locator("#send").click();
      await page.waitForFunction(
        () => document.querySelector("#main")?.getAttribute("data-view") === "routines",
      );
      const routine = (await rpc.request("routines.list", {})).find(
        (r) => r.prompt === "Uma tarefa com anexo",
      );
      expect(routine?.schedule).toBe("weekly mon 09:00");
      const run = await rpc.request("routines.run", { id: routine!.id });
      await until(
        async () => (await rpc.request("tasks.get", { id: run.taskId! })).situation === "done",
      );
      const history = await rpc.request("tasks.history", { id: run.taskId! });
      expect(
        history.items.some(
          (item) => item.kind === "user_message" && item.attachments?.[0]?.name === "arquivo.txt",
        ),
      ).toBe(true);
      await page.reload();
      await page.locator("#home-title").waitFor();
      await page.keyboard.press("Control+Shift+O");
      await page.locator("#composer-input").fill("Outra tarefa");
      await page.locator("#file-input").setInputFiles({
        name: "arquivo.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("arquivo"),
      });
      await page.getByRole("button", { name: "Remover arquivo.txt" }).click();
      expect(await page.locator("#send").isEnabled()).toBe(true);
    } finally {
      await page.close();
    }
  },
  T,
);
