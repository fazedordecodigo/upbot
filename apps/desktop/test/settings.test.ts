import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
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

let browser: Browser;
let vite: Awaited<ReturnType<typeof startVite>> | undefined;
let daemon: DaemonHandle;
let rpc: DaemonClient;
let directory: string;
const token = crypto.randomUUID();
const base = "http://localhost:1420";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  expect(await check()).toBe(true);
}

beforeAll(async () => {
  directory = tmp("boto-settings-ui-");
  daemon = await startDaemon(
    directory,
    join(directory, "agents"),
    token,
    {
      BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify([process.execPath, FAKE_AGENT]),
      BOTO_VAULT_KEY: "14".repeat(32),
      BOTO_PROVIDER_LOGIN_COMMAND_DEVIN: JSON.stringify([
        process.execPath,
        "-e",
        "await Bun.sleep(1500)",
      ]),
    },
    true,
  );
  rpc = await DaemonClient.connect(daemon.port, token);
  await rpc.request("onboarding.complete", {});
  vite = await startVite();
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close();
  rpc?.close();
  if (daemon) await stopDaemon(daemon, undefined);
  await vite?.stop();
  if (directory) await removeDir(directory);
}, 30000);

test("approval default toggle clears approval delegation but preserves now and scheduled modes", async () => {
  await rpc.request("profile.update", {
    defaults: { requireApproval: true, delegationMode: "approval" },
  });
  const p = await settings();
  try {
    await tab(p, "privacy");
    await p.locator("#st-approval:not(:disabled)").click();
    await until(async () => !(await rpc.request("profile.get", {})).defaults.requireApproval);
    expect((await rpc.request("profile.get", {})).defaults.delegationMode).toBe("now");
    await p.locator("#st-approval:not(:disabled)").click();
    await until(async () => (await rpc.request("profile.get", {})).defaults.requireApproval);
    expect((await rpc.request("profile.get", {})).defaults.delegationMode).toBe("now");
    await rpc.request("profile.update", { defaults: { delegationMode: "scheduled" } });
    await p.reload();
    await p.locator(".sb-settings").click();
    await tab(p, "privacy");
    await p.locator("#st-approval:not(:disabled)").click();
    await until(async () => !(await rpc.request("profile.get", {})).defaults.requireApproval);
    expect((await rpc.request("profile.get", {})).defaults.delegationMode).toBe("scheduled");
  } finally {
    await p.close();
    await rpc.request("profile.update", {
      defaults: { requireApproval: true, delegationMode: "now" },
    });
  }
}, 30_000);

async function settings() {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto(`${base}/#port=${daemon.port}&token=${token}`);
  await p.locator(".sb-settings").click();
  await p
    .locator("#st-clis .st-row")
    .first()
    .waitFor({ timeout: 10000 })
    .catch(async () => {
      throw new Error(await p.locator("#view-settings").innerText());
    });
  return p;
}
async function tab(p: Page, id: string) {
  await p.locator(`#st-tab-${id}`).click();
}

