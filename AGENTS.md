# Boto

Local-first cross-platform desktop hub for a team of collaborating general-purpose AI bots
(web, files, email, connected apps). Code and RPC names still say "agent"; the UI says "bot".
Bun workspaces monorepo: a Bun sidecar daemon (`botod`) owns SQLite state and serves a
token-authenticated WebSocket API; a Tauri 2 + React desktop app spawns and talks to it.

Renamed from UpBot (formerly BobAgent): `src/legacy.ts` moves `~/UpBot` or `~/BobAgent`
to `~/Boto` and repoints workspace paths. Rust moves the old app data directory to
`com.boto.desktop`; SQLite checkpoints and renames `upbot.db` to `boto.db`. Vault keys
remain readable under the old platform service names. Remote-host upgrades: see README and
[docs/remote-hosts.md](docs/remote-hosts.md).

This file stays short on purpose. Read a topic file under [docs/agents/](docs/agents/) only
when the task touches that area — do not preload every reference.

## Topic reference

| When working on…                                                       | Read                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Bots, persona, email, connected apps, Pages, group chat / nav          | [docs/agents/product.md](docs/agents/product.md)                   |
| Approvals, audit, notifications, badges, restart leftovers             | [docs/agents/approvals.md](docs/agents/approvals.md)               |
| Chat runtime, queue, config, permission cards                          | [docs/agents/runtime.md](docs/agents/runtime.md)                   |
| Claude / Codex drivers, ACP providers, microVM provider auth           | [docs/agents/providers.md](docs/agents/providers.md)               |
| Bridge, channels, usage/compaction, memories/skills, routines, browser | [docs/agents/collaboration.md](docs/agents/collaboration.md)       |
| Vault, connectors, Computer Use, voice                                 | [docs/agents/secrets-platform.md](docs/agents/secrets-platform.md) |
| Gateways, marketplace, mobile companion, teams/relay                   | [docs/agents/connectivity.md](docs/agents/connectivity.md)         |
| Hosts, Firecracker placement, subagents (implementation)               | [docs/agents/remote.md](docs/agents/remote.md)                     |
| Host setup / guest image (operator guide)                              | [docs/remote-hosts.md](docs/remote-hosts.md)                       |
| CI, release, updater, branding                                         | [docs/agents/shipping.md](docs/agents/shipping.md)                 |
| Rio Negro design system                                                | [DESIGN.md](DESIGN.md)                                             |

## Layout

- `packages/protocol` — `@boto/protocol`: zod 4 schemas + the typed method map
  (`methodMap`) shared by daemon and UI. Single source of truth for the wire contract.
- `packages/daemon` — `@boto/daemon`: `src/main.ts` is the sidecar entry.
  Args: `--data-dir <path>` (required), `--agents-root <path>` (default `~/Boto/agents`).
  The auth token is the first line on stdin (required; never via env, so agent CLIs can't
  read it). Prints `BOTO_READY {"port":N}` on
  stdout when listening on 127.0.0.1; all other logs go to stderr.
  Exits on SIGTERM/SIGINT and on stdin EOF. Migrations live in `src/db/migrations.ts`
  (ordered SQL array, tracked in `schema_migrations`). Agent delete is a soft delete;
  workspace folders are never removed. Settings use `src/db/settings.ts` (zod-validated;
  invalid rows throw `InvalidSettingError`, surfaced over RPC as `internal` naming the key;
  boot-time mobile/team consumers keep the feature off and log; `default_bot_seeded` is a
  presence check). Tests: `test/settings.e2e.test.ts`.
- `apps/desktop` — Tauri 2 + React 19 + Vite. Rust spawns the sidecar via
  `tauri-plugin-shell`, parses the READY line, and exposes `daemon_connection` ->
  `{port, token}`. Frontend WS client: `src/lib/daemon.ts`.
  Design system (Rio Negro): `apps/desktop/src/styles/tokens.json` is the source of truth;
  `bun scripts/build-tokens.ts` writes `tokens.css` (`--boto-*`) and `legacy-bridge.css`.
  Bricolage Grotesque, Inter and JetBrains Mono are packaged in `apps/desktop/src/fonts/` (SIL OFL).
  Icons live in `apps/desktop/src/ui/icons.tsx`. See `docs/design-system.md`.
- `spikes` — `acp-probe.ts` probes agent CLIs for ACP support:
  `bun spikes/acp-probe.ts <name> -- <cmd...>` writes `spikes/out/acp-<name>.json`.
- `scripts/smoke-acp-real.ts` — runs the compiled daemon with a Finder-like PATH
  and drives devin/cursor/grok/opencode through a real prompt + restart + session
  resume: `bun scripts/smoke-acp-real.ts` -> `spikes/out/phase2-real-smoke.json`.

## Verified commands (run from repo root)

- `bun install` — install workspace deps.
- `bun run build:daemon` — compile the daemon for the host OS/architecture into
  `apps/desktop/src-tauri/binaries/` (Tauri externalBin naming);
  `bun scripts/build-daemon.ts --target <rust-triple>` selects a supported cross-build target.
- `bun run dev` — build the sidecar, then `tauri dev` (Vite on :1420).
- `bun run build:app` — build the debug desktop bundle for the host platform (macOS
  app/DMG, Linux AppImage/deb, or Windows NSIS).
- `bun run test` — `bun test packages/daemon packages/host packages/relay apps/desktop/test` (daemon e2e and desktop browser tests).
- Process-spawning tests need explicit timeouts beyond their internal startup/polling
  deadlines: apps and voice e2e use 30s; updater metadata allows Python 30s and the test
  35s for cleanup. Do not rely on Bun's 5s default for these subprocess tests on Windows.
- Computer Use supports macOS, Windows and Linux X11. Built-in read-aloud uses `say` (macOS),
  System.Speech via Windows PowerShell (Windows) or espeak-ng/espeak/Speech Dispatcher (Linux).
  Linux uses Secret Service for the vault key when available, while Windows uses DPAPI.
- `bun run lint` — `biome check .`
- `bun run typecheck` — `tsc -p` for protocol, daemon, relay, host, desktop (sequential).
- `cd apps/desktop/src-tauri && cargo check` — Rust side.

## Conventions

- Dependencies are pinned to exact versions.
- Windows command lookup follows PATHEXT and searches PATH directories in order; environment
  PATH keys are case-insensitive and Windows provider CLI launches use `cross-spawn`.
- On Windows, `mergedPath` skips login shells. On Linux it uses `$SHELL`, falling back to
  `/bin/bash`; macOS falls back to `/bin/zsh`.
- All client→daemon calls validate params with the protocol schemas; unknown methods
  and invalid params return `bad_request`.
- The daemon requires `Authorization: Bearer <token>` on `/health` and `?token=` on
  `/ws`; Origin headers outside the Tauri/localhost allowlist get 403.
