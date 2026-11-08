import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { expectSwitchGeometry } from "./switch-geometry";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--port", "1421"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      if ((await fetch("http://localhost:1421")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://localhost:1421/#/kit");
  await page.getByRole("heading", { name: "Controles", exact: true }).waitFor({ timeout: 90000 });
}, 180000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  if (server) await server.exited;
});

test("fields expose labels, empty, invalid, multiline and disabled states", async () => {
  expect(await page.getByLabel("Enviar relatório para").inputValue()).toBe(
    "marina.costa@empresa.com.br",
  );
  const empty = page.getByLabel("Buscar tarefa");
  expect(await empty.inputValue()).toBe("");
  await empty.fill("Relatório");
  expect(await empty.inputValue()).toBe("Relatório");
  const invalid = page.getByLabel("Limite por despesa");
  expect(await invalid.getAttribute("aria-invalid")).toBe("true");
  const hint = await invalid.getAttribute("aria-describedby");
  expect(await page.locator(`[id="${hint}"]`).textContent()).toBe(
    "Informe um valor acima de zero.",
  );
  expect(await page.getByLabel("Conta conectada").isDisabled()).toBe(true);
  await page.getByLabel("Instruções").fill("Uma tarefa\nDuas etapas");
  expect(await page.getByLabel("Instruções").inputValue()).toContain("\n");
});

test("switches, segments and buttons work with keyboard and preserve disabled state", async () => {
  const daily = page.getByRole("switch", { name: "Resumo diário às 8h" });
  expect(await daily.getAttribute("aria-checked")).toBe("false");
  await daily.focus();
  await page.keyboard.press("Space");
  expect(await daily.getAttribute("aria-checked")).toBe("true");
  expect(await page.getByRole("switch", { name: "Resumo por e-mail" }).isDisabled()).toBe(true);
  await page.getByRole("button", { name: "Ativas", exact: true }).click();
  expect(
    await page.getByRole("button", { name: "Ativas", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    await page.getByRole("button", { name: "Todas", exact: true }).getAttribute("aria-pressed"),
  ).toBe("false");
  await page.getByRole("button", { name: "Selecionado", exact: true }).click();
  expect(
    await page
      .getByRole("button", { name: "Selecionado", exact: true })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await page.getByRole("button", { name: "Aprovar e enviar", exact: true }).click();
  expect(await page.getByRole("status").textContent()).toBe(
    "Exemplo demonstrado. Nenhum relatório foi enviado.",
  );
});

test("kit switch tracks contain knobs on and off in both themes", async () => {
  for (const theme of ["light", "dark"]) {
    await page
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const daily = page.getByRole("switch", { name: "Resumo diário às 8h" });
    for (const checked of [false, true]) {
      if ((await daily.getAttribute("aria-checked")) !== String(checked)) await daily.click();
      expect(await daily.getAttribute("aria-checked")).toBe(String(checked));
      for (const control of await page.getByRole("switch").all()) {
        await expectSwitchGeometry(control, "span");
      }
    }
    const directory = process.env.PHASE6_SCREEN_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      await page
        .getByRole("heading", { name: "Ajustes · switch" })
        .locator("..")
        .screenshot({ path: join(directory, `switch-kit-${theme}.png`) });
    }
  }
});

test("theme persists, focus is visible, colors invert, reduced motion uses 1ms", async () => {
  await page.getByRole("button", { name: "Tema escuro" }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("boto.theme"))).toBe("dark");
  await page.reload();
  await page.getByRole("heading", { name: "Controles", exact: true }).waitFor();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  const selected = page.getByRole("button", { name: "Selecionado", exact: true });
  await selected.focus();
  const style = await selected.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      outline: css.outlineWidth,
      offset: css.outlineOffset,
      background: css.backgroundColor,
      color: css.color,
    };
  });
  expect(style.outline).toBe("2px");
  expect(style.offset).toBe("2px");
  expect(style.background).not.toBe(style.color);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByText("Em execução", { exact: true })
      .first()
      .locator("svg")
      .evaluate((el) => getComputedStyle(el).animationDuration),
  ).toBe("0.001s");
  await page.getByRole("button", { name: "Tema claro" }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
});

