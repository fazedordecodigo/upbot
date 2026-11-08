# Collaboration and library

## Agent-to-agent bridge (Phase 5)

Every provider session gets a `boto` stdio MCP server: the daemon binary run as
`botod mcp-bridge` (dev: `bun src/main.ts mcp-bridge`), with
`BOTO_BRIDGE_URL`/`BOTO_BRIDGE_TOKEN` in its env. The token is per agent,
regenerated each daemon start, and never the daemon's main token. The bridge forwards
`tools/list`/`tools/call` to `POST /bridge` (Bearer bridge token; any Origin header ->
403). Passed via ACP `mcpServers`, Claude `--mcp-config`, Codex `thread/start.config`
(`mcp_servers.boto`). Tools (`src/bridge.ts`):
- `list_agents`, `send_message {to, text}`: enqueues on the recipient with
  `queue.from_agent_id` + `hops` (migration 5). The recipient's prompt is framed by
  `<agent_message_context>` (`wrapAgentMessage`); its `user_message` item has `from`.
  Chains stop at `MAX_HOPS` (6).
- `share_file {to, path, note?}`: only regular files inside the sender workspace, max 100 MB.
  It copies the file to `<shared>/Transfers/<id>/` with `manifest.json` (sha256), delivers it
  to `<recipient ws>/transfers/<id>/<name>`, and notifies the recipient. Shared root is
  `BOTO_SHARED_ROOT` or `dirname(agentsRoot)/Shared` (default `~/Boto/Shared`).
Tests: `test/bridge.e2e.test.ts` (the fake ACP agent's `mcp:<tool> <json>` prompt
spawns the real bridge and calls the tool).

## Channels (Phase 6)

`src/channels.ts` (`ChannelService`, migration 6: `channels`, `channel_members`,
`channel_messages`, `queue.channel_id` + `queue.prompt`). RPC `channels.list/create/
history/post/stop/resume/archive/restore/reassign`; events `channel.created`,
`channel.updated`, `channel.message`. A user post goes to the owner (default: first
member) as a queue item whose provider prompt (`queue.prompt`) carries a
`<channel_context>` block with role and recent transcript. When a channel turn ends
(`turn.ended` hook in `main.ts`), the agent's reply is posted to the channel, and a
member's reply is forwarded to the owner (hop-limited by `MAX_HOPS`). Bridge tools
`list_channels` and `delegate {channel, to, task}` (members only). Stop/archive remove
queued channel items and cancel running channel turns; posting needs `active`.
UI: sidebar "Channels" + `components/ChannelView.tsx`. Tests: `test/channels.e2e.test.ts`.

## Usage + compaction (Phase 7)

Providers emit `{type:"usage"}` updates (ACP `usage_update` + `PromptResponse.usage`,
Claude `result.usage`/`total_cost_usd`/`modelUsage.contextWindow`, Codex
`thread/tokenUsage/updated`). `agent_usage` (migration 7) stores the context snapshot
(`usedTokens`/`contextWindow`) and cumulative in/out tokens and cost; `agents.usage` RPC +
`agent.usage` event; UI `components/UsageBar.tsx`. Compaction (`AgentRuntime.compact`, via
`agents.compact` or automatically after a completed turn when used/window >=
`BOTO_COMPACT_THRESHOLD`, default 0.85, `off` disables): the agent answers a
`<compaction_request>` prompt (output captured, permissions denied, timeout
`BOTO_COMPACT_TIMEOUT_MS`), the provider session is dropped and forgotten, and a
`compaction` chat item stores the summary. The next fresh session gets
`<conversation_summary>` plus only the history after it. The queue waits while compacting.
`agents.newSession` (sidebar "Nova sessão", rejected with `busy` during a turn/compaction)
drops and forgets the provider session, clears `usedTokens` and adds a `session_reset` item;
the next session gets no summary or history from before it. Sidebar's small top button
(`BotPlusIcon`) opens the create-bot dialog.
Tests: `test/usage.e2e.test.ts`.

## Avatars, memories, skills, agent creation (Phase 8)

