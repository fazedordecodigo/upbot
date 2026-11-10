import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  removeDirAfterExit,
  startDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";
import { startVite } from "./vite";

test("onboarding persists real profile, handles errors, and exposes working shortcuts", async () => {
  const dir = tmp("boto-onboarding-");
  const token = crypto.randomUUID();
  const daemon = await startDaemon(dir, `${dir}/agents`, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
  });
  const client = await DaemonClient.connect(daemon.port, token);
  const vite = await startVite();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    // 03:00 must greet like Home does ("Boa noite"), not "Bom dia".
    await page.clock.install({ time: new Date(2026, 10, 9, 3, 0) });
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.locator("#onboarding[open]").waitFor();
    for (const key of ["Control+k", "Meta+k", "Control+Shift+o", "Meta+Shift+o"]) {
      await page.keyboard.press(key);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.locator("#main").getAttribute("data-view")).toBe("home");
    }
    await page.locator("#ob-next:not([disabled])").click();
    await page.locator("#ob-name").fill("Iara");
    await page.locator("#ob-about").fill("Prefiro respostas curtas.");
    expect(await page.locator("#ob-about-count").textContent()).toBe("25/600");
    expect(await page.locator("#ob-mini-greeting").textContent()).toBe("Boa noite, Iara.");
    await page.locator("#ob-next").click();
    expect(await page.locator('[data-ob-mode="agora"]').getAttribute("aria-checked")).toBe("true");
    await page.locator('[data-ob-mode="agendar"]').click();
    await page.keyboard.press("ArrowDown");
    expect(await page.locator('[data-ob-mode="aprovacao"]').getAttribute("aria-checked")).toBe(
      "true",
    );
    await page.locator("#ob-next").click();
    await page.locator('[data-ob-theme="light"]').click();
    await page.locator("#ob-private").click();
    await page.locator("#ob-next").click();
    await page.locator("#onboarding[open]").waitFor({ state: "hidden" });
    const profile = await client.request("profile.get", {});
    expect(profile.name).toBe("Iara");
    expect(profile.about).toBe("Prefiro respostas curtas.");
    expect(profile.defaults.delegationMode).toBe("approval");
    expect(profile.defaults.requireApproval).toBe(true);
    expect(profile.defaults.private).toBe(true);
    expect(profile.theme).toBe("light");
    expect(profile.onboardingCompletedAt).not.toBeNull();
    await page.waitForFunction(
      () => document.querySelector("#private-switch")?.getAttribute("aria-checked") === "true",
    );
    await page.locator("#private-switch").click();
    await page.waitForFunction(
      () => document.querySelector("#private-switch")?.getAttribute("aria-checked") === "false",
    );
    await page.locator(".sb-user").first().click();
    await page.getByRole("menuitem", { name: "Conhecer o Boto" }).click();
    await page.locator("#ob-next:not([disabled])").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#ob-private")?.getAttribute("aria-checked") === "false",
    );
    expect((await client.request("profile.get", {})).defaults.private).toBe(false);
    await page.locator("#ob-skip").click();
    await page.locator("#onboarding[open]").waitFor({ state: "hidden" });
    for (const cache of [null, "dark"]) {
      const context = await browser.newContext();
      if (cache)
        await context.addInitScript((value) => localStorage.setItem("boto.theme", value), cache);
      const fresh = await context.newPage();
      await fresh.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
      await fresh.waitForFunction(() => document.documentElement.dataset.theme === "light");
      expect(await fresh.evaluate(() => localStorage.getItem("boto.theme"))).toBe("light");
      expect(await fresh.locator("#onboarding[open]").count()).toBe(0);
      await context.close();
    }
    await page.reload();
    await page.locator(".sb-user").first().waitFor();
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.id = "unrelated-modal";
      document.body.append(dialog);
      dialog.showModal();
    });
    for (const key of ["Control+k", "Meta+k", "Control+Shift+o", "Meta+Shift+o"]) {
      await page.keyboard.press(key);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.locator("#main").getAttribute("data-view")).toBe("home");
    }
    await page.evaluate(() => document.getElementById("unrelated-modal")?.remove());
    await page.keyboard.press("Control+k");
    await page.locator("#command-input").fill("Atalhos");
    await page.keyboard.press("Enter");
    await page.locator("#shortcuts[open]").waitFor();
    for (const key of ["Control+k", "Control+Shift+o"]) {
      await page.keyboard.press(key);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.locator("#main").getAttribute("data-view")).toBe("home");
    }
    expect(await page.locator("#onboarding").getAttribute("open")).toBeNull();
    await page.keyboard.press("Escape");
    await page.locator("#shortcuts[open]").waitFor({ state: "hidden" });
    expect(await page.locator("#greeting").textContent()).toContain("Boa noite");
    await page.keyboard.press("Control+Shift+o");
    expect(await page.locator("#main").getAttribute("data-view")).toBe("new");
    await page.waitForFunction(
      () =>
        (document.querySelector("#composer-input") as HTMLTextAreaElement | null)?.disabled ===
        false,
    );
    await client.request("profile.update", {
      defaults: { delegationMode: "scheduled", requireApproval: false },
    });
    await page.locator(".sb").getByText("Início", { exact: true }).click();
    await page.keyboard.press("Control+Shift+o");
    await page.waitForFunction(
      () =>
        (document.querySelector("#composer-input") as HTMLTextAreaElement | null)?.disabled ===
        false,
    );
    await client.request("profile.update", {
      defaults: { delegationMode: "approval", requireApproval: true },
    });
    await client.request("onboarding.reset", {});
    await page.locator("#onboarding[open]").waitFor();
    await page.locator('[data-ob-go="2"]').click();
    expect(await page.locator("#ob-name").inputValue()).toBe("Iara");
    await client.request("profile.update", { name: "", about: "" });
    // Force the real daemon's validation error, keeping completion unavailable until retry.
    await page.locator("#ob-name").evaluate((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "x".repeat(41));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#ob-skip").click();
    await page.locator('#onboarding [role="alert"]').waitFor();
    expect(await page.locator('#onboarding [role="alert"]').textContent()).toBe(
      "Confira os dados: o nome pode ter até 40 caracteres e o texto sobre você, até 600.",
    );
    expect((await client.request("profile.get", {})).onboardingCompletedAt).toBeNull();
    await page.locator("#ob-name").fill("");
    await page.locator("#ob-about").fill("");
    await page.locator("#ob-skip").click();
    await page.locator("#onboarding[open]").waitFor({ state: "hidden" });
    expect((await client.request("profile.get", {})).name).toBe("");
    await page.evaluate(async () => {
      const { default: React } = await import("/node_modules/.vite/deps/react.js");
      const { createElement: h, useState } = React;
      const { default: ReactDOM } = await import("/node_modules/.vite/deps/react-dom_client.js");
      const { ConfirmProvider, useConfirm } = await import("/src/dialogs/ConfirmDialog.tsx");
      const { ToastProvider, useToast } = await import("/src/ui/Toast.tsx");
      function Harness() {
        const confirm = useConfirm();
        const toast = useToast();
        const [result, setResult] = useState("");
        return h(
          "div",
          null,
          h(
            "button",
            {
              id: "ask-confirm",
              onClick: async () => {
                const answer = await confirm({
                  title: "Excluir bot?",
                  description: "Esta ação remove o bot.",
                  action: "Excluir",
                });
                setResult(String(answer));
                if (answer) toast("Bot excluído.");
              },
            },
            "Confirmar",
          ),
          h(
            "button",
            {
              id: "ask-pending",
              onClick: async () => {
                const answer = await confirm({
                  title: "Remover item?",
                  description: "Este item deixará de ficar disponível.",
                  action: "Remover",
                  pendingAction: "Removendo…",
                  onConfirm: () =>
                    new Promise<void>((resolve, reject) => {
                      Object.assign(window, { settleConfirm: { resolve, reject } });
                    }),
                });
                setResult(`pending:${answer}`);
              },
            },
            "Pendente",
          ),
          h("output", { id: "confirm-result" }, result),
        );
      }
      document.querySelector("#root")?.remove();
      const root = document.createElement("div");
      document.body.append(root);
      ReactDOM.createRoot(root).render(
        h(ToastProvider, null, h(ConfirmProvider, null, h(Harness))),
      );
    });
    await page.locator("#ask-confirm").click();
    await page.locator("#confirm[open]").waitFor();
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Control+Shift+o");
    expect(await page.locator("dialog[open]").count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("confirm-cancel");
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm-result").textContent()).toBe("false");
    await page.locator("#ask-confirm").click();
    await page.locator("#confirm-ok").click();
    expect(await page.locator("#confirm-result").textContent()).toBe("true");
    await page.locator(".toast").waitFor();
    expect(await page.locator(".toast").textContent()).toContain("Bot excluído.");
    expect(
      await page.locator(".toaster").evaluate((element) => getComputedStyle(element).maxWidth),
    ).toBe("360px");
    expect(
      await page.locator(".toast").evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(360);
    await page.locator('.toast button[aria-label="Fechar"]').click();
    expect(await page.locator(".toast").count()).toBe(0);
    type Settle = { settleConfirm: { resolve: () => void; reject: (e: Error) => void } };
    for (const outcome of ["resolve", "reject"] as const) {
      await page.locator("#ask-pending").click();
      await page.locator("#confirm-ok").click();
      expect(await page.locator("#confirm-ok").textContent()).toBe("Removendo…");
      expect(await page.locator("#confirm-ok").isDisabled()).toBe(true);
      expect(await page.locator("#confirm-cancel").isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await page.locator("#confirm[open]").count()).toBe(1);
      await page.evaluate((outcome) => {
        const { settleConfirm } = window as unknown as Settle;
        if (outcome === "resolve") settleConfirm.resolve();
        else settleConfirm.reject(new Error("falhou"));
      }, outcome);
      if (outcome === "reject") {
        await page.locator('#confirm[aria-busy="false"]').waitFor();
        expect(await page.locator("#confirm-ok").isEnabled()).toBe(true);
        await page.locator("#confirm-cancel").click();
      }
      await page.locator("#confirm").waitFor({ state: "detached" });
      expect(await page.locator("#confirm-result").textContent()).toBe(
        `pending:${outcome === "resolve"}`,
      );
    }
  } finally {
    await browser.close();
    client.close();
    await vite.stop();
    await removeDirAfterExit(daemon.proc, dir);
  }
}, 60000);

