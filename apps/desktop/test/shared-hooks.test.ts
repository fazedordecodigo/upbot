import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright-core";
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
async function open(query = "") {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${base}/test/fixtures/hooks.html${query}`);
  await page.locator('body[data-history="requested"]').waitFor();
  return page;
}
const count = (page: Page, method: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { hookFixture: { calls: string[] } }).hookFixture.calls.filter(
        (call) => call === name,
      ).length,
    method,
  );

test("task permissions are scoped to known turns and reconciled when events precede history or turns", async () => {
  const page = await open();
  try {
    await page.getByText("Early permission", { exact: true }).click();
    expect(await page.locator("#permissions").textContent()).toBe("");
    await page.getByText("Load history", { exact: true }).click();
    await page.locator("#permissions").filter({ hasText: "early,own" }).waitFor();
    await page.getByText("Foreign permission", { exact: true }).click();
    expect(await page.locator("#permissions").textContent()).toBe("early,own");
    await page.getByText("Future permission", { exact: true }).click();
    expect(await page.locator("#permissions").textContent()).toBe("early,own");
    await page.getByText("Future turn", { exact: true }).click();
    await page.locator("#permissions").filter({ hasText: "early,future,own" }).waitFor();
    await page.getByText("Resolve early", { exact: true }).click();
    expect(await page.locator("#permissions").textContent()).toBe("future,own");
    await page.getByText("Clear task", { exact: true }).click();
    expect(await page.locator("#permissions").textContent()).toBe("");
  } finally {
    await page.close();
  }
}, 20_000);

test("permission resolution before history is not resurrected, and history errors expose no unknown-turn permissions", async () => {
  const page = await open();
  try {
    await page.getByText("Early permission", { exact: true }).click();
    await page.getByText("Resolve early", { exact: true }).click();
    await page.getByText("Load history", { exact: true }).click();
    await page.locator("#loading").filter({ hasText: "false" }).waitFor();
    expect(await page.locator("#permissions").textContent()).toBe("own");
    await page.reload();
    await page.locator('body[data-history="requested"]').waitFor();
    await page.getByText("Early permission", { exact: true }).click();
    await page.getByText("Fail history", { exact: true }).click();
    await page.locator("#error").filter({ hasText: "true" }).waitFor();
    expect(await page.locator("#permissions").textContent()).toBe("");
  } finally {
    await page.close();
  }
}, 20_000);

test("a shared machine is released and unsubscribed only when its last listener unmounts", async () => {
  const page = await open();
  try {
    await page.getByText("Take over first", { exact: true }).click();
    await page.locator("#first output").filter({ hasText: "true" }).waitFor();
    await page.getByText("Add second", { exact: true }).click();
    await page.locator("#second output").filter({ hasText: "true" }).waitFor();
    await page.getByText("Hide first", { exact: true }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await count(page, "desktop.release")).toBe(0);
    expect(await count(page, "desktop.unsubscribe")).toBe(0);
    expect(await page.locator("#second output").textContent()).toBe("true");
    await page.getByText("Hide second", { exact: true }).click();
    await page.waitForFunction(() =>
      (window as unknown as { hookFixture: { calls: string[] } }).hookFixture.calls.includes(
        "desktop.unsubscribe",
      ),
    );
    expect(await count(page, "desktop.release")).toBe(1);
    expect(await count(page, "desktop.unsubscribe")).toBe(1);
  } finally {
    await page.close();
  }
}, 20_000);

test("the last machine listener still unsubscribes if releasing control fails", async () => {
  const page = await open("?failRelease=1");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.getByText("Take over first", { exact: true }).click();
    await page.locator("#first output").filter({ hasText: "true" }).waitFor();
    await page.getByText("Hide first", { exact: true }).click();
    await page.waitForFunction(() =>
      (window as unknown as { hookFixture: { calls: string[] } }).hookFixture.calls.includes(
        "desktop.unsubscribe",
      ),
    );
    expect(await count(page, "desktop.release")).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);
