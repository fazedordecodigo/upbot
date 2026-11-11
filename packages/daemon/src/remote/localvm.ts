// The local Linux VM ("VM Linux local"): a complete Lima instance (vz / Apple
// Virtualization) the daemon manages so bots can run inside a full VM on this Mac.
// The instance registers as a hosts row (kind "localvm"); bots placed on it launch
// through the usual ssh + `boto-host run` path (isolation "none" — the VM itself is
// the isolation boundary) and stream the Xvfb desktop via `boto-host guest-desktop`.
// Overrides for tests: BOTO_LIMA_COMMAND (JSON array), BOTO_LIMA_INSTANCE.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalVmStatus, RemoteHost } from "@boto/protocol";
import vmRecipe from "../../../../vm/boto-computer.yaml" with { type: "text" };
import { spawnEnv } from "../env/login-path";
import { spawnChild } from "../env/spawn";
import { envOverride } from "../env/vars";
import type { HostStore } from "./hosts";
import { sshExec } from "./hosts";

// BOTO_VM_READY_FILE overrides the guest's provisioned marker for tests (the probe runs `test -f`
// on the host side, where a fake ssh resolves it against a fake home).
const PROVISION_MARKER = process.env.BOTO_VM_READY_FILE || "/var/lib/boto-computer-provisioned";
const READY_TIMEOUT_MS = 15 * 60_000;
const READY_POLL_MS = 3_000;

type Send = (event: string, data: unknown) => void;

type LimaInstance = {
  name: string;
  status?: string;
  sshLocalPort?: number;
  IdentityFile?: string;
  config?: { user?: { name?: string } };
};

