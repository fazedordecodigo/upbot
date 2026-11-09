import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Agent, Task, whenToRoutine } from "@boto/protocol";
import { type Browser, chromium, type Page } from "playwright-core";
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
    BOTO_DEFAULT_BOT: "on",
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: state,
  });
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  const seeded = (await rpc.request("agents.list", {})).find((agent) => agent.isDefault)!;
  alpha = await rpc.request("agents.update", { id: seeded.id, name: "Alpha", provider: "devin" });
  beta = await rpc.request("agents.create", { name: "Beta", provider: "devin" });
  base = "http://localhost:1420";
  vite = await startVite();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, T);

afterAll(async () => {
  await browser?.close();
  await vite?.stop();
  if (daemon) await stopDaemon(daemon, rpc, dirs[2]);
  for (const dir of dirs) await removeDir(dir);
}, T);

async function app(
  templateId?: string,
  agentId?: string,
  onTask?: (task: Task) => void,
  onAgentDeleted?: () => void,
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (onTask || onAgentDeleted)
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.event === "agent.deleted") onAgentDeleted?.();
        const result = Task.safeParse(message.result);
        if (result.success) onTask?.(result.data);
      }),
    );
  page.setDefaultTimeout(10_000);
  const route =
    templateId || agentId
      ? `/test/fixtures/new-task.html?${new URLSearchParams({ ...(templateId ? { templateId } : {}), ...(agentId ? { agentId, nextAgentId: beta.id } : {}) })}`
      : "/";
  await page.goto(`${base}${route}#port=${daemon.port}&token=${token}`);
  if (!templateId && !agentId) {
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
    const page = await app(undefined, beta.id);
    try {
      expect(await page.locator("#send").isDisabled()).toBe(true);
      await page.locator("#composer-input").fill("echo:delegada pelo composer");
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
          agentId: alpha.id,
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
  "private toggle is sent per task and deleted route recipients fall back to the default bot",
  async () => {
    await rpc.request("queue.pause", { agentId: alpha.id });
    let resolveTask!: (task: Task) => void;
    const created = new Promise<Task>((resolve) => {
      resolveTask = resolve;
    });
    const page = await app(undefined, undefined, resolveTask);
    try {
      await page.locator("#composer-input").fill("echo:tarefa privada");
      await page.locator("#private-switch").click();
      expect(await page.locator("#hero-private").isVisible()).toBe(true);
      await page.locator("#send").click();
      const task = await created;
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
      await page.close();
      let deletedSeen = false;
      const fallback = new Promise<Task>((resolve) => {
        resolveTask = resolve;
      });
      const unavailable = await app(
        undefined,
        disposable.id,
        (task) => resolveTask(task),
        () => {
          deletedSeen = true;
        },
      );
      try {
        await unavailable.locator("#composer-input").fill("echo:usar o Boto padrão");
        await rpc.request("agents.delete", { id: disposable.id });
        await until(async () => deletedSeen);
        expect(await unavailable.locator("#send").isEnabled()).toBe(true);
        expect(await unavailable.locator("#composer-input").inputValue()).toBe(
          "echo:usar o Boto padrão",
        );
        await unavailable.locator("#send").click();
        const fallbackTask = await fallback;
        expect(fallbackTask.agentId).toBe(alpha.id);
        await rpc.request("tasks.stop", { id: fallbackTask.id });
      } finally {
        await unavailable.close();
      }
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
    await rpc.request("profile.update", { defaults: { private: false } });
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
          schedule === "daily 08:00"
            ? "Todo dia às 8h"
            : schedule === "every 2h"
              ? "A cada 2 horas"
              : "Agora",
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
  "keyboard menus restore focus and scheduled attachments persist",
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
      await choose(page, "#when-trigger", "Toda segunda às 9h");
      await page.locator("#file-input").setInputFiles({
        name: "arquivo.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("arquivo"),
      });
      expect(await page.locator("#send").isEnabled()).toBe(true);
      await page.locator("#send").click();
      await until(
        async () => (await page.locator("#main").getAttribute("data-view")) === "routines",
      );
      expect(routine?.attachments?.[0]?.name).toBe("arquivo.txt");
    } finally {
      await page.close();
    }
  },
  T,
);

test(
  "Enter delegates, Shift+Enter adds a newline, and composition does not submit",
  async () => {
    const page = await app();
    try {
      const input = page.locator("#composer-input");
      await input.fill("echo:keyboard");
      await input.press("Shift+Enter");
      await input.press("x");
      expect(await input.inputValue()).toBe("echo:keyboard\nx");
      expect(
        (await rpc.request("tasks.list", {})).items.some(
          (task) => task.prompt === "echo:keyboard\nx",
        ),
      ).toBe(false);
      await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      expect(await page.locator("#main").getAttribute("data-view")).toBe("new");
      await input.press("Enter");
      await until(async () => (await page.locator("#main").getAttribute("data-view")) === "task");
      expect((await taskByPrompt("echo:keyboard\nx")).agentId).toBe(alpha.id);
    } finally {
      await page.close();
    }
  },
  T,
);

test(
  "composer bar matches prototype and route recipients get fresh drafts",
  async () => {
    const page = await app(undefined, alpha.id);
    try {
      expect(
        await page.locator(".composer-bar").evaluate((bar) =>
          Array.from(bar.children)
            .filter((el) => el.tagName !== "INPUT" && !el.classList.contains("composer-spacer"))
            .map(
              (el) =>
                el.id ||
                el.getAttribute("data-action") ||
                (el.classList.contains("opt-approval")
                  ? "approval"
                  : el.querySelector("button")?.id),
            ),
        ),
      ).toEqual(["attach", "when-trigger", "where-trigger", "approval", "send"]);
      expect(await page.locator("#agent-trigger").count()).toBe(0);
      await page.locator("#composer-input").fill("Alpha only");
      await choose(page, "#where-trigger", "Só terminal Código, scripts e arquivos");
      await page.locator("#approval-switch").click();
      await page
        .locator("#file-input")
        .setInputFiles({ name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("alpha") });
      await page.getByRole("button", { name: "Switch route agent" }).click();
      await until(() => page.locator("#composer-input").isEnabled());
      expect(await page.locator("#composer-input").inputValue()).toBe("");
      expect(await page.locator("#where-label").innerText()).toBe("Navegador e terminal");
      expect(await page.locator("#approval-switch").getAttribute("aria-checked")).toBe("true");
      expect(await page.locator("#composer-files").isVisible()).toBe(false);
      await page.locator("#composer-input").fill("echo:route Beta");
      await page.locator("#composer-input").press("Enter");
      expect((await taskByPrompt("echo:route Beta")).agentId).toBe(beta.id);
    } finally {
      await page.close();
    }
  },
  T,
);

test(
  "saved delegation timing and Nova rotina initialize a scheduled composer, while templates override defaults",
  async () => {
    await rpc.request("profile.update", { defaults: { delegationMode: "scheduled" } });
    const page = await app();
    try {
      expect(await page.locator("#when-label").innerText()).toBe("Daqui a 1 hora");
      await page.locator('#sidebar [data-nav="routines"]').click();
      await page.getByRole("button", { name: "Nova rotina", exact: true }).click();
      await until(() => page.locator("#composer-input").isEnabled());
      expect(await page.locator("#when-label").innerText()).toBe("Todo dia às 8h");
      await page.locator('#sidebar [data-nav="templates"]').click();
      await page.locator('[data-template="ci"]').click();
      await until(() => page.locator("#composer-input").isEnabled());
      expect(await page.locator("#when-label").innerText()).toBe("Agora");
      expect(await page.locator("#approval-switch").getAttribute("aria-checked")).toBe("true");
    } finally {
      await rpc.request("profile.update", { defaults: { delegationMode: "approval" } });
      await page.close();
    }
  },
  T,
);