test("real settings: provider catalog, masked keys, profile, memories, appearance and permissions", async () => {
  const p = await settings();
  try {
    const catalog = await rpc.request("providers.list", {});
    expect(await p.locator("#st-clis .st-row-name").allTextContents()).toEqual(
      catalog.map((provider) => provider.name),
    );
    await p.locator("#st-tab-provider").focus();
    await p.keyboard.press("ArrowUp");
    expect(await p.locator("#st-tab-privacy").getAttribute("aria-selected")).toBe("true");
    await p.keyboard.press("ArrowRight");
    expect(await p.locator("#st-tab-provider").getAttribute("aria-selected")).toBe("true");
    await p.keyboard.press("End");
    expect(await p.locator("#st-tab-privacy").getAttribute("aria-selected")).toBe("true");
    await p.keyboard.press("Home");
    await p.keyboard.press("ArrowDown");
    expect(await p.locator("#st-tab-memory").getAttribute("aria-selected")).toBe("true");
    await p.keyboard.press("ArrowLeft");
    const secret = "settings-test-secret-never-rendered-123456";
    const keyRow = p.locator("#st-keys .st-row").filter({ has: p.locator("#st-key-devin") });
    await p.locator("#st-key-devin").fill(secret);
    await keyRow.getByRole("button", { name: "Salvar", exact: true }).click();
    const savedRow = p.locator("#st-keys .st-row").filter({ hasText: "Devin" });
    await savedRow.getByRole("button", { name: "Remover" }).waitFor();
    expect(await savedRow.innerText()).toContain(
      (await rpc.request("providers.list", {})).find((provider) => provider.id === "devin")
        ?.apiKeyMasked ?? "missing",
    );
    expect(await p.content()).not.toContain(secret);
    expect(
      await p
        .locator('input[type="password"]')
        .evaluateAll((inputs) =>
          inputs.some((input) =>
            (input as HTMLInputElement).value.includes("settings-test-secret"),
          ),
        ),
    ).toBe(false);
    await savedRow.getByRole("button", { name: "Remover" }).click();
    await p.locator("#st-key-devin").waitFor();
    await p.locator("#st-scan").click();
    await until(async () =>
      (await p.locator("#st-scan-status").innerText()).includes("CLIs encontradas."),
    );
    await p.locator("#st-default select").selectOption("devin");
    await until(async () => (await rpc.request("providers.getDefault", {})).provider === "devin");
    expect(
      (await rpc.request("providers.list", {})).find((provider) => provider.id === "devin")
        ?.hasApiKey,
    ).toBe(false);
    await tab(p, "memory");
    await p.locator("#st-name").fill("Iara");
    await p.locator("#st-about").fill("Prefiro respostas curtas.");
    await p.locator("#st-mem-save").click();
    await until(async () => (await p.locator("#st-mem-status").innerText()) === "Salvo.");
    expect(await rpc.request("profile.get", {})).toMatchObject({
      name: "Iara",
      about: "Prefiro respostas curtas.",
    });
    expect(await p.locator("#st-about-count").innerText()).toBe("25/600");
    expect(await p.locator("#st-memories").innerText()).toContain(
      "Nenhum agente guardou memórias ainda.",
    );
    const agent = await rpc.request("agents.create", { name: "Memória UI", provider: "devin" });
    const memory = await rpc.request("memories.add", {
      agentId: agent.id,
      text: "Gosta de TypeScript.",
    });
    await p.locator("#st-memories .st-row").filter({ hasText: memory.text }).waitFor();
    await p.locator("#st-memories").getByRole("button", { name: "Editar", exact: true }).click();
    await p.getByRole("textbox", { name: "Texto da memória" }).fill("x".repeat(10000));
    await p.locator("#st-memories").getByRole("button", { name: "Salvar", exact: true }).click();
    await p.locator("#st-memories .st-error").waitFor();
    expect(await p.locator("#st-memories .st-error").innerText()).toBe(
      "Não foi possível atualizar a memória.",
    );
    await p.getByRole("textbox", { name: "Texto da memória" }).fill("Prefere Bun.");
    await p.locator("#st-memories").getByRole("button", { name: "Salvar", exact: true }).click();
    await until(
      async () =>
        (await rpc.request("memories.list", { agentId: agent.id }))[0]?.text === "Prefere Bun.",
    );
    await p.locator("#st-memories").getByRole("button", { name: "Apagar", exact: true }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Apagar", exact: true }).click();
    await until(
      async () => (await rpc.request("memories.list", { agentId: agent.id })).length === 0,
    );
    const stale = await rpc.request("memories.add", {
      agentId: agent.id,
      text: "Memória removida em outra sessão.",
    });
    await p.locator("#st-memories").getByRole("button", { name: "Editar", exact: true }).click();
    await p.getByRole("textbox", { name: "Texto da memória" }).fill("Nova versão.");
    await rpc.request("memories.delete", { id: stale.id });
    await until(async () => (await p.locator("#st-memories .st-row").count()) === 0);
    await p.locator("#st-forget").click();
    await p.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
    expect((await rpc.request("profile.get", {})).name).toBe("Iara");
    await tab(p, "appearance");
    expect(
      await p.locator("#st-themes").evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    expect((await p.locator("#st-themes .ob-swatch").first().boundingBox())?.height).toBe(64);
    await p.locator('[data-st-theme="light"]').click();
    expect(await p.locator("html").getAttribute("data-theme")).toBe("light");
    await until(async () => (await rpc.request("profile.get", {})).theme === "light");
    await p.keyboard.press("ArrowLeft");
    await until(async () => (await p.locator("html").getAttribute("data-theme")) === "dark");
    await p.locator("#st-width").fill("320");
    expect(await p.locator("#st-width-out").innerText()).toBe("320 px");
    expect(await p.locator("#sb-resizer").getAttribute("aria-valuenow")).toBe("320");
    expect(Math.round((await p.locator("#sidebar").boundingBox())?.width ?? 0)).toBe(320);
    await until(async () => (await rpc.request("profile.get", {})).sidebarWidth === 320);
    await p.locator("#sb-resizer").focus();
    await p.keyboard.press("ArrowRight");
    expect(await p.locator("#st-width").inputValue()).toBe("328");
    await p.locator("#st-width-reset").click();
    expect(await p.locator("#st-width").inputValue()).toBe("272");
    await tab(p, "privacy");
    await p.locator("#st-private").click();
    await until(async () => (await rpc.request("profile.get", {})).defaults.private);
    await p.locator("#st-approval").click();
    await until(async () => !(await rpc.request("profile.get", {})).defaults.requireApproval);
    await rpc.request("approvals.setRules", {
      rules: [{ id: "settings-allow", pattern: "list_agents", action: "allow", agentId: null }],
    });
    await p.locator("#st-perms").getByRole("button", { name: "Revogar" }).waitFor();
    await p.locator("#st-perms").getByRole("button", { name: "Revogar" }).click();
    await until(
      async () =>
        (await rpc.request("tools.permissions.list", {})).find(
          (permission) => permission.toolId === "rule:settings-allow",
        )?.level === "ask",
    );
    await until(async () =>
      (await p.locator("#st-perms").innerText()).includes(
        "Nenhuma ferramenta liberada em todas as sessões ainda.",
      ),
    );
    await tab(p, "memory");
    await p.locator("#st-forget").click();
    await p.getByRole("dialog").getByRole("button", { name: "Apagar", exact: true }).click();
    await until(async () => (await rpc.request("profile.get", {})).name === "");
    expect((await rpc.request("profile.get", {})).about).toBe("");
  } finally {
    await p.close();
  }
}, 60000);

test("installed CLIs with a login command can sign in and show the waiting state", async () => {
  const p = await settings();
  try {
    const row = p.locator("#st-accounts .st-row").filter({ hasText: "Devin" });
    await row.waitFor();
    expect(await row.locator(".badge").count()).toBe(0);
    const button = row.getByRole("button");
    expect(await button.innerText()).toBe("Entrar");
    await button.click();
    await until(async () => (await button.innerText()) === "Aguardando o navegador…");
    await until(async () => await button.isDisabled());
    await until(
      async () => (await button.innerText()) === "Entrar" && !(await button.isDisabled()),
    );
  } finally {
    await p.close();
  }
}, 30000);

test("theme and sidebar width saved in the profile survive a fresh webview without being overwritten", async () => {
  await rpc.request("profile.update", { sidebarWidth: 320, theme: "light" });
  const p = await settings();
  try {
    await tab(p, "appearance");
    await until(async () => (await p.locator("#st-width").inputValue()) === "320");
    expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await p.locator('[data-st-theme="light"]').getAttribute("aria-checked")).toBe("true");
    await p.waitForTimeout(700);
    expect(await rpc.request("profile.get", {})).toMatchObject({
      sidebarWidth: 320,
      theme: "light",
    });
  } finally {
    await p.close();
    await rpc.request("profile.update", { sidebarWidth: 272, theme: "dark" });
  }
}, 30000);

test("settings is safe without daemon and keeps keyboard navigation", async () => {
  const p = await browser.newPage();
  try {
    await p.goto(base);
    await p.locator(".sb-settings").click();
    expect(await p.locator("#st-clis .st-empty").innerText()).toContain("Carregando…");
    await tab(p, "memory");
    expect(await p.locator("#st-memory .st-empty").first().innerText()).toContain("Carregando…");
    await tab(p, "privacy");
    expect(await p.locator("#st-private").isDisabled()).toBe(true);
  } finally {
    await p.close();
  }
}, 30000);
