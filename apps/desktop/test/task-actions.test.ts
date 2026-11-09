import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright-core";
import { base, startVite } from "./vite";

let vite: Awaited<ReturnType<typeof startVite>>;
let browser: Browser;
beforeAll(async () => {
  vite = await startVite();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await vite?.stop();
});

async function surface(secret = false) {
  const task = {
    id: "task",
    agentId: "bot",
    title: "Test task",
    prompt: "Wait",
    situation: "run",
    outcome: null,
    private: false,
    toolMode: "both",
    requireApproval: true,
    sessionId: null,
    routineId: null,
    templateId: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
  };
  let approval = {
    id: "approval",
    agentId: "bot",
    taskId: "task",
    turnId: "turn",
    kind: "secret",
    title: "Store API key",
    detail: "API access",
    status: "pending",
    createdAt: 1,
    resolvedAt: null,
    interruptedAt: null,
  };
  const state = {
    stopFailure: true,
    secretFailure: false,
    responses: [] as { decision: string; value?: string }[],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, data) {
        const { id, method, params } = JSON.parse(String(data));
        let result: unknown = { ok: true };
        switch (method) {
          case "agents.list":
            result = [
              { id: "bot", name: "Bot", provider: "grok", config: {}, createdAt: 1, updatedAt: 1 },
            ];
            break;
          case "agents.statuses":
            result = {};
            break;
          case "tasks.get":
            result = task;
            break;
          case "tasks.history":
            result = {
              items: [],
              turns: [{ id: "turn", agentId: "bot", taskId: "task" }],
              hasMore: false,
            };
            break;
          case "approvals.list":
            result = secret ? [approval] : [];
            break;
          case "channels.list":
          case "permissions.list":
          case "desktop.machines":
          case "tasks.deliveries":
            result = [];
            break;
          case "tasks.stop":
            if (state.stopFailure) {
              socket.send(
                JSON.stringify({ id, error: { code: "internal", message: "stop failed" } }),
              );
              return;
            }
            Object.assign(task, { situation: "done", outcome: "stopped", endedAt: Date.now() });
            socket.send(JSON.stringify({ event: "task.updated", data: task }));
            result = task;
            break;
          case "approvals.respond":
            state.responses.push(params);
            if (state.secretFailure) {
              socket.send(
                JSON.stringify({ id, error: { code: "internal", message: params.value } }),
              );
              return;
            }
            approval = { ...approval, status: params.decision === "deny" ? "denied" : "approved" };
            socket.send(JSON.stringify({ event: "approval.updated", data: approval }));
            result = approval;
            break;
        }
        socket.send(JSON.stringify({ id, result }));
      },
    },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(
    `${base}/test/fixtures/task-actions.html#port=${server.port}&token=test&task=task`,
  );
  await page.locator("#task-title").filter({ hasText: "Test task" }).waitFor();
  return {
    page,
    state,
    close: async () => {
      await page.close();
      server.stop(true);
    },
  };
}

test("secret approvals use a masked required input, submit value, retain deny, and never echo secrets or errors", async () => {
  const fixture = await surface(true);
  const { page, state } = fixture;
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  const value = crypto.randomUUID();
  try {
    const input = page.getByLabel("Valor secreto", { exact: true });
    await input.waitFor();
    expect(await input.getAttribute("type")).toBe("password");
    await page.getByRole("button", { name: "Aprovar", exact: true }).click();
    expect(state.responses).toHaveLength(0);
    state.secretFailure = true;
    await input.fill(value);
    await page.getByRole("button", { name: "Aprovar", exact: true }).click();
    await page
      .getByText("Não foi possível salvar o segredo. Tente de novo.", { exact: true })
      .waitFor();
    expect(await input.inputValue()).toBe("");
    expect((await page.locator("body").innerText()).includes(value)).toBe(false);
    expect(messages.join("\n").includes(value)).toBe(false);
    state.secretFailure = false;
    await input.fill(value);
    await page.getByRole("button", { name: "Aprovar", exact: true }).click();
    await page.locator(".task-card").getByText("Aprovada", { exact: false }).waitFor();
    expect(state.responses.at(-1)?.value === value).toBe(true);
    expect((await page.locator("body").innerText()).includes(value)).toBe(false);
  } finally {
    await fixture.close();
  }
  const denial = await surface(true);
  try {
    await denial.page.getByRole("button", { name: "Recusar", exact: true }).click();
    await denial.page.locator(".task-card").getByText("Recusada", { exact: false }).waitFor();
    expect(denial.state.responses.at(-1)).toEqual({ id: "approval", decision: "deny" });
  } finally {
    await denial.close();
  }
}, 25_000);

test("failed stop keeps confirmation open with a toast and allows retry or cancel", async () => {
  const fixture = await surface();
  const { page, state } = fixture;
  try {
    await page.locator("#ctl-stop").click();
    await page.locator("#confirm-ok").click();
    await page
      .getByText("Não foi possível concluir a ação. Tente de novo.", { exact: true })
      .waitFor();
    expect(await page.locator("#confirm").isVisible()).toBe(true);
    expect(await page.locator("#confirm-ok").isEnabled()).toBe(true);
    await page.locator("#confirm-cancel").click();
    expect(await page.locator("#confirm").count()).toBe(0);
    await page.locator("#ctl-stop").click();
    state.stopFailure = false;
    await page.locator("#confirm-ok").click();
    await page.locator("#confirm").waitFor({ state: "detached" });
    await page.locator("#task-meta").getByText("Encerrada", { exact: true }).waitFor();
  } finally {
    await fixture.close();
  }
}, 20_000);