async function limaExec(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = envOverride("BOTO_LIMA_COMMAND") ?? ["limactl"];
  const [bin, ...pre] = base as [string, ...string[]];
  const proc = spawnChild(bin, [...pre, ...args], {
    cwd: homedir(),
    env: spawnEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stdout?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stdout) resolve("");
  });
  const stderrPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stderr) resolve("");
  });
  const codePromise = new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, codePromise]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class LocalVmService {
  /** Fired whenever the synced hosts row changes so the RPC layer can rebroadcast. */
  onHostChanged: (() => void) | null = null;
  private busy: string | null = null;
  private detail: string | null = null;
  private prepared = false;

  constructor(
    private hosts: HostStore,
    private dataDir: string,
    private send: Send,
    private log: (msg: string, fields?: Record<string, unknown>) => void = () => {},
  ) {}

  get instance(): string {
    const name = process.env.BOTO_LIMA_INSTANCE?.trim();
    return name && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name) ? name : "boto-computer";
  }

  // ---- introspection ----

  private async inspect(): Promise<LimaInstance | null> {
    const r = await limaExec(["list", "--json"], 15_000);
    if (r.code !== 0) throw new Error(`limactl list failed: ${limactlError(r)}`);
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const inst = JSON.parse(line) as LimaInstance;
        if (inst.name === this.instance) return inst;
      } catch {}
    }
    return null;
  }

  private async limaAvailable(): Promise<boolean> {
    try {
      const r = await limaExec(["--version"], 10_000);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  private installed(): boolean {
    const h = this.hosts.localVmHost();
    return !!h?.root && !!h.preflight;
  }

  /** VM done provisioning (marker written by vm/boto-computer.yaml). Cached in `prepared`. */
  private async provisioned(host: RemoteHost): Promise<boolean> {
    if (this.prepared) return true;
    try {
      const r = await sshExec(host, `test -f ${PROVISION_MARKER} || exit 3`, undefined, 8_000);
      if (r.code === 0) this.prepared = true;
    } catch {}
    return this.prepared;
  }

  async status(): Promise<LocalVmStatus> {
    const host = this.hosts.localVmHost();
    const base: LocalVmStatus = {
      available: false,
      name: this.instance,
      state: "absent",
      busy: this.busy,
      hostId: host?.id ?? null,
      installed: this.installed(),
      detail: this.detail,
    };
    if (!(await this.limaAvailable())) {
      return { ...base, detail: this.detail ?? "Lima não está instalada (brew install lima)" };
    }
    base.available = true;
    let inst: LimaInstance | null = null;
    try {
      inst = await this.inspect();
    } catch (e) {
      return { ...base, detail: e instanceof Error ? e.message : String(e) };
    }
    if (!inst) return base;
    base.state =
      inst.status === "Running" ? "running" : inst.status === "Stopped" ? "stopped" : "broken";
    if (base.state === "running" && host && !base.installed && !(await this.provisioned(host))) {
      base.detail = this.detail ?? "Preparando a VM…";
    }
    return base;
  }

  // ---- host row ----

  private async syncHost(inst?: LimaInstance | null): Promise<RemoteHost | null> {
    const i = inst === undefined ? await this.inspect() : inst;
    if (!i) return this.hosts.localVmHost();
    const user = i.config?.user?.name;
    if (!user || !i.sshLocalPort) return this.hosts.localVmHost();
    const h = this.hosts.upsertLocalVm({
      instance: this.instance,
      name: "VM local",
      target: `${user}@127.0.0.1`,
      port: i.sshLocalPort,
      identityFile: i.IdentityFile ?? null,
    });
    this.onHostChanged?.();
    return h;
  }

  // ---- operations ----

  private async run<T>(busy: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error(`a VM já está ocupada (${this.busy})`);
    this.busy = busy;
    this.detail = null;
    this.emit();
    try {
      return await fn();
    } catch (e) {
      this.detail = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  private emit() {
    queueMicrotask(() => {
      void this.status()
        .then((s) => this.send("localvm.changed", s))
        .catch(() => {});
    });
  }

  private materialize() {
    const workspace = join(homedir(), "Boto", "computer", "workspace");
    const shared = join(homedir(), "Boto", "computer", "shared");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(shared, { recursive: true });
    const password = join(shared, "vnc-password");
    if (!existsSync(password)) {
      writeFileSync(password, `${randomBytes(9).toString("base64url")}\n`, { mode: 0o600 });
    }
    const dir = join(this.dataDir, "vm");
    mkdirSync(dir, { recursive: true });
    const yaml = join(dir, `${this.instance}.yaml`);
    writeFileSync(yaml, vmRecipe as string);
    return yaml;
  }

  private async createInner(): Promise<void> {
    const yaml = this.materialize();
    const r = await limaExec(["create", "--name", this.instance, "--tty=false", yaml], 20 * 60_000);
    if (r.code !== 0) throw new Error(`limactl create falhou: ${limactlError(r)}`);
  }

  async create(): Promise<LocalVmStatus> {
    return this.run("Criando a VM…", async () => {
      if (!(await this.limaAvailable())) throw new Error("Lima não está instalada");
      if (await this.inspect()) throw new Error("a VM já existe");
      await this.createInner();
      await this.syncHost();
      return this.status();
    });
  }

  async start(): Promise<LocalVmStatus> {
    const host = await this.run("Ligando a VM…", async () => {
      if (!(await this.limaAvailable())) throw new Error("Lima não está instalada");
      if (!(await this.inspect())) await this.createInner();
      const r = await limaExec(["start", this.instance], 15 * 60_000);
      if (r.code !== 0) throw new Error(`limactl start falhou: ${limactlError(r)}`);
      return this.syncHost();
    });
    // Keep preparing in the background: provisioning finishes, then the helper installs.
    void this.prepare(host).catch((e) =>
      this.log("localvm prepare failed", { error: e instanceof Error ? e.message : String(e) }),
    );
    return this.status();
  }

  /** Waits for provisioning, then installs/refreshes the boto-host helper. */
  private async prepare(host: RemoteHost | null): Promise<void> {
    if (!host || this.installed()) return;
    this.busy = "Preparando a VM…";
    this.emit();
    try {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!(await this.provisioned(host))) {
        if (Date.now() > deadline) throw new Error("a VM não terminou de se preparar");
        await Bun.sleep(READY_POLL_MS);
      }
      await this.hosts.install(host.id);
      this.onHostChanged?.();
    } catch (e) {
      this.detail = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  async install(): Promise<LocalVmStatus> {
    return this.run("Instalando o helper…", async () => {
      const inst = await this.inspect();
      if (!inst) throw new Error("a VM ainda não existe");
      if (inst.status !== "Running") throw new Error("a VM está desligada");
      const host = await this.syncHost(inst);
      if (!host) throw new Error("não foi possível localizar o acesso SSH da VM");
      await this.hosts.install(host.id);
      this.onHostChanged?.();
      return this.status();
    });
  }

  async stop(): Promise<LocalVmStatus> {
    return this.run("Desligando a VM…", async () => {
      const r = await limaExec(["stop", this.instance], 5 * 60_000);
      if (r.code !== 0) throw new Error(`limactl stop falhou: ${limactlError(r)}`);
      await this.syncHost();
      return this.status();
    });
  }

  async remove(): Promise<LocalVmStatus> {
    return this.run("Apagando a VM…", async () => {
      const inst = await this.inspect();
      if (inst) {
        if (inst.status === "Running") await limaExec(["stop", this.instance], 5 * 60_000);
        const r = await limaExec(["delete", this.instance], 5 * 60_000);
        if (r.code !== 0) throw new Error(`limactl delete falhou: ${limactlError(r)}`);
      }
      const host = this.hosts.localVmHost();
      if (host) {
        this.hosts.delete(host.id);
        this.onHostChanged?.();
      }
      this.prepared = false;
      return this.status();
    });
  }

  /** Boot-time sync: refresh the host row when the instance already exists. */
  async sync(): Promise<void> {
    try {
      if (!(await this.limaAvailable())) return;
      await this.syncHost();
    } catch (e) {
      this.log("localvm sync failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function limactlError(r: { code: number; stderr: string; stdout: string }): string {
  const msg = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n");
  return msg || `limactl exited with code ${r.code}`;
}
