import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  removeDir,
  startDaemon,
  stopDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
import { startVite } from "./vite";

test("private task view keeps live replies and mandatory approvals without sharing them", async () => {
  const dirs = [tmp("private-view-data-"), tmp("private-view-agents-"), tmp("private-view-acp-")];
  const token = crypto.randomUUID();
  const daemon = await startDaemon(dirs[0]!, dirs[1]!, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: dirs[2]!,
  });
  const client = await DaemonClient.connect(daemon.port, token);
  const vite = await startVite();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await client.request("onboarding.complete", {});
    const agent = await client.request("agents.create", { name: "Private bot", provider: "devin" });
    const recipient = await client.request("agents.create", {
      name: "Recipient",
      provider: "devin",
    });
    await client.request("queue.pause", { agentId: agent.id });
    const task = await client.request("tasks.create", {
      agentId: agent.id,
      text: "tool",
      private: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}&task=${task.id}`);
    await page.locator("#task-title").getByText(task.title, { exact: true }).waitFor();
    await client.request("queue.resume", { agentId: agent.id });
    const allow = page.getByRole("button", { name: "Permitir nesta sessão", exact: true });
    await allow.waitFor();
    expect(await client.request("permissions.list", {})).toEqual([]);
    await page.reload();
    await allow.click();
    await page.getByText("permission:allow_once", { exact: true }).waitFor();
    expect(
      (await client.request("tasks.list", { includePrivate: true })).items.some(
        (item) => item.id === task.id,
      ),
    ).toBe(false);
    const text = "private-approval-canary";
    await page
      .locator("#instruct-input")
      .fill(`mcp:send_message ${JSON.stringify({ to: recipient.id, text })}`);
    await page.locator("#instruct-input").press("Enter");
    const deny = page.getByRole("button", { name: "Recusar", exact: true });
    await deny.waitFor();
    expect(await client.request("approvals.list", {})).toEqual([]);
    expect(
      (await client.request("approvals.list", { taskId: task.id })).some(
        (approval) => approval.status === "pending",
      ),
    ).toBe(true);
    await page.reload();
    await deny.click();
    await page.getByText(/^Recusada ·/).waitFor();
    expect(JSON.stringify(client.events)).not.toContain(task.id);
    expect(JSON.stringify(client.events)).not.toContain(text);
    expect((await client.request("queue.get", { agentId: recipient.id })).items).toEqual([]);
    expect((await client.request("chat.history", { agentId: agent.id })).items).toEqual([]);
  } finally {
    await browser.close();
    await vite.stop();
    await stopDaemon(daemon, client, dirs[2]!);
    for (const dir of dirs) removeDir(dir);
  }
}, 60_000);
