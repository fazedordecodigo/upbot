# Product features

## Bots (general purpose)

`src/persona.ts`: every fresh session starts with `<boto_context>` (shared workspace path,
collaboration tools, approval and secret rules). Fresh installs start with no bots — the
onboarding offers creating the first one, and `AgentStore.create` adopts it as
`settings.default_bot_id` when unset. `migrateDefaultBot` keeps upgrades working: it renames
an untouched "UpBot" seed and backfills `default_bot_id` once for installs marked
`settings.default_bot_seeded`. Shared workspace: `BOTO_WORKSPACE_ROOT` or
`dirname(agentsRoot)/Workspace` (`~/Boto/Workspace`), passed to local sessions as
`StartOpts.extraDirs` (Claude `--add-dir`, Codex `writableRoots`).

## Email

`src/email.ts` (`EmailService`, migration 15 `email_accounts`, `email_drafts`): IMAP via
`imapflow` + `mailparser`, SMTP via `nodemailer`. Presets gmail/icloud/outlook; app password
in the vault as `email.<id>.password` (hidden from `vault.list`, never given to bots).
`agentIds` empty = every bot. Bridge tools `email_accounts`, `email_search`, `email_read`,
`email_draft` (creates a pending draft only), `email_draft_status`. Only the user sends:
RPC `email.drafts.send` (also `email.accounts.list/save/delete/test`, `email.drafts.list/
update/discard`); events `email.accounts.changed`, `email.draft.updated`. UI: Settings →
Email and `DraftCards` above the composer. Tests: `BOTO_EMAIL_FAKE_MAILBOX=<json>` replaces
IMAP, `BOTO_EMAIL_PLAINTEXT=1` allows non-TLS SMTP (`test/email.e2e.test.ts` with smtp-server).

## Connected apps

`src/apps.ts` (`AppsService`, migration 16 `connected_apps`): the daemon itself runs each app's
MCP server via `@modelcontextprotocol/sdk` (stdio with secrets as env, or streamable HTTP with
secret-filled headers). Catalog `APP_CATALOG` (Notion, GitHub remote MCP, Brave Search,
Airtable, Stripe; pinned npx versions) plus `custom-stdio` / `custom-http`. Secrets in the
vault as `app.<id>.<KEY>` (hidden from `vault.list`); tool output has secrets redacted.
The bridge appends app tools to `tools/list` as `<slug>-<tool>` and routes calls to them
(`agentIds` empty = every bot). RPC `apps.catalog/list/connect/update/refresh/delete`, event
`apps.changed`; UI Settings → Apps. Tests: `test/apps.e2e.test.ts` + `fixtures/fake-mcp-server.ts`.
Migration 19 adds `permissions_json`: `read | write | send | pay | book | del` map to
`off | ask | allow`. New and migrated apps default to read=allow and all others=ask.
Sensitive kinds (send/pay/book/del) reject allow in both protocol schemas and AppsService.
`apps.connect/update` accept partial permissions. `classifyAppTool` in `@boto/protocol`
(shared with the desktop UI) classifies the
operation after `<slug>-` on underscores, hyphens and camelCase. The leading verb determines
the kind; verbs after and/or/then can escalate it (del > pay > book > send > write > read).
Read-object nouns do not escalate. An unknown leading token falls back to known verbs
anywhere in the name; no known verb fails closed to write.
This is a naming heuristic, not argument or semantic inspection.
The Apps permissions dialog edits stored levels; disconnect confirms removal of saved
secrets, while enable/disable remains reversible. No account or last-used data is invented.
Grok rejects `__` in MCP tool names because it uses that separator to qualify server and tool names.

## Pages

`src/pages.ts` (`PageLibrary`, migration 17 `pages`): bots publish self-contained HTML with
bridge `page_publish {title, html|file, id?}` (5 MB; `file` must be in the bot's or the
shared workspace), `list_pages`, `read_page`. Files: `<workspace>/Pages/<id>/index.html`,
old versions in `.history/v<n>.html`. Served at `GET /pages/<id>?token=<viewToken>` (token
per daemon start, CSP `default-src 'none'`, no network); UI `PagesView` (sidebar "Pages")
shows them in `<iframe sandbox="allow-scripts">` (Tauri CSP `frame-src http://127.0.0.1:*`).
RPC `pages.list/delete`, event `pages.changed`. Tests: `test/pages.e2e.test.ts`.
Titles are capped at 200 and descriptions at 1000 UTF-16 units on create and update
(including legacy values), without splitting a surrogate pair.

## Group chat + navigation

Channels are "Group chats" in the UI. `ChannelService.post(channelId, text, replyTo?)`:
`@Name` sends to those members, `@everyone`/`@all` to every member, a reply to a bot's
message goes to that bot (quoted as `<in_reply_to>`), otherwise the owner. Member replies are
forwarded to the owner only for bot-originated work (`queue.from_agent_id`). Migration 18 adds
`channel_messages.reply_to`. UI: `CommandPalette` (⌘K all, ⌘⇧F bots on macOS; Ctrl+K and
Ctrl+Shift+F elsewhere) and shortcuts in `App.tsx` (⌘N new session for the selected bot,
⌘⇧N new bot, ⌘1–9 switch bot, ⌘, settings, ⌘P pages on macOS; Ctrl equivalents elsewhere).
