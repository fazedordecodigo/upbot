import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { VaultEntry } from "@boto/protocol";
import { resolveCommand } from "./env/login-path";

// Encrypted secret store (AES-256-GCM). The key uses the macOS Keychain, Windows DPAPI,
// or Linux Secret Service where available, with a warned plaintext-file fallback.
// BOTO_VAULT_KEY (64 hex chars) overrides it for tests. Each secret has an agent
// allowlist; agents read allowed secrets with the vault_get bridge tool.

export const VAULT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// Name prefixes reserved for daemon-internal secrets: hidden from `list` and never shared
// with agents. A service storing an internal secret builds the name from one of these, so
// declaring the prefix here is what keeps it hidden.
export const GATEWAY_PREFIX = "gateway.";
export const TEAM_PREFIX = "team.";
export const VMCRED_PREFIX = "vmcred.";
export const EMAIL_PREFIX = "email.";
export const APP_PREFIX = "app.";
export const INTERNAL_PREFIXES = [
  GATEWAY_PREFIX,
  TEAM_PREFIX,
  VMCRED_PREFIX,
  EMAIL_PREFIX,
  APP_PREFIX,
] as const;

type Row = { name: string; iv: string; data: string; agent_ids: string; updated_at: number };

function keychainKey(): Buffer | null {
  if (process.platform !== "darwin") return null;
  const find = (service: string) => {
    const r = Bun.spawnSync(
      ["security", "find-generic-password", "-s", service, "-a", "vault-key", "-w"],
      { stderr: "ignore" },
    );
    const v = r.stdout.toString().trim();
    return r.exitCode === 0 && /^[0-9a-f]{64}$/.test(v) ? v : null;
  };
  const existing = find("Boto");
  if (existing) return Buffer.from(existing, "hex");
  // vaults created before the rename keep their key under the old service name
  const hex = find("UpBot") ?? find("BobAgent") ?? randomBytes(32).toString("hex");
  const add = Bun.spawnSync(
    ["security", "add-generic-password", "-s", "Boto", "-a", "vault-key", "-U", "-w", hex],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (add.exitCode !== 0) {
    console.error(`[botod] keychain add failed (exit ${add.exitCode})`);
    return null;
  }
  return Buffer.from(hex, "hex");
}

function keyFromHex(value: string): Buffer | null {
  return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

function runSecretTool(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: process.platform === "win32",
    maxBuffer: 1024 * 1024,
  });
}

function secretServiceKey(dataDir: string): Buffer | null {
  const tool = resolveCommand("secret-tool");
  const marker = join(dataDir, "vault.key.location");
  if (!tool) {
    if (existsSync(marker)) {
      throw new Error(
        "The Boto vault key is stored in Secret Service, but secret-tool is unavailable.",
      );
    }
    return null;
  }

  let lookupUnavailable = false;
  const lookup = (service = "Boto") => {
    const result = runSecretTool(tool, ["lookup", "service", service, "account", "vault-key"]);
    lookupUnavailable ||= !!(result.error || result.signal);
    return result.status === 0 ? keyFromHex(result.stdout.trim()) : null;
  };
  const existing = lookup();
  if (existing) {
    writeFileSync(marker, "secret-service\n", { mode: 0o600 });
    return existing;
  }
  const legacy = lookupUnavailable ? null : lookup("UpBot");
  if (legacy) {
    writeFileSync(marker, "secret-service\n", { mode: 0o600 });
    return legacy;
  }
  if (existsSync(marker)) {
    throw new Error(
      "The Boto vault key could not be read from Secret Service. Unlock or restore the keyring before starting Boto.",
    );
  }
  if (lookupUnavailable) return null;

  const hex = randomBytes(32).toString("hex");
  const stored = runSecretTool(
    tool,
    ["store", "--label=Boto vault key", "service", "Boto", "account", "vault-key"],
    `${hex}\n`,
  );
  if (stored.status !== 0) return null;
  if (lookup()?.toString("hex") !== hex) return null;
  writeFileSync(marker, "secret-service\n", { mode: 0o600 });
  return Buffer.from(hex, "hex");
}

