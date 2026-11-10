import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
import { base, startVite } from "./vite";

test("composer uses the default marker, preserves valid routes and falls back after route deletion without a picker", async () => {
  const root = tmp("default-delegation-");
  const token = crypto.randomUUID();
  const command = JSON.stringify([process.execPath, FAKE_AGENT]);
  const daemon = await startDaemon(join(root, "data"), join(root, "agents"), token, {
    BOTO_PROVIDER_COMMAND_CLAUDE: command,
    BOTO_ACP_COMMAND_GROK: command,
  });
  const rpc = await DaemonClient.connect(daemon.port, token);
  const vite = await startVite();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const original = await rpc.request("agents.create", {
      name: "Renamed default",
      provider: "grok",
    });
    expect(original.isDefault).toBe(true);
    const older = await rpc.request("agents.create", { name: "Boto", provider: "grok" });
    const deleted = await rpc.request("agents.create", { name: "Deleted", provider: "grok" });
    await rpc.request("agents.delete", { id: deleted.id });
    const db = new Database(join(root, "data", "boto.db"));
    db.query("UPDATE agents SET created_at = 0 WHERE id = ?").run(older.id);
    db.close();
    await rpc.request("queue.pause", { agentId: original.id });
    await rpc.request("queue.pause", { agentId: older.id });
    for (const [route, expected] of [
      ["", original.id],
      [deleted.id, original.id],
      [older.id, older.id],
    ]) {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      try {
        await page.goto(
          `${base}/test/fixtures/new-task.html?agentId=${route}#port=${daemon.port}&token=${token}`,
        );
        await page.locator("#composer-input:not(:disabled)").waitFor();
        const text = crypto.randomUUID();
        await page.locator("#composer-input").fill(text);
        await page.locator("#send:not(:disabled)").waitFor();
        await page.locator("#send").click();
        await page.locator('main[data-view="task"]').waitFor();
        const created = (await rpc.request("tasks.list", {})).items.find(
          (task) => task.prompt === text,
        );
        expect(created?.agentId).toBe(expected);
        expect(await page.locator("select").count()).toBe(0);
      } finally {
        await page.close();
      }
    }
    await rpc.request("agents.delete", { id: original.id });
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/test/fixtures/new-task.html#port=${daemon.port}&token=${token}`);
      await page.locator("#composer-input:not(:disabled)").waitFor();
      await page.locator("#composer-input").fill("No default available");
      expect(await page.locator("#send").isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await vite.stop();
    await stopDaemon(daemon, rpc);
    removeDir(root);
  }
}, 60_000);
