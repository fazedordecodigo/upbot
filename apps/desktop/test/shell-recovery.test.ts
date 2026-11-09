import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
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

test("main shell boots, navigates and refreshes history after daemon restart without page reload", async () => {
  const root = tmp("shell-recovery-");
  const token = crypto.randomUUID();
  const env = { BOTO_ACP_COMMAND_GROK: JSON.stringify([process.execPath, FAKE_AGENT]) };
  let daemon = await startDaemon(join(root, "data"), join(root, "agents"), token, env);
  let rpc = await DaemonClient.connect(daemon.port, token);
  const proxy = Bun.serve<{ upstream: WebSocket | null; queue: string[] }>({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: { upstream: null, queue: [] } })
        ? undefined
        : new Response(null, { status: 503 });
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?token=${token}`);
        socket.data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of socket.data.queue.splice(0)) upstream.send(message);
        };
        upstream.onmessage = (event) => socket.send(String(event.data));
        upstream.onclose = () => socket.close();
        upstream.onerror = () => socket.close();
      },
      message(socket, message) {
        const text = String(message);
        if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(text);
        else socket.data.queue.push(text);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await rpc.request("onboarding.complete", {});
    const bot = await rpc.request("agents.create", { name: "Recovery bot", provider: "grok" });
    await rpc.request("queue.pause", { agentId: bot.id });
    await rpc.request("tasks.create", {
      agentId: bot.id,
      text: "Before restart",
      private: false,
    });
    await page.goto(`${base}/#port=${proxy.port}&token=${token}`);
    await page
      .locator("#sidebar [data-history]")
      .getByText("Before restart", { exact: true })
      .waitFor();
    const started = await page.evaluate(() => performance.timeOrigin);
    await stopDaemon(daemon, rpc);
    daemon = await startDaemon(join(root, "data"), join(root, "agents"), token, env);
    rpc = await DaemonClient.connect(daemon.port, token);
    await rpc.request("tasks.create", {
      agentId: bot.id,
      text: "After restart",
      private: false,
    });
    await page
      .locator("#sidebar [data-history]")
      .getByText("After restart", { exact: true })
      .waitFor();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(started);
    expect(await page.locator("#app").count()).toBe(1);
    await page.locator('#sidebar [data-action="new-task"]').click();
    await page.locator("#main h1").filter({ hasText: "Nova tarefa" }).waitFor();
    expect(await page.locator("#main").innerText()).toContain("Nova tarefa");
  } finally {
    await page.close();
    proxy.stop(true);
    await stopDaemon(daemon, rpc);
    removeDir(root);
  }
}, 60_000);
