import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import { z } from "zod";
import {
  type ComputerEnvironment,
  clickCommand,
  computerSupport,
  keyCommand,
  screenshotCommand,
  typeCommand,
} from "./computer-platform";
import { getSetting, setSetting } from "./db/settings";

// Off for every agent until the user allows it. All bridge calls also pass approval gating.
// BOTO_COMPUTER_DRYRUN=<file> logs the commands instead of running them (tests).

const accessSchema = z.array(z.string());

export class ComputerUse {
  constructor(
    private db: Database,
    private environment: ComputerEnvironment = {},
  ) {}

  access(): string[] {
    return getSetting(this.db, "computer_use_agents", accessSchema, []);
  }

  setAccess(agentIds: string[]): void {
    setSetting(this.db, "computer_use_agents", [...new Set(agentIds)]);
  }

  available(): boolean {
    return this.status().available;
  }

  status(): { available: boolean; reason?: string } {
    const support = computerSupport(this.environment);
    return "backend" in support
      ? { available: true }
      : { available: false, reason: support.reason };
  }

  private check(agent: Agent) {
    const support = computerSupport(this.environment);
    if ("reason" in support) throw new Error(support.reason);
    if (!this.access().includes(agent.id)) {
      throw new Error(
        "Computer Use is not enabled for you; the user can enable it in your agent settings",
      );
    }
    return support.backend;
  }

  private async exec(cmd: string[], text?: string): Promise<void> {
    const dry = (this.environment.env ?? process.env).BOTO_COMPUTER_DRYRUN;
    if (dry) {
      appendFileSync(dry, `${JSON.stringify(cmd)}\n`);
      return;
    }
    let code: number;
    try {
      const p = Bun.spawn(cmd, {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        timeout: 15_000,
        ...(text === undefined ? {} : { env: { ...process.env, BOTO_COMPUTER_TEXT: text } }),
      });
      code = await p.exited;
    } catch {
      throw new Error("Computer Use command could not start");
    }
    if (code !== 0) throw new Error(`Computer Use command failed (exit ${code})`);
  }

  async screenshot(agent: Agent): Promise<string> {
    const backend = this.check(agent);
    const dir = join(agent.workspacePath, "computer");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `screen-${Date.now()}.png`);
    await this.exec(screenshotCommand(backend, file));
    const display = backend.platform === "linux" ? "X11 desktop" : "main display";
    const units = backend.platform === "darwin" ? "screen points" : "screen pixels";
    return `saved a screenshot of the ${display} to ${file} (click coordinates are in ${units})`;
  }

  async click(agent: Agent, x: unknown, y: unknown, double: boolean): Promise<string> {
    const backend = this.check(agent);
    const px = Number(x);
    const py = Number(y);
    if (
      !Number.isFinite(px) ||
      !Number.isFinite(py) ||
      px < 0 ||
      py < 0 ||
      px > 2147483647 ||
      py > 2147483647
    )
      throw new Error("`x`/`y` must be screen points");
    await this.exec(clickCommand(backend, Math.round(px), Math.round(py), double));
    return `${double ? "double-" : ""}clicked at ${Math.round(px)},${Math.round(py)}`;
  }

  async type(agent: Agent, text: string): Promise<string> {
    const backend = this.check(agent);
    if (!text || text.length > 5000 || text.includes("\0"))
      throw new Error("`text` must be 1-5000 characters without NUL");
    await this.exec(typeCommand(backend, text), backend.platform === "win32" ? text : undefined);
    return `typed ${text.length} characters`;
  }

  async key(agent: Agent, key: string, modifiers: unknown): Promise<string> {
    const backend = this.check(agent);
    const mods = (Array.isArray(modifiers) ? modifiers : []).map(String);
    await this.exec(keyCommand(backend, key, mods));
    return `pressed ${[...mods, key].join("+")}`;
  }
}
