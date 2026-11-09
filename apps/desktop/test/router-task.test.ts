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

test("a task opened in-app remains addressable on reload without global private listings", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/test/fixtures/router.html#port=1234&token=test-only`);
    await page.getByRole("button", { name: "Open task" }).click();
    expect(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("task"))).toBe(
      "private-task",
    );
    expect(
      await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("token")),
    ).toBe("test-only");
    await page.reload();
    await page.getByRole("heading", { name: "task:private-task" }).waitFor();
    await page.getByRole("button", { name: "Leave task" }).click();
    expect(
      await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get("task")),
    ).toBeNull();
    await page.reload();
    await page.getByRole("heading", { name: "home:none" }).waitFor();
  } finally {
    await page.close();
  }
}, 20_000);
