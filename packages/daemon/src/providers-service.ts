import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DefaultProvider,
  OpenAiCompatibleEndpoint,
  type ProviderId,
  type ProviderInfo,
  type ProviderKeyInfo,
  VmCredentialProvider,
} from "@boto/protocol";
import { deleteSetting, getSetting, setSetting } from "./db/settings";
import { resolveCommand, spawnEnv } from "./env/login-path";
import { spawnChild, waitForChildSpawn } from "./env/spawn";
import { envOverride, envPositiveNumber } from "./env/vars";
import { commandFor, LOGIN_COMMANDS } from "./providers/process";
import { loginTerminalCommand } from "./providers/terminal";
import type { VmCredentials } from "./remote/credentials";
import type { Broadcast } from "./rpc";
import { RpcError } from "./runtime/agent-runtime";

const CATALOG = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  codex: { name: "Codex CLI", vendor: "OpenAI", installHint: "npm install -g @openai/codex" },
  gemini: {
    name: "Gemini CLI",
    vendor: "Google",
    installHint: "npm install -g @google/gemini-cli",
  },
  cursor: {
    name: "Cursor CLI",
    vendor: "Cursor",
    installHint: "curl -fsS https://cursor.com/install | bash",
  },
  opencode: {
    name: "OpenCode",
    vendor: "Código aberto",
    installHint: "npm install -g opencode-ai",
  },
  aider: { name: "Aider", vendor: "Código aberto", installHint: "pipx install aider-chat" },
  devin: {
    name: "Devin",
    vendor: "Cognition",
    installHint: "https://docs.devin.ai/work-with-devin/devin-cli",
  },
  grok: {
    name: "Grok",
    vendor: "xAI",
    installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
} as const;

const ENDPOINT_SETTING = "openai_compatible_endpoint";
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;

const DEVIN_API_KEY_RE = /windsurf_api_key\s*=\s*["']([^"'\n]+)["']/;
const DEFAULT_DEVIN_LOGIN_WATCH_MS = 600_000;
const DEFAULT_DEVIN_LOGIN_POLL_MS = 2_000;

function devinCredentialPaths(): string[] {
  const override = process.env.BOTO_DEVIN_CREDENTIALS_PATH?.trim();
  if (override) return [override];
  const home = process.env.HOME || homedir();
  const paths = [join(home, ".local", "share", "devin", "credentials.toml")];
  if (process.platform === "win32") {
    paths.unshift(
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "devin", "credentials.toml"),
    );
  }
  return paths;
}

/** The API key `devin auth login` persists, or null when the CLI is signed out. */
function readDevinApiKey(): string | null {
  for (const path of devinCredentialPaths()) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const key = text.match(DEVIN_API_KEY_RE)?.[1]?.trim();
    if (key) return key;
  }
  return null;
}

