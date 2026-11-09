import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import {
  DaemonClient,
  FAKE_AGENT,
  ROOT,
  removeDirAfterExit,
  startDaemon,
  tmp,
} from "../../../packages/daemon/test/helpers";

test("onboarding persists real profile, handles errors, and exposes working shortcuts", async () => {
  const dir = tmp("boto-onboarding-");
  const token = crypto.randomUUID();
  const daemon = await startDaemon(dir, `${dir}/agents`, token, {
    BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
  });
  const client = await DaemonClient.connect(daemon.port, token);
  const vite = Bun.spawn(
    ["bun", "apps/desktop/node_modules/vite/bin/vite.js", "apps/desktop", "--port", "1420"],
    {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch("http://localhost:1420")).ok;
      } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    const page = await browser.newPage();
    // 03:00 must greet like Home does ("Boa noite"), not "Bom dia".
    await page.clock.install({ time: new Date(2026, 10, 9, 3, 0) });
    await page.goto(`http://localhost:1420/#port=${daemon.port}&token=${token}`);
    await page.locator("#onboarding[open]").waitFor();
    await page.locator("#ob-next:not([disabled])").click();
    await page.locator("#ob-name").fill("Iara");
    await page.locator("#ob-about").fill("Prefiro respostas curtas.");
    expect(await page.locator("#ob-about-count").textContent()).toBe("25/600");
    expect(await page.locator("#ob-mini-greeting").textContent()).toBe("Boa noite, Iara.");
    await page.locator("#ob-next").click();
    expect(await page.locator('[data-ob-mode="aprovacao"]').getAttribute("aria-checked")).toBe(
      "true",
    );
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
    await page.reload();
    await page.locator(".sb-user").first().waitFor();
    await page.keyboard.press("Control+k");
    await page.locator("#command-input").fill("Atalhos");
    await page.keyboard.press("Enter");
    await page.locator("#shortcuts[open]").waitFor();
    expect(await page.locator("#onboarding").getAttribute("open")).toBeNull();
    await page.keyboard.press("Escape");
    await page.locator("#shortcuts[open]").waitFor({ state: "hidden" });
    expect(await page.locator("#greeting").textContent()).toContain("Boa noite");
    await page.keyboard.press("Control+Shift+o");
    expect(await page.locator("#main").getAttribute("data-view")).toBe("new");
    await page.locator("#send-label").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#approval-switch")?.getAttribute("aria-checked") === "true",
    );
    await client.request("profile.update", {
      defaults: { delegationMode: "scheduled", requireApproval: false },
    });
    await page.locator(".sb").getByText("Início", { exact: true }).click();
    await page.keyboard.press("Control+Shift+o");
    await page.waitForFunction(
      () => document.querySelector("#when-label")?.textContent === "Daqui a 1 hora",
    );
    expect(await page.locator("#approval-switch").getAttribute("aria-checked")).toBe("false");
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
                  title: "Excluir agente?",
                  description: "Esta ação remove o agente.",
                  action: "Excluir",
                });
                setResult(String(answer));
                if (answer) toast("Agente excluído.");
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
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("confirm-cancel");
    await page.keyboard.press("Escape");
    expect(await page.locator("#confirm-result").textContent()).toBe("false");
    await page.locator("#ask-confirm").click();
    await page.locator("#confirm-ok").click();
    expect(await page.locator("#confirm-result").textContent()).toBe("true");
    await page.locator(".toast").waitFor();
    expect(await page.locator(".toast").textContent()).toContain("Agente excluído.");
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
      await page.locator("#confirm").waitFor({ state: "detached" });
      expect(await page.locator("#confirm-result").textContent()).toBe(
        `pending:${outcome === "resolve"}`,
      );
    }
  } finally {
    await browser.close();
    client.close();
    await removeDirAfterExit(vite, dir + "-unused");
    await removeDirAfterExit(daemon.proc, dir);
  }
}, 60000);