`Agent.avatar` (`{emoji,color}`, `{icon}` with `sym|mail|receipt|plane|chart|cal|sheet`, or
null; `agents.avatar_json`, migration 8). `agents.restore {id}` restores a soft-deleted agent
and emits `agent.created` so clients add it back to their lists. `agents.draft
{prompt}` (`src/draft.ts`, deterministic) proposes name/instructions/avatar for the create
form. Memories: `memories` table, `MemoryStore` (`src/memories.ts`), RPC
`memories.list/add/update/delete`, event `memories.changed`. Skills library:
`<shared>/Skills/<name>/SKILL.md` with name/description/author frontmatter, previous versions
in `.history/` (`src/skills.ts`), RPC `skills.list/get/save/delete/versions`, event `skills.changed`.
`skills.versions` reads only numeric `.md` history files, newest first (50 max), with
1-based ordinals across the full history and filename-derived `savedAt`. Unknown skills
return not_found. Desktop skill details offer read-only previous Markdown/raw versions,
metadata and return to current; no restore action or mobile access is exposed.
`skills.get` and `skills.versions` expose exact file contents as `raw` (including
frontmatter) for raw viewing; Markdown uses parsed `body`. `skills.list` omits raw.
`skills.save` accepts optional `previousName`: renames move the skill directory and its
history, then save a revision. An occupied destination fails with `bad_request` without
changing either skill; a missing previous name behaves like a plain save. Skills are
shared globally, not assigned to bots; `skills.changed` has an empty payload.
Bridge tools: `remember`, `forget`, `list_memories`, `list_skills`, `read_skill`,
`create_skill`, `revise_skill`, `create_agent`. The first prompt of every fresh session is
prefixed with `<agent_memories>` and `<skills_library>` (index only). UI:
`components/Library.tsx`; the saved agent configuration screen is
`apps/desktop/src/components/AgentConfigScreen.tsx`. Tests: `test/phase8.e2e.test.ts`.

## Routines + attachments (Phase 9)

Routines (`src/routines.ts`, migration 9: `routines`, `routine_runs`) are saved prompts sent
to an agent with `trigger` schedule|webhook|manual. Schedules: `every <n>m|h|d`, `daily HH:MM`,
`weekly <day> HH:MM` (local time); the scheduler ticks every `BOTO_ROUTINE_TICK_MS`
(default 30000), skips soft-deleted agents, and collapses missed runs into one. Manual and
webhook triggers also reject routines whose agent is soft-deleted; restoring the agent resumes
scheduled runs. Webhooks: `POST /hooks/<routineId>` with
`Authorization: Bearer <webhookToken>` (per-routine token; Origin rejected), body passed as
`<webhook_payload>` (20 KB cap). RPC `routines.list/create/update/delete/run/runs`, events
`routine.updated`/`routine.deleted`. The prompt is wrapped in `<routine name trigger>`;
`queue.meta_json` puts `routine`/`attachments` on the user_message item. `readQueueMeta`
validates each known field (routine/gateway/team/attachments entries) independently; invalid
ones are dropped (no reply destination is invented), unknown keys are ignored, and an invalid
or unparseable origin keeps the turn background.
Attachments: `chat.send {attachments:[{name,mime,dataBase64}]}` (max 10, 25 MB total) are
written to `<workspace>/attachments/<id>/` (`src/attachments.ts`, basename-sanitized, ZIPs
extracted with `unzip` or Windows `tar`, with unsafe archive paths rejected) and listed in an
`<attachments>` block. Tests: `test/phase9.e2e.test.ts`.

## Agent browser (Phase 10)

`src/browser.ts`: one Chromium-family browser (Chrome/Chromium/Edge/Brave, or
`BOTO_BROWSER_PATH`) launched lazily with `--remote-debugging-port=0` and its own profile
(`<data-dir>/browser-profile`, port read from `DevToolsActivePort`), driven over CDP (flattened
`Target.attachToTarget` sessions). Each agent gets one tab. Bridge tools: `browser_open`
(http/https only), `browser_snapshot` (numbered interactive elements via `data-bob-ref` + page
text), `browser_click`, `browser_type`, `browser_press`, `browser_back`, `browser_screenshot`
(PNG into `<workspace>/browser/`), `browser_close`. RPC `browser.status/closeTab/close`, event
`browser.updated`; UI `BrowserView`. `BOTO_BROWSER=off` disables it,
`BOTO_BROWSER_HEADLESS=1` for tests. Tests: `test/browser.e2e.test.ts` (skipped when no
browser is installed).
