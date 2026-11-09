import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Profile } from "@boto/protocol";
import { type Browser, chromium, type Page } from "playwright-core";

const root = join(import.meta.dir, "../../..");
let browser: Browser;
let vite: ReturnType<typeof Bun.spawn>;
const base = "http://localhost:1421";

beforeAll(async () => {
  vite = Bun.spawn([process.execPath, "run", "--cwd", "apps/desktop", "dev", "--port", "1421"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (
      await fetch(base)
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
  vite?.kill();
  await vite?.exited;
}, 30000);

async function page(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(base);
  await page.locator("#home-title").waitFor();
  return page;
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBe(true);
}
async function current(page: Page, view: string) {
  await until(async () => (await page.locator("#main").getAttribute("data-view")) === view);
  expect(await page.locator(`[data-nav="${view}"][aria-current="page"]`).count()).toBe(1);
}

test("shell works without daemon: navigation, focus, theme, private mode and palette", async () => {
  const p = await page();
  try {
    expect(await p.locator("[data-agent-count]").innerText()).toBe("");
    expect(await p.locator("[data-routine-count]").innerText()).toBe("");
    expect(await p.locator(".sb-history").innerText()).toBe("");
    await p.getByRole("button", { name: "Tema escuro" }).click();
    expect(await p.locator("html").getAttribute("data-theme")).toBe("light");
    expect(await p.locator(".sb-logo").getAttribute("src")).toBe("/assets/boto-logo-claro.svg");
    await until(
      async () =>
        (await p
          .locator("body")
          .evaluate((element) => getComputedStyle(element).backgroundColor)) ===
        "rgb(246, 248, 247)",
    );
    await p.getByRole("button", { name: "Tema escuro" }).click();
    expect(await p.locator("html").getAttribute("data-theme")).toBe("dark");
    expect(await p.locator(".sb-logo").getAttribute("src")).toBe("/assets/boto-logo.svg");
    await until(
      async () =>
        (await p
          .locator("body")
          .evaluate((element) => getComputedStyle(element).backgroundColor)) === "rgb(12, 20, 22)",
    );
    await p.getByRole("button", { name: "Tema escuro" }).click();
    await p.getByRole("switch", { name: "Privada" }).click();
    await p.getByText("Não foi possível atualizar o modo privado.").waitFor();
    expect(await p.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(await p.evaluate(() => localStorage.getItem("boto.private-task"))).toBeNull();
    await p.locator('[data-nav="agents"]').click();
    await current(p, "agents");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("agents-title");
    await p.keyboard.press("Control+k");
    await p.getByRole("combobox").fill("inexistente");
    await until(
      async () => (await p.locator("#command-empty").innerText()) === "Não foi possível buscar.",
    );
    expect(await p.getByRole("option").count()).toBe(0);
    await p.getByRole("combobox").fill("rotinas");
    await p.keyboard.press("Enter");
    await current(p, "routines");
    await p.keyboard.press("Control+Shift+O");
    await current(p, "new");
    await p.reload();
    expect(await p.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(await p.locator("html").getAttribute("data-theme")).toBe("light");
  } finally {
    await p.close();
  }
}, 30000);

test("sidebar resize clamps, persists, resets and supports keyboard; collapse persists", async () => {
  const p = await page();
  try {
    const handle = p.getByRole("separator", { name: "Largura da barra lateral" });
    await handle.focus();
    await p.keyboard.press("Home");
    expect(await handle.getAttribute("aria-valuenow")).toBe("220");
    await p.keyboard.press("ArrowRight");
    expect(await handle.getAttribute("aria-valuenow")).toBe("228");
    await p.keyboard.press("ArrowLeft");
    expect(await handle.getAttribute("aria-valuenow")).toBe("220");
    await p.keyboard.press("End");
    expect(await handle.getAttribute("aria-valuenow")).toBe("400");
    const rect = await handle.boundingBox();
    if (!rect) throw new Error("Missing resizer");
    await p.mouse.move(rect.x + 3, 300);
    await p.mouse.down();
    await p.mouse.move(700, 300);
    await p.mouse.up();
    expect(await handle.getAttribute("aria-valuenow")).toBe("400");
    await p.mouse.move(397, 300);
    await p.mouse.down();
    await p.mouse.move(100, 300);
    await p.mouse.up();
    expect(await handle.getAttribute("aria-valuenow")).toBe("220");
    await p.reload();
    expect(await handle.getAttribute("aria-valuenow")).toBe("220");
    await handle.dblclick();
    expect(await handle.getAttribute("aria-valuenow")).toBe("272");
    await p.getByRole("button", { name: "Recolher barra lateral" }).click();
    await p.reload();
    expect(await p.locator("#sidebar").isVisible()).toBe(false);
    expect(await p.getByRole("button", { name: "Mostrar barra lateral" }).isVisible()).toBe(true);
    await p.getByRole("button", { name: "Mostrar barra lateral" }).click();
    expect(await p.locator("#sidebar").isVisible()).toBe(true);
    expect(await p.getByRole("button", { name: "Mostrar barra lateral" }).isVisible()).toBe(false);
  } finally {
    await p.close();
  }
}, 30000);

test("mobile Sheet closes on navigation, Escape, backdrop and desktop breakpoint", async () => {
  const p = await page(390);
  try {
    expect(await p.locator("#sidebar").isVisible()).toBe(false);
    await p.getByRole("button", { name: "Abrir menu" }).click();
    expect(await p.locator("#sheet").evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);
    expect(await p.locator("dialog.sheet").isVisible()).toBe(true);
    expect(await p.getByRole("tooltip").count()).toBe(0);
    for (const width of [390, 768]) {
      await p.setViewportSize({ width, height: 844 });
      expect(
        await p.locator("#sheet").evaluate((element) => element.getBoundingClientRect().width),
      ).toBe(240);
      expect(
        await p.locator('#sheet [data-action="open-command"] .od-fill').evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return (
            range.getClientRects().length === 1 &&
            element.scrollWidth <= element.clientWidth &&
            getComputedStyle(element).whiteSpace === "nowrap"
          );
        }),
      ).toBe(true);
      const compactShortcut =
        (await p.locator("#sidebar [data-shortcut-label]").innerText()) === "⌘K";
      expect(await p.locator("#sheet .kbd").count()).toBe(compactShortcut ? 1 : 0);
    }
    await p.locator('#sheet [data-nav="templates"]').click();
    await until(async () => !(await p.locator("#sheet").isVisible()));
    await current(p, "templates");
    expect(await p.locator("#main h1").innerText()).toBe("Modelos");
    await p.getByRole("button", { name: "Abrir menu" }).click();
    await p.keyboard.press("Escape");
    await until(async () => !(await p.locator("#sheet").isVisible()));
    await p.getByRole("button", { name: "Abrir menu" }).click();
    await p.mouse.click(380, 500);
    await until(async () => !(await p.locator("#sheet").isVisible()));
    await p.getByRole("button", { name: "Abrir menu" }).click();
    await p.setViewportSize({ width: 1440, height: 900 });
    await until(async () => !(await p.locator("#sheet").isVisible()));
  } finally {
    await p.close();
  }
}, 30000);

test("user menu supports keyboard, dialogs restore focus, tooltip is labelled, tray stays empty", async () => {
  const p = await page();
  try {
    await p.getByRole("button", { name: "Menu da conta" }).click();
    expect(await p.getByRole("menuitem").allTextContents()).toEqual([
      "Configurações",
      "Você e a memória",
      "Alternar tema",
      "Atalhos de teclado",
      "Conhecer o Boto",
      "Guia da marca",
    ]);
    await p.keyboard.press("End");
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("Enter");
    await p.getByRole("dialog", { name: "Apresentação do Boto" }).waitFor();
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Menu da conta" }).click();
    await p.getByRole("menuitem", { name: "Atalhos de teclado" }).click();
    await p.getByRole("dialog", { name: "Atalhos de teclado" }).waitFor();
    await p.getByRole("button", { name: "Entendi" }).click();
    expect(
      await p
        .getByRole("button", { name: "Menu da conta" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await p.getByRole("button", { name: "Tema escuro" }).hover();
    await p.getByRole("tooltip").waitFor();
    await p.mouse.move(700, 500);
    await p.getByRole("switch", { name: "Privada" }).click();
    await p.keyboard.press("Tab");
    await p.getByRole("tooltip").waitFor();
    expect(await p.getByRole("tooltip").innerText()).toBe("Alternar tema");
    await p.goto(`${base}/#/menubar`);
    await until(async () => (await p.locator("#root").innerHTML()) === "");
  } finally {
    await p.close();
  }
}, 30000);

test("failed initial refresh recovers on reconnect and reloads real counts", async () => {
  let fail = true;
  let profile: Profile = {
    name: "",
    about: "",
    onboardingCompletedAt: null,
    defaults: { private: false, requireApproval: false, delegationMode: "now", toolMode: "both" },
    theme: null,
    sidebarWidth: null,
  };
  let socket: { terminate: () => void } | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, message) {
        const request = JSON.parse(String(message));
        if (request.method === "profile.update") {
          profile = {
            ...profile,
            ...request.params,
            defaults: { ...profile.defaults, ...request.params.defaults },
          };
          ws.send(JSON.stringify({ event: "profile.changed", data: profile }));
        }
        if (request.method === "agents.list" && fail)
          ws.send(
            JSON.stringify({
              id: request.id,
              error: { code: "internal", message: "falha simulada" },
            }),
          );
        else
          ws.send(
            JSON.stringify({
              id: request.id,
              result:
                request.method === "agents.list"
                  ? [{ id: "real-agent", name: "Real" }]
                  : request.method === "agents.statuses"
                    ? {}
                    : request.method === "profile.get" || request.method === "profile.update"
                      ? profile
                      : request.method === "tasks.list"
                        ? { items: [], nextCursor: null }
                        : request.method === "tasks.search"
                          ? { tasks: [], routines: [] }
                          : [],
            }),
          );
      },
    },
  });
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on("pageerror", (error) => errors.push(error.message));
  try {
    await p.goto(`${base}/#port=${server.port}&token=test`);
    await p.locator("#home-title").waitFor();
    expect(await p.locator("[data-agent-count]").innerText()).toBe("");
    fail = false;
    socket?.terminate();
    await until(async () => (await p.locator("[data-agent-count]").innerText()) === "1");
    await until(
      async () => (await p.locator(".sb-history").innerText()) === "Nenhuma tarefa ainda.",
    );
    await p.getByRole("switch", { name: "Privada" }).click();
    await until(async () => profile.defaults.private);
    expect(await p.evaluate(() => localStorage.getItem("boto.private-task"))).toBeNull();
    await p.reload();
    await until(async () => (await p.getByRole("switch").getAttribute("aria-checked")) === "true");
    await p.keyboard.press("Control+k");
    await p.getByRole("combobox").fill("inexistente");
    await until(
      async () =>
        (await p.locator("#command-empty").innerText()) === "Nenhum resultado para “inexistente”.",
    );
    expect(errors).toEqual([]);
    await p.getByText("Nada em andamento agora.", { exact: true }).waitFor();
  } finally {
    await p.close();
    server.stop(true);
  }
}, 30000);