// `Add-Type -AssemblyName` took 25-36 s per cold call on Windows ARM64, while process start,
// Import-Module Microsoft.PowerShell.Utility and a reflection assembly load each took under
// a second. The DPAPI scripts therefore use .NET calls only, with autoloading turned off.
const DPAPI_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')",
];
const DPAPI_SCOPE = "[Security.Cryptography.DataProtectionScope]::CurrentUser";
const PROTECT_SCRIPT = [
  ...DPAPI_PRELUDE,
  "$hex = [Console]::In.ReadToEnd().Trim()",
  "$bytes = [byte[]]::new([int]($hex.Length / 2))",
  "for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }",
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, ${DPAPI_SCOPE}))`,
].join("; ");
const UNPROTECT_SCRIPT = [
  ...DPAPI_PRELUDE,
  "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  `$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, ${DPAPI_SCOPE})`,
  "[BitConverter]::ToString($plain).Replace('-', '').ToLowerInvariant()",
].join("; ");

/** Per-attempt timeouts; a timed-out attempt is retried with the next, longer timeout. */
export const DPAPI_TIMEOUTS_MS = [30_000, 90_000] as const;

type DpapiResult = { ok: true; stdout: string } | { ok: false; timedOut: boolean; reason: string };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown error";
}

// Errors carry only a code, exit status or "timed out", never PowerShell stderr.
function runDpapi(script: string, input: string, timeoutsMs: readonly number[]): DpapiResult {
  let reason = "timed out";
  for (const [attempt, timeout] of timeoutsMs.entries()) {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        input,
        encoding: "utf8",
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      (!result.error && result.status === null);
    if (!timedOut) {
      if (result.error) return { ok: false, timedOut: false, reason: errorCode(result.error) };
      if (result.status !== 0)
        return { ok: false, timedOut: false, reason: `exit ${result.status}` };
      return { ok: true, stdout: result.stdout.trim() };
    }
    reason = `timed out after ${timeout / 1000}s`;
    if (attempt < timeoutsMs.length - 1) {
      console.error(`[botod] Windows DPAPI ${reason}; retrying`);
    }
  }
  return { ok: false, timedOut: true, reason };
}

export function loadVaultKey(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  timeoutsMs: readonly number[] = DPAPI_TIMEOUTS_MS,
): Buffer {
  const env = process.env.BOTO_VAULT_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, "hex");

  if (platform === "darwin") {
    const key = keychainKey();
    if (key) return key;
  }

  const file = join(dataDir, "vault.key");
  if (existsSync(file)) {
    const key = keyFromHex(readFileSync(file, "utf8").trim());
    if (!key) throw new Error("The Boto vault key file is invalid.");
    return key;
  }

  mkdirSync(dataDir, { recursive: true });
  if (platform === "win32") {
    const protectedFile = join(dataDir, "vault.key.dpapi");
    const tempFile = `${protectedFile}.tmp`;
    if (existsSync(protectedFile)) {
      const result = runDpapi(
        UNPROTECT_SCRIPT,
        readFileSync(protectedFile, "utf8").trim(),
        timeoutsMs,
      );
      const key = result.ok ? keyFromHex(result.stdout) : null;
      if (key) return key;
      throw new Error(
        `The Boto vault key could not be decrypted with Windows DPAPI (${result.ok ? "invalid key" : result.reason}).`,
      );
    }
    const key = randomBytes(32);
    const result = runDpapi(PROTECT_SCRIPT, key.toString("hex"), timeoutsMs);
    // A slow DPAPI is not an unavailable one: never trade it for a plaintext key.
    if (!result.ok && result.timedOut) {
      throw new Error(
        `Windows DPAPI ${result.reason}; the Boto vault key was not created. Try again.`,
      );
    }
    let reason = result.ok ? "empty output" : result.reason;
    if (result.ok && result.stdout) {
      try {
        writeFileSync(tempFile, result.stdout, { mode: 0o600 });
        renameSync(tempFile, protectedFile);
        return key;
      } catch (error) {
        reason = errorCode(error);
        try {
          unlinkSync(tempFile);
        } catch {}
      }
    }
    console.error(
      `Boto could not use Windows DPAPI (${reason}); storing the vault key in a plaintext file.`,
    );
    writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    return key;
  }

  if (platform === "linux") {
    const key = secretServiceKey(dataDir);
    if (key) return key;
  }

  console.error(
    "Boto could not use the platform secure store; storing the vault key in a plaintext file.",
  );
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

export class Vault {
  private cachedKey: Buffer | null = null;

  constructor(
    private db: Database,
    private dataDir: string,
  ) {}

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = loadVaultKey(this.dataDir);
    return this.cachedKey;
  }

  private row(name: string): Row | null {
    return this.db.query("SELECT * FROM vault WHERE name = ?").get(name) as Row | null;
  }

  /** Entry (name, allowlist, timestamp) for one secret, or null when absent. */
  get(name: string): VaultEntry | null {
    const r = this.row(name);
    if (!r) return null;
    return { name: r.name, agentIds: JSON.parse(r.agent_ids) as string[], updatedAt: r.updated_at };
  }

  list(): VaultEntry[] {
    const hidden = INTERNAL_PREFIXES.map(() => "name NOT LIKE ?").join(" AND ");
    const rows = this.db
      .query(`SELECT * FROM vault WHERE ${hidden} ORDER BY name ASC`)
      .all(...INTERNAL_PREFIXES.map((p) => `${p}%`)) as Row[];
    return rows.map((r) => ({
      name: r.name,
      agentIds: JSON.parse(r.agent_ids) as string[],
      updatedAt: r.updated_at,
    }));
  }

  set(name: string, value: string, agentIds: string[]): void {
    if (!VAULT_NAME.test(name))
      throw new Error("secret names use letters, digits, '.', '_' or '-'");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]).toString(
      "base64",
    );
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO vault (name, iv, data, agent_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, data = excluded.data, agent_ids = excluded.agent_ids, updated_at = excluded.updated_at`,
      )
      .run(name, iv.toString("hex"), data, JSON.stringify([...new Set(agentIds)]), now, now);
  }

  setAccess(name: string, agentIds: string[]): boolean {
    return (
      this.db
        .query("UPDATE vault SET agent_ids = ?, updated_at = ? WHERE name = ?")
        .run(JSON.stringify([...new Set(agentIds)]), Date.now(), name).changes > 0
    );
  }

  delete(name: string): boolean {
    return this.db.query("DELETE FROM vault WHERE name = ?").run(name).changes > 0;
  }

  allowed(agentId: string): string[] {
    return this.list()
      .filter((e) => e.agentIds.includes(agentId))
      .map((e) => e.name);
  }

  /** Daemon-internal secrets under `prefix` (names and timestamps only). */
  internalEntries(prefix: string): { name: string; updatedAt: number }[] {
    return (
      this.db
        .query("SELECT name, updated_at FROM vault WHERE substr(name, 1, ?) = ? ORDER BY name")
        .all(prefix.length, prefix) as { name: string; updated_at: number }[]
    ).map((r) => ({ name: r.name, updatedAt: r.updated_at }));
  }

  /** Decrypted value for daemon-internal use (gateway tokens); throws when missing. */
  revealInternal(name: string): string {
    const r = this.row(name);
    if (!r) throw new Error(`vault secret "${name}" is missing`);
    return this.decrypt(r);
  }

  private decrypt(r: Row): string {
    const buf = Buffer.from(r.data, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(r.iv, "hex"));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
  }

  /** Decrypted value if `agentId` is on the secret's allowlist, else throws. */
  reveal(name: string, agentId: string): string {
    const r = this.row(name);
    if (!r || !(JSON.parse(r.agent_ids) as string[]).includes(agentId)) {
      throw new Error(
        `no vault secret "${name}" is shared with you (ask the user to grant access)`,
      );
    }
    return this.decrypt(r);
  }
}