test("kit loads packaged Bricolage Grotesque, Inter and JetBrains Mono", async () => {
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    const displayFaces = await document.fonts.load('600 16px "Bricolage Grotesque"');
    const sansFaces = await document.fonts.load("400 16px Inter");
    const monoFaces = await document.fonts.load('400 13px "JetBrains Mono"');
    const h1 = document.querySelector("h1");
    const probe = document.createElement("p");
    probe.className = "meta";
    probe.textContent = "rótulo";
    document.body.appendChild(probe);
    const h1Family = h1 ? getComputedStyle(h1).fontFamily : "";
    const metaFamily = getComputedStyle(probe).fontFamily;
    const bodyFamily = getComputedStyle(document.body).fontFamily;
    probe.remove();
    const unquote = (family: string) => family.replaceAll(/["']/g, "");
    return {
      display: document.fonts.check('600 16px "Bricolage Grotesque"'),
      sans: document.fonts.check("400 16px Inter"),
      mono: document.fonts.check('400 13px "JetBrains Mono"'),
      displayFaces: displayFaces.length,
      sansFaces: sansFaces.length,
      monoFaces: monoFaces.length,
      h1Family: unquote(h1Family),
      metaFamily: unquote(metaFamily),
      bodyFamily: unquote(bodyFamily),
    };
  });
  expect(loaded.h1Family.split(",")[0]?.trim()).toBe("Bricolage Grotesque");
  expect(loaded.bodyFamily.split(",")[0]?.trim()).toBe("Inter");
  expect(loaded.metaFamily.split(",")[0]?.trim()).toBe("JetBrains Mono");
  expect(loaded.display).toBe(true);
  expect(loaded.sans).toBe(true);
  expect(loaded.mono).toBe(true);
  expect(loaded.displayFaces).toBeGreaterThan(0);
  expect(loaded.sansFaces).toBeGreaterThan(0);
  expect(loaded.monoFaces).toBeGreaterThan(0);
});

test("kit controls use Rio Negro height, radius and focus tokens", () => {
  const source = fileURLToPath(new URL("../src/components/ds", import.meta.url));
  const controls = readFileSync(join(source, "controls.module.css"), "utf8");
  const menu = readFileSync(join(source, "Menu.module.css"), "utf8");
  for (const css of [controls, menu]) {
    expect(css).toContain("var(--boto-size-control)");
    expect(css).toContain("pointer: coarse");
    expect(css).toContain("var(--boto-size-target)");
    expect(css).toContain("var(--boto-size-focus-ring)");
    expect(css).toContain("var(--boto-color-focus)");
  }
  expect(controls).toContain("var(--boto-size-control-sm)");
  expect(controls).toContain("var(--boto-radius-md)");
  expect(controls).toContain('data-tone="run"');
  expect(controls).not.toContain("pillDot");
  expect(controls.slice(controls.indexOf("@media (pointer: coarse)"))).toContain(
    ".iconSegments button",
  );
});

test("Library screens use the kit and scoped Rio Negro tokens", () => {
  const source = fileURLToPath(new URL("../src/components", import.meta.url));
  const component = readFileSync(join(source, "Library.tsx"), "utf8");
  const css = readFileSync(join(source, "Library.module.css"), "utf8");
  expect(component).toContain('from "./ds/controls"');
  expect(component).not.toMatch(/className="|btnCls|inputCls|<(?:button|select|textarea)\b/);
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
    expect(match[1]?.startsWith("--boto-")).toBe(true);
  }
});