test("onboarding errors never expose daemon messages", async () => {
  const { onboardingErrorMessage } = await import("../src/lib/errors");
  expect(onboardingErrorMessage(new Error("private internal details"))).toBe(
    "Não foi possível salvar suas preferências. Tente de novo.",
  );
  expect(onboardingErrorMessage(new Error("daemon not connected"))).toBe(
    "Sem conexão com o Boto. Tente de novo quando a conexão voltar.",
  );
});

test("prototype styles cover onboarding and shortcuts markup", () => {
  const css = readFileSync(
    new URL("../../../docs/design/assets/boto-ui.css", import.meta.url),
    "utf8",
  );
  const html = readFileSync(new URL("../../../docs/design/index.html", import.meta.url), "utf8");
  for (const name of [
    "onboarding",
    "ob-visual",
    "ob-panel",
    "ob-progress",
    "ob-dot",
    "ob-options",
    "ob-option",
    "ob-radio",
    "ob-swatch",
    "ob-setting",
    "ob-tip",
    "ob-foot",
    "shortcut-list",
    "shortcut-row",
  ]) {
    expect(html).toContain(name);
    expect(css).toContain(`.${name}`);
  }
  expect(css).toContain("@media (max-width: 767px)");
  expect(css).toContain(".onboarding .ob-visual { display: none; }");
});
