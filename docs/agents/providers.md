# Providers (native, ACP, microVM)

## Local provider catalog

`providers.list` caches CLI detection; `providers.scan` refreshes it and emits
`providers.changed`. Detection uses the runtime command overrides and merged PATH.
Versions have a three-second deadline and are skipped for overridden commands.
`providers.login` starts the CLI login flow asynchronously with discarded output;
`BOTO_PROVIDER_LOGIN_COMMAND_<PROVIDER>` accepts a JSON command array for tests.
Credential presence is not proof that a token is valid: unknown local login formats
return `loggedIn: null`. Codex checks `~/.codex/auth.json` and Gemini checks
`~/.gemini/oauth_creds.json`; vault OAuth takes precedence.
API keys use the encrypted VM credential store and only masked suffixes reach the catalog.
`providers.setDefault` requires a ready provider and persists `default_provider`;
new bots without an explicit provider use it. With no saved default, creation still
requires a provider, as before.

## Native Claude + Codex (Phase 4)

`src/providers/index.ts` routes providers: `claude` -> `ClaudeDriver` (`claude.ts`),
`codex` -> `CodexDriver` (`codex.ts`), everything else -> ACP (`acp.ts`). Shared spawn,
stderr tail, JSONL and auth helpers live in `process.ts`.

- Claude: `claude --output-format stream-json --input-format stream-json --verbose
--include-partial-messages --permission-prompt-tool stdio --permission-mode default`
  plus `--session-id <uuid>` (new) or `--resume <id>`; a failed resume falls back to a
  new session. Approvals arrive as `can_use_tool` control requests; cancel sends an
  `interrupt` control request. Config: `mode` (default/acceptEdits/plan, never bypass) and
  `model` (from the initialize response), applied via `set_permission_mode`/`set_model`.
- Codex: `codex app-server --listen stdio://` (JSON-RPC lines, no `jsonrpc` field):
  `initialize` -> `initialized` -> `account/read` (signed out -> `auth_required`) ->
  `thread/resume` or `thread/start` -> `model/list`. Turns are `turn/start`, cancel is
  `turn/interrupt`; command/file approvals map to accept/acceptForSession/decline/cancel.
  Config: `mode` (auto = workspace-write, read-only; both `on-request`), `model`, `effort`,
  sent with each `turn/start`.
- Verified against real CLIs (signed out) on the VM: claude 2.1.310, codex-cli 0.164.0.
- `BOTO_PROVIDER_COMMAND_<PROVIDER>` overrides any provider's spawn command
  (`BOTO_ACP_COMMAND_<PROVIDER>` still works). Tests use
  `test/fixtures/fake-claude.ts` / `fake-codex.ts` (`$FAKE_CLAUDE_STATE_DIR`,
  `$FAKE_CODEX_STATE_DIR`, `FAKE_CODEX_NO_AUTH=1`) from `test/native.e2e.test.ts`.

## ACP providers in microVMs

ACP providers run in Firecracker like Claude/Codex (`AcpDriver` spawns via `RemoteLaunch` and
passes `remote.credentials` as env). MicroVM sign-in (`vmCredentials`, Settings → Hosts):
claude (OAuth token or API key), codex (`OPENAI_API_KEY`), gemini (`GEMINI_API_KEY`), cursor
(`CURSOR_API_KEY`), devin (`WINDSURF_API_KEY`), and grok (`XAI_API_KEY`). The seven-provider
image includes the verified Claude Code 2.1.310, Codex 0.164.0, Gemini 0.65.0,
OpenCode 1.19.4, Cursor Agent 2026.10.22-27dcf5f, Devin 3000.12.43 and Grok 1.0.77.
Building all seven providers needs `--size-mib 8192`. Cursor installs
under `/opt/cursor-agent-home` because `/root` is bind-mounted from persistent storage.
Signed-out behavior: Gemini reports `gemini`, OpenCode `opencode auth login`, and Cursor
`agent login`. OpenCode alone has a 30-second first-activity watchdog: message/thought chunks,
tool calls/updates, plans, agent requests, or bridge tool calls for the agent's current turn count
as progress; bridge calls count before approval gating, so waiting for approval cannot trigger
the watchdog. Session metadata updates such as available commands do not count. Without progress
after a prompt, it reports `opencode auth login` and tears down its child; after the first
progress (including a completed or rejected bridge call), the prompt is unbounded.
`BOTO_ACP_FIRST_ACTIVITY_MS` overrides the timeout for tests. Fake Gemini/Cursor credentials reach only
Firecracker provider env. Gemini invalid-key errors are explicit; Cursor's
`Failed to initialize session services` mapping is inferred from `proxy.log` showing a request
to `api2.cursor.sh` with a microVM credential set, since Cursor returns no explicit invalid-key
error. `bun run test:firecracker:providers` checks these real ACP flows, credential delivery,
placement isolation, and plaintext leaks.
The image also supports Devin 3000.12.43 (`/opt/devin-home`, `WINDSURF_API_KEY`) and
Grok 1.0.77 (`/opt/grok-home`, `XAI_API_KEY`), linked as `devin` and `grok` in
`/usr/local/bin`. Pins can be overridden with `DEVIN_CLI_VERSION` / `GROK_CLI_VERSION`.
Grok's installer overwrites `/usr/local/bin/agent`; the build preserves and restores
Cursor's link so only `grok` is exposed there for Grok.
Remote Grok runs `grok --no-auto-update agent stdio`; with a VM key the client sends
`authenticate {methodId:"xai.api_key", _meta:{headless:true}}` after initialize, before
session/new or load, even though initialize advertises only grok.com authentication.
Devin runs `devin acp`. Its ACP server never reads local CLI credentials: the host must
call `authenticate` on every spawned process, so `devin auth login` signs in only the
REPL. With the saved API key (Settings → Providers, `vmcred.devin`, also delivered to
microVMs as `WINDSURF_API_KEY`) Boto sends `authenticate {methodId, _meta:{api_key}}`
after initialize — `methodId` is the advertised browser method (`devin-browser`,
falling back to the first advertised id). With no key, a local `session/new` or
`session/load` failing -32000 triggers `authenticate` on that browser method (PKCE
opens the user's browser and blocks; `BOTO_ACP_BROWSER_AUTH_MS` overrides the
five-minute bound) and retries once. Remote sessions without a key fail straight to
`auth_required` — a VM has no browser. Signed-out sessions report the Settings →
Providers guidance / `grok login`; fake API keys report a rejected VM credential.
Real-provider tests cover delivery, placement isolation and plaintext leaks.
