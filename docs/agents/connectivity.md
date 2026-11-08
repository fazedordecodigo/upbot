# Gateways, marketplace, mobile, teams

## Messaging gateways (Phase 12a)

`src/gateways/` connects Telegram (Bot API long polling), Slack (Socket Mode: `auth.test`,
`apps.connections.open`, envelope acks, `chat.postMessage` in thread) and Discord (Gateway v10:
Hello/Identify/heartbeat/READY/MESSAGE_CREATE, intents incl. MESSAGE_CONTENT; REST replies)
to an agent. Migration 11 `gateways`; tokens in the vault as `gateway.<id>.<field>` (hidden
from `vault.list`, never shared with agents). Only `allowedUsers` reach the agent (others get
their id back); `@AgentName text` routes to another agent; in Slack/Discord channels only
mentions count, DMs always. Prompt is wrapped in `<external_message>`; the queue
`meta_json.gateway` drives the reply on `turn.ended`. RPC `gateways.list/create/update/delete`,
events `gateway.updated/deleted`; UI `GatewaysView`. Daemon shutdown (SIGTERM/SIGINT/stdin EOF)
calls `GatewayService.stopAll()` before closing runtimes. Test base URLs:
`BOTO_TELEGRAM_API`, `BOTO_SLACK_API`, `BOTO_DISCORD_API`.
Stderr logs use `[botod] gateway.<event> <json>` for error/disconnected/connected (recovery
includes `downtimeMs` and `errorAttempts`), send_failed/send_recovered, deliver_failed and unauthorized_user.
Error strings (including `status.error`) redact token values/shapes and URL paths, strip controls and cap at
300 characters; later successful sends clear send-caused errors. Tests: `test/gateways.e2e.test.ts`,
`test/gateways-shutdown.e2e.test.ts`, `test/gateways-telemetry.e2e.test.ts`.

## Marketplace (Phase 12b)

`marketplace/` holds the default registry (`index.json` + `skills/*.md` + `agents/*.json`),
fetched from raw.githubusercontent.com (`BOTO_MARKETPLACE_URL` overrides; user sources in
`settings.marketplace_sources`, http(s)/file URLs). `src/marketplace.ts` verifies each file's
sha256 before installing; skills go to the skills library (author `marketplace:<author>`),
agent templates create an agent (chosen provider) and install their listed skills. RPC
`marketplace.list/install/setSources`; UI `MarketplaceView`. Regenerate the index with
`bun scripts/marketplace-index.ts`. Tests: `test/marketplace.e2e.test.ts`.
Saved UpBot/BobAgent registry URLs migrate to Boto and are deduplicated after conversion,
preserving first-occurrence order. `BOTO_MARKETPLACE_URL` also overrides saved current/legacy
default registry URLs, allowing daemon RPC migration tests to use a local registry without network.
Custom source URLs are unchanged. The default registry is served from `main`; publish
the Boto-branded marketplace there as part of the release, not only on `develop`.

## Mobile companion (Phase 12c)

`src/mobile.ts` + `src/mobile-app.ts` (vanilla JS PWA as a string): opt-in LAN
server (`mobile.enable`, `0.0.0.0`, port remembered in `settings.mobile`;
`BOTO_MOBILE_HOST`/`BOTO_MOBILE_PORT` override). Pairing: `mobile.pair` shows a
6-digit code (5 min, 5 attempts) -> `POST /api/pair` returns a device token (sha256 stored in
`mobile_devices`, migration 12). Devices call `POST /api/rpc` with an allowlist (agents.list/
statuses, chat.history/send/cancel, queue.get, permissions.list/respond; no attachments) and
read chat events from `GET /api/events` (SSE, `?token=`). Foreign Origins get 403.
RPC `mobile.status/enable/pair/revoke`; UI `MobileView`. Tests: `test/mobile.e2e.test.ts`.

## Teams (Phase 12d)

`packages/relay` (`bun run relay -- --data ./relay-data [--port 8787] [--host 0.0.0.0]`) is a
self-hostable Bun relay: admin token (`RELAY_ADMIN_TOKEN` or `<data>/admin-token`) manages
members (`POST/GET /members`, `DELETE /members/:id`, tokens stored hashed in `team.json`);
members connect to `/ws?token=` and exchange `share` / `send` / `incoming` / `reply` frames.
Share entries are validated (string id/name/provider; avatar via protocol `AgentAvatar`, otherwise null).
No chat content is stored on the relay. Daemon side `src/team.ts` (`settings.team`, token in
the vault as `team.token`, hidden from `vault.list`, migration 13 `team_messages`): shares
selected agents, runs incoming messages as `<team_message>` turns and replies on `turn.ended`.
An incoming row is `completed` once the reply is handed to an open relay socket; if the socket
is down it is `failed` and logged (`team reply not delivered`). The relay has no delivery ack
and drops replies to offline members, so a sender's `out` row still `pending` after
`BOTO_TEAM_REPLY_TTL_MS` (default 30 min; checked at start and periodically) becomes `failed`;
a late reply still overwrites it. No relay protocol change, nothing stored on the relay.
RPC `team.status/connect/disconnect/share/send/messages`, events `team.updated/message`;
UI `TeamView`. Tests: `test/team.e2e.test.ts` (spawns the relay). Relay audit logs are JSON
lines on stderr and never include member-supplied identifiers (only relay-known member IDs,
fixed route labels, and socket IP); limits are 20 lines per actor per window across event types,
with periodic `relay.audit_suppressed` summaries (`RELAY_AUDIT_WINDOW_MS`).