test("all authored colors are token-based and dark controls retain visible focus and targets", async () => {
  const source = fileURLToPath(new URL("../src", import.meta.url));
  for (const file of readdirSync(source, { recursive: true })) {
    if (!file.endsWith(".css") || file.endsWith("tokens.css")) continue;
    expect(readFileSync(join(source, file), "utf8")).not.toMatch(
      /#[\da-f]{3,8}\b|\brgba?\(|(?<![-\w])(?:black|white)(?![-\w])/i,
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const all = page.getByRole("button", { name: "Todas", exact: true });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.getByRole("button", { name: "Ativas", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  await page.keyboard.press("Home");
  expect(await all.evaluate((element) => element === document.activeElement)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.keyboard.press("Tab");
    await all.focus();
    const computed = await all.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        outline: style.outlineWidth,
        offset: style.outlineOffset,
        transition: style.transitionDuration,
        width: rect.width,
        height: rect.height,
      };
    });
    expect(computed.outline).toBe("2px");
    expect(computed.offset).toBe("2px");
    expect(computed.transition).toBe("0.001s");
    expect(computed.width).toBeGreaterThanOrEqual(36);
    expect(computed.height).toBe(36);
    const out = process.env.PHASE6_SCREEN_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      await page.screenshot({ path: join(out, `kit-${theme}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

/** Pares da paleta Rio Negro (DESIGN.md), não calculados pelo gerador. */
const RIO = {
  light: {
    "--fg": [12, 20, 22],
    "--bg": [246, 248, 247],
    "--surface": [255, 255, 255],
    "--muted": [85, 103, 106],
    "--accent": [194, 69, 107],
    "--on-accent": [255, 255, 255],
    "--focus": [194, 69, 107],
  },
  dark: {
    "--fg": [232, 238, 238],
    "--bg": [12, 20, 22],
    "--surface": [19, 29, 32],
    "--muted": [147, 163, 165],
    "--accent": [240, 138, 166],
    "--on-accent": [12, 20, 22],
    "--focus": [240, 138, 166],
  },
} as const;

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrastRatio(a: [number, number, number], b: [number, number, number]) {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: [number, number, number]) =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test("Rio Negro palette meets AA contrast from computed colors in both themes", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"] as const) {
    await page
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const measured = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.setProperty("transition", "none", "important");
      document.body.append(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      const roles = ["--bg", "--fg", "--surface", "--muted", "--accent", "--on-accent", "--focus"];
      const colors = Object.fromEntries(roles.map((name) => [name, read(name)]));
      const save = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Salvar",
      );
      const button = save ? getComputedStyle(save) : null;
      probe.remove();
      return {
        colors,
        buttonBg: button?.backgroundColor ?? "",
        buttonFg: button?.color ?? "",
      };
    });
    const expected = RIO[theme];
    for (const [name, rgb] of Object.entries(expected)) {
      expect(parseRgb(measured.colors[name] ?? "")).toEqual([...rgb]);
    }
    const fg = parseRgb(measured.colors["--fg"] ?? "");
    const bg = parseRgb(measured.colors["--bg"] ?? "");
    const surface = parseRgb(measured.colors["--surface"] ?? "");
    const muted = parseRgb(measured.colors["--muted"] ?? "");
    const accent = parseRgb(measured.colors["--accent"] ?? "");
    const onAccent = parseRgb(measured.colors["--on-accent"] ?? "");
    const focus = parseRgb(measured.colors["--focus"] ?? "");
    if (!fg || !bg || !surface || !muted || !accent || !onAccent || !focus) {
      throw new Error(`cor não resolvida no tema ${theme}`);
    }
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fg, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(focus, bg)).toBeGreaterThanOrEqual(3);
    expect(parseRgb(measured.buttonBg)).toEqual([...expected["--accent"]]);
    expect(parseRgb(measured.buttonFg)).toEqual([...expected["--on-accent"]]);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("every custom property used in the desktop app resolves on the kit", async () => {
  const source = fileURLToPath(new URL("../src", import.meta.url));
  const used = new Set<string>();
  for (const file of readdirSync(source, { recursive: true })) {
    if (
      !String(file).endsWith(".css") &&
      !String(file).endsWith(".tsx") &&
      !String(file).endsWith(".ts")
    ) {
      continue;
    }
    for (const match of readFileSync(join(source, String(file)), "utf8").matchAll(
      /var\(\s*--([\w-]+)/g,
    )) {
      const name = match[1];
      if (name) used.add(name);
    }
  }
  const missing = await page.evaluate(
    (names) => {
      const declared = new Set<string>();
      const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
          const style = "style" in rule ? (rule as CSSStyleRule).style : undefined;
          if (style) {
            for (const property of style) {
              if (property.startsWith("--")) declared.add(property.slice(2));
            }
          }
          if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try {
          walk(sheet.cssRules);
        } catch {
          // folha de outra origem
        }
      }
      const root = getComputedStyle(document.documentElement);
      return names.filter((name) => {
        if (root.getPropertyValue(`--${name}`).trim()) return false;
        return !declared.has(name);
      });
    },
    [...used],
  );
  expect(missing).toEqual([]);
});

test("kit titles are semibold and the Rio Negro palette is on the page", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Tema claro", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.locator("h1").evaluate((element) => getComputedStyle(element).fontWeight)).toBe(
    "600",
  );
  expect(
    await page
      .locator("h2")
      .first()
      .evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe("600");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("16px");
  const swatch = page.getByRole("list", { name: "Paleta Rio Negro" });
  const accent = await swatch
    .getByRole("listitem", { name: "Destaque", exact: true })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(parseRgb(accent)).toEqual([194, 69, 107]);
  await page.getByRole("button", { name: "Tema escuro", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const darkAccent = await swatch
    .getByRole("listitem", { name: "Destaque", exact: true })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(parseRgb(darkAccent)).toEqual([240, 138, 166]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("danger button outline differs from the primary button in both themes", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"] as const) {
    await page
      .getByRole("button", { name: theme === "light" ? "Tema claro" : "Tema escuro", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const read = (name: string) =>
      page
        .getByRole("button", { name, exact: true })
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderWidth: style.borderTopWidth,
            borderStyle: style.borderTopStyle,
          };
        });
    const primary = await read("Aprovar e enviar");
    const danger = await read("Excluir agente…");
    expect(danger.background).not.toBe(primary.background);
    expect(danger.borderWidth).toBe("2px");
    expect(danger.borderStyle).toBe("solid");
    expect(primary.borderWidth).not.toBe("2px");
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("delete confirmation starts on Cancelar and Enter does not delete", async () => {
  const before = await page.getByRole("status").textContent();
  const opener = page.getByRole("button", { name: "Excluir agente…", exact: true }).first();
  await opener.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const cancel = dialog.getByRole("button", { name: "Cancelar", exact: true });
  expect(await cancel.evaluate((button) => button === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  const confirm = dialog.getByRole("button", { name: "Excluir agente", exact: true });
  expect(await confirm.evaluate((button) => button === document.activeElement)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await cancel.evaluate((button) => button === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });
  expect(await page.getByRole("status").textContent()).toBe(before);
  expect(await opener.evaluate((button) => button === document.activeElement)).toBe(true);
});

test("escape closes the delete confirmation without deleting", async () => {
  const before = await page.getByRole("status").textContent();
  const opener = page.getByRole("button", { name: "Excluir agente…", exact: true }).first();
  await opener.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  expect(await page.getByRole("status").textContent()).toBe(before);
  expect(await opener.evaluate((button) => button === document.activeElement)).toBe(true);
});

test("delete confirmation offers undo instead of promising it is permanent", async () => {
  await page.getByRole("button", { name: "Excluir agente…", exact: true }).first().click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const body = (await dialog.locator("p").first().textContent()) ?? "";
  expect(body).not.toContain("Não dá para desfazer");
  expect(body).not.toContain("somem");
  expect(body).toContain("Desfazer");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
});

test("the agent is deleted only from the Excluir agente button", async () => {
  const opener = page.getByRole("button", { name: "Excluir agente…", exact: true }).first();
  await opener.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  expect(await page.getByRole("status").textContent()).not.toBe("Agente “Revisor de PR” excluído.");
  await opener.click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Excluir agente", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  expect(await page.getByRole("status").textContent()).toBe("Agente “Revisor de PR” excluído.");
});

test("chat column max-width follows the Rio Negro token", async () => {
  const maxWidth = await page.evaluate(() => {
    const column = document.createElement("div");
    column.className = "thread-inner";
    document.body.append(column);
    const value = getComputedStyle(column).maxWidth;
    column.remove();
    return value;
  });
  expect(maxWidth).toBe("760px");
});

test("Hosts and E-mail settings use scoped Rio Negro controls without migrating composer drafts", () => {
  const source = fileURLToPath(new URL("../src/components", import.meta.url));
  for (const name of ["HostsView", "EmailView"]) {
    const component = readFileSync(join(source, `${name}.tsx`), "utf8");
    const css = readFileSync(join(source, `${name}.module.css`), "utf8");
    const settings =
      name === "EmailView"
        ? component.slice(component.indexOf("export function EmailView"))
        : component;
    expect(component).toContain('from "./ds/controls"');
    expect(settings).not.toMatch(/className="|btnCls|inputCls|<(?:button|select|textarea)\b/);
    for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
      expect(match[1]?.startsWith("--boto-")).toBe(true);
    }
    if (name === "EmailView") {
      expect(settings).toMatch(/<DraftCard\s+settings/);
      const composer = component.slice(
        component.indexOf("export function DraftCards"),
        component.indexOf("export function EmailView"),
      );
      expect(composer).not.toContain("settings");
      expect(component).toContain('const Action = settings ? Button : "button"');
    }
  }
});

test("build-tokens.ts leaves committed css unchanged", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const tokensPath = join(root, "apps/desktop/src/styles/tokens.css");
  const bridgePath = join(root, "apps/desktop/src/styles/legacy-bridge.css");
  const beforeTokens = readFileSync(tokensPath, "utf8");
  let beforeBridge = "";
  try {
    beforeBridge = readFileSync(bridgePath, "utf8");
  } catch {
    beforeBridge = "";
  }
  const result = spawnSync(process.execPath, ["scripts/build-tokens.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(readFileSync(tokensPath, "utf8")).toBe(beforeTokens);
  expect(readFileSync(bridgePath, "utf8")).toBe(beforeBridge);
});