export class ProvidersService {
  private detected: Promise<ProviderInfo[]> | undefined;
  private running = new Set<ProviderId>();
  private installing = new Set<ProviderId>();
  private installErrors = new Map<ProviderId, string>();
  private devinWatch: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private credentials: VmCredentials,
    private broadcast: Broadcast,
  ) {}

  private async version(bin: string): Promise<string | null> {
    return new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      try {
        const child = spawnChild(bin, ["--version"], {
          env: spawnEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 3000);
        child.stdout?.on("data", (chunk) => {
          if (output.length < 4096) output += String(chunk).slice(0, 4096 - output.length);
        });
        child.once("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(
            !timedOut && code === 0
              ? (output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0] ?? null)
              : null,
          );
        });
      } catch {
        resolve(null);
      }
    });
  }

  private async detect(): Promise<ProviderInfo[]> {
    return Promise.all(
      Object.entries(CATALOG).map(async ([id, { name, vendor, installHint }]) => {
        const provider = id as ProviderId;
        const command = commandFor(provider);
        const path = command?.[0] ? resolveCommand(command[0]) : null;
        const key = id.toUpperCase();
        const overridden =
          envOverride(`BOTO_PROVIDER_COMMAND_${key}`) ?? envOverride(`BOTO_ACP_COMMAND_${key}`);
        const loginOverride = this.loginOverride(provider);
        return {
          id: provider,
          name,
          vendor,
          installed: path !== null,
          path,
          installHint,
          installRunning: false,
          installError: null,
          version: path && !overridden ? await this.version(path) : null,
          loggedIn: null,
          canLogin: loginOverride !== null || (path !== null && !!LOGIN_COMMANDS[provider]),
          hasApiKey: false,
          apiKeyMasked: null,
          loginRunning: false,
          ready: false,
        };
      }),
    );
  }

  async list(): Promise<ProviderInfo[]> {
    this.detected ??= this.detect();
    const stored = this.credentials.list();
    return (await this.detected).map((info) => {
      const provider = VmCredentialProvider.safeParse(info.id);
      const apiKeyMasked = provider.success ? this.credentials.maskedApiKey(provider.data) : null;
      const oauth = stored.some((c) => c.provider === info.id && c.kind === "oauth_token");
      const credentialFile =
        info.id === "codex"
          ? [".codex", "auth.json"]
          : info.id === "gemini"
            ? [".gemini", "oauth_creds.json"]
            : null;
      const loggedIn = oauth
        ? true
        : info.id === "devin"
          ? apiKeyMasked !== null || readDevinApiKey() !== null
          : credentialFile
            ? existsSync(join(process.env.HOME || homedir(), ...credentialFile))
            : null;
      return {
        ...info,
        loggedIn,
        apiKeyMasked,
        hasApiKey: apiKeyMasked !== null,
        loginRunning: this.running.has(info.id),
        installRunning: this.installing.has(info.id),
        installError: this.installErrors.get(info.id) ?? null,
        ready: info.installed && (loggedIn !== false || apiKeyMasked !== null),
      };
    });
  }

  async scan(): Promise<ProviderInfo[]> {
    this.detected = this.detect();
    const result = await this.list();
    this.broadcast("providers.changed", {});
    return result;
  }

  private loginOverride(provider: ProviderId): string[] | null {
    return envOverride(`BOTO_PROVIDER_LOGIN_COMMAND_${provider.toUpperCase().replace(/-/g, "_")}`);
  }

  private async info(provider: ProviderId): Promise<ProviderInfo> {
    const info = (await this.list()).find((p) => p.id === provider);
    if (!info) throw new RpcError("bad_request", "unsupported provider");
    return info;
  }

  async login(provider: ProviderId): Promise<ProviderInfo> {
    const info = await this.info(provider);
    if (this.running.has(provider)) return info;
    const override = this.loginOverride(provider);
    const command = override ?? LOGIN_COMMANDS[provider]?.split(" ");
    if (!command?.[0] || (!info.installed && !override))
      throw new RpcError("bad_request", "provider login unavailable");
    this.running.add(provider);
    try {
      const override = envOverride("BOTO_PROVIDER_TERMINAL_COMMAND");
      const terminal = override ? [...override, ...command] : loginTerminalCommand(command);
      const child = spawnChild(terminal[0]!, terminal.slice(1), {
        env: spawnEnv(),
        stdio: "ignore",
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.running.delete(provider);
        void this.scan().catch(() => {});
      };
      child.once("error", finish);
      child.once("close", finish);
      await waitForChildSpawn(child);
      child.unref();
    } catch {
      this.running.delete(provider);
      throw new RpcError("bad_request", "provider login unavailable");
    }
    if (provider === "devin") this.armDevinCredentialHarvest();
    this.broadcast("providers.changed", {});
    return this.info(provider);
  }

  /** Runs the catalog install command in the background (no terminal window) and
   * rescans when it exits. URL-only hints (docs links) cannot be installed. */
  async install(provider: ProviderId): Promise<ProviderInfo> {
    const info = await this.info(provider);
    if (info.installed || this.installing.has(provider)) return info;
    const hint = info.installHint.trim();
    if (!hint || /^https?:\/\//i.test(hint))
      throw new RpcError("bad_request", "provider install unavailable");
    const override = envOverride(
      `BOTO_PROVIDER_INSTALL_COMMAND_${provider.toUpperCase().replace(/-/g, "_")}`,
    );
    const command =
      override ??
      (process.platform === "win32"
        ? ["powershell.exe", "-NoProfile", "-Command", hint]
        : ["sh", "-c", hint]);
    const [bin, ...args] = command;
    if (!bin) throw new RpcError("bad_request", "provider install unavailable");
    this.installing.add(provider);
    this.installErrors.delete(provider);
    try {
      const child = spawnChild(bin, args, {
        env: spawnEnv(),
        stdio: "ignore",
      });
      const timer = setTimeout(
        () => {
          this.installErrors.set(provider, "install timed out");
          child.kill("SIGKILL");
        },
        envPositiveNumber("BOTO_PROVIDER_INSTALL_MS", DEFAULT_INSTALL_TIMEOUT_MS),
      );
      timer.unref();
      let finished = false;
      const finish = (error: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.installing.delete(provider);
        if (error) this.installErrors.set(provider, error);
        void this.scan().catch(() => {});
      };
      child.once("error", (e) => finish(`install failed to start: ${e.message}`));
      child.once("close", (code) =>
        finish(code === 0 ? null : `install exited with code ${code ?? "unknown"}`),
      );
      await waitForChildSpawn(child);
      child.unref();
    } catch {
      this.installing.delete(provider);
      throw new RpcError("bad_request", "provider install unavailable");
    }
    this.broadcast("providers.changed", {});
    return this.info(provider);
  }

  private endpoint(): string {
    return getSetting(this.db, ENDPOINT_SETTING, OpenAiCompatibleEndpoint, "");
  }

  private keyInfo(provider: VmCredentialProvider): ProviderKeyInfo {
    const apiKeyMasked = this.credentials.maskedApiKey(provider);
    return {
      provider,
      hasApiKey: apiKeyMasked !== null,
      apiKeyMasked,
      endpoint: provider === "openai-compatible" ? this.endpoint() : null,
    };
  }

  listApiKeys(): ProviderKeyInfo[] {
    return VmCredentialProvider.options.map((provider) => this.keyInfo(provider));
  }

  /** Saves the OpenAI-compatible base URL and, when given, its API key. Local
   * servers often take no key, and an omitted key keeps the stored one. */
  async setEndpoint(url: string, apiKey?: string): Promise<ProviderKeyInfo> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RpcError("bad_request", "invalid endpoint url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new RpcError("bad_request", "invalid endpoint url");
    if (apiKey !== undefined) this.credentials.set("openai-compatible", "api_key", apiKey);
    setSetting(this.db, ENDPOINT_SETTING, parsed.toString());
    this.broadcast("providers.changed", {});
    return this.keyInfo("openai-compatible");
  }

  /** `devin acp` ignores the CLI's own credential store, so a terminal sign-in alone
   * reaches no session. After a Devin login, watch credentials.toml and mirror its
   * API key into the vault: the stored `vmcred.devin` key is handed to every `devin
   * acp` process via ACP `authenticate`, on this machine and remote hosts alike. */
  private armDevinCredentialHarvest(): void {
    this.disarmDevinCredentialHarvest();
    const deadline =
      Date.now() + envPositiveNumber("BOTO_DEVIN_LOGIN_WATCH_MS", DEFAULT_DEVIN_LOGIN_WATCH_MS);
    if (this.harvestDevinCredential()) return;
    this.devinWatch = setInterval(
      () => {
        if (this.harvestDevinCredential() || Date.now() > deadline)
          this.disarmDevinCredentialHarvest();
      },
      envPositiveNumber("BOTO_DEVIN_LOGIN_POLL_MS", DEFAULT_DEVIN_LOGIN_POLL_MS),
    );
    this.devinWatch.unref();
  }

  private disarmDevinCredentialHarvest(): void {
    if (this.devinWatch) clearInterval(this.devinWatch);
    this.devinWatch = null;
  }

  /** Copies a freshly stored Devin credential into the vault; true when stored. */
  private harvestDevinCredential(): boolean {
    const key = readDevinApiKey();
    if (key === null || this.credentials.apiKey("devin") === key) return false;
    this.credentials.set("devin", "api_key", key);
    this.broadcast("providers.changed", {});
    return true;
  }

  async setApiKey(
    provider: VmCredentialProvider,
    value?: string,
  ): Promise<ProviderInfo | ProviderKeyInfo> {
    if (provider === "devin") this.disarmDevinCredentialHarvest();
    if (value !== undefined) this.credentials.set(provider, "api_key", value);
    else if (this.credentials.list().some((c) => c.provider === provider && c.kind === "api_key"))
      this.credentials.delete(provider);
    if (provider === "openai-compatible" && value === undefined)
      deleteSetting(this.db, ENDPOINT_SETTING);
    this.broadcast("providers.changed", {});
    const info = (await this.list()).find((p) => p.id === provider);
    return info ?? this.keyInfo(provider);
  }

  getDefault(): { provider: ProviderId | null } {
    return { provider: getSetting(this.db, "default_provider", DefaultProvider, null) };
  }

  async setDefault(provider: ProviderId): Promise<{ provider: ProviderId }> {
    if (!(await this.info(provider)).ready)
      throw new RpcError("bad_request", "provider is not ready");
    setSetting(this.db, "default_provider", provider);
    this.broadcast("providers.changed", {});
    return { provider };
  }
}
