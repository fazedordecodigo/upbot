# Chat runtime, queue and permissions

## Chat runtime (Phase 2)

Each agent gets a lazy `AgentRuntime` (`packages/daemon/src/runtime/`) that owns one
provider session at a time. Turns stream ACP updates into `items` rows; permission
requests pause in `awaiting_permission` until `permissions.respond`. Cancel sends
`session/cancel` and hard-kills after `BOTO_CANCEL_GRACE_MS` (default 10000).
On daemon start, turns left `running` are marked `interrupted`. Provider CLIs are
found via a login-shell PATH merge (`src/env/login-path.ts`) — spawned agents get
`NO_COLOR=1` and a resolved absolute binary path.

Daemon auth: the token is delivered on the FIRST STDIN LINE (never env — provider
children must not see it). Missing/empty token or no line within 10 s -> exit 2.
stdin EOF afterwards = shutdown. `spawnEnv` strips all `BOTO_*` vars.

Env vars (daemon):
- `BOTO_ACP_COMMAND_<PROVIDER>` — JSON array overriding the spawn command per
  provider (e.g. `BOTO_ACP_COMMAND_DEVIN='["bun","path/to/agent.ts"]'`).
- `BOTO_CANCEL_GRACE_MS` — ms after `chat.cancel` before the process is killed
  (`0` kills immediately).

Sign-in commands surfaced on auth errors: `devin auth login`, `agent login`,
`grok login`, `opencode auth login`, `claude auth login`, `codex login` (all verified via --help).
Gemini has no login subcommand: the message says to run `gemini` and pick Sign in with Google,
Use Gemini API Key or Vertex AI (`LOGIN_HINTS`).

Gemini CLI (verified 0.65.0 and 0.67.0 with `spikes/acp-probe.ts`, plus the daemon with the real
binary): Boto runs `gemini --acp`; `--experimental-acp` still works but `--help` marks it
deprecated. `initialize` returns authMethods oauth-personal, gemini-api-key, vertex-ai and gateway.
`session/new` reads `security.auth.selectedType` from settings and falls back to gemini-api-key.
With no method and no `GEMINI_API_KEY`, it fails with -32000 `Gemini API key is missing or not
configured.`, which maps to `auth_required`. Interactive `gemini` shows the auth picker and saves the
choice to `~/.gemini/settings.json`. An API key entered there is stored by the CLI (on a host with
no keychain: `~/.gemini/gemini-credentials.json`), and `--acp` uses it without env. If
oauth-personal is selected without cached creds, the CLI exits 41 before `initialize`. Its stderr
then shows `Failed to authenticate with user code.` (AUTH_RE). `classifyStartupError` quotes only
the stderr line that matched, not the stack. A bad key fails at `session/prompt` with HTTP 400
`API key not valid`.
Gemini exposes legacy ACP `modes` (default, autoEdit, yolo, plan; `currentModeId` default), not
`configOptions`, so `DEFAULT_MODE` does not apply. Its approval level comes from its own settings.

`bun run smoke:ui` — real-Chrome UI smoke (playwright-core, dev-only
`location.hash` connect path in daemon.ts — dead code in prod builds).

Tests drive `packages/daemon/test/fixtures/fake-acp-agent.ts` (an ACP-speaking fake
that logs requests to `$FAKE_ACP_STATE_DIR/log.jsonl` and its pid to `pids.txt`).

## Queue + config (Phase 3)

`chat.send` always enqueues (`queue` table, status queued|started|removed); the runtime
drains oldest-first while idle and unpaused. User `chat.cancel` pauses the queue when
items remain; a `failed` turn auto-pauses. `queue.get/remove/pause/resume` +
`queue.updated` events. `Agent.config` (configId->value) is applied to every new
provider session before its first prompt via `session/set_config_option`;
`DEFAULT_MODE` in `src/providers/index.ts` picks the safe per-provider mode
(devin=accept-edits, cursor=agent, opencode=build — measured by `spikes/mode-probe.ts`;
never a bypass/auto-approve value). `agents.configOptions` starts a session to read
options; `agents.setConfig` validates against live options (busy while a turn runs).
New (non-resumed) sessions with prior history get a `<conversation_history>` block
(`src/runtime/handoff.ts`, pure fn) before the first prompt.

`spikes/mode-probe.ts` — per provider x mode permission probe -> `spikes/out/mode-probe.json`.
- `BOTO_DEBUG_PROMPTS_DIR` — when set, the daemon writes every outgoing prompt to
  `<dir>/<agentId>-<turnId>.txt` (debugging only).

## Permissions

Desktop ChatView loads `permissions.list` and refreshes on permission events and reconnects.
Persisted unresolved permission cards absent from a successfully loaded live list are
non-actionable; a failed list keeps cards actionable rather than inventing a resolution.
Routine history is available in Agendadas and saved routine dialogs. `routines.runs`
joins the queue for nullable `queueStatus` and the latest linked turn for nullable
`turn {id,status,startedAt,endedAt}`. Skill details load `skills.get`, refresh on
`skills.changed`, and offer Markdown or raw SKILL.md text plus `skills.versions` history.

Provider agents ask for approval only when THEIR OWN config says so
(`PROVIDER_PERMISSION_CONFIG` in `packages/protocol` maps provider -> config path).
The UI shows this as a notice; we never change or sandbox those configs.
Note: `spikes/out/mode-probe.json` was measured with the user's permissive global
configs, so it does not reflect stock defaults. Gemini (verified 0.65.0/0.67.0) reads user
`~/.gemini/settings.json` (`$GEMINI_CLI_HOME/.gemini` when set), workspace `.gemini/settings.json`
and a system file such as `/etc/gemini-cli/settings.json`. `general.defaultApprovalMode` defaults
to `default` (prompts) and also accepts auto_edit or plan. Under `--acp`, the session still started
in `default` when the user settings set `auto_edit` or `yolo`. Settings cannot select yolo; only
`--yolo` or `--approval-mode` can.

## Agents cockpit (instances, approval, overview)

`Agent` carries `role` (<=140, "O que ele faz"), `requireApproval` (default true) and
`maxInstances` (null = "a definir"; the scheduler then runs 1). `src/runtime/scheduler.ts`
owns the capacity/pull policy: the primary runtime pulls first, extra ephemeral instances
(no session resume/store, no usage/compaction) start while queued work and capacity remain,
pull the next item when their turn ends and are disposed once idle. `agent.status` is the
aggregate of every instance. With several turns of one agent running, `currentTurn` is
null (bridge calls can't be attributed), so task-scoped grants never apply then.
`requireApproval` registers an `ApprovalService.addAskPolicy` that forces asks for every
non-read app tool and `page_publish`; ask policies only add asks.
`src/agents-overview.ts` serves `agents.overview` and the debounced `agents.overviewChanged`.
Test: `test/agents-cockpit.e2e.test.ts`.
