# Boto

Boto is a local-first desktop hub where a user runs a team of collaborating
general-purpose AI bots that work the web, files, email and connected apps on
their behalf.

## Language

### Core

**Bot**:
A general-purpose AI assistant the user creates, names, configures and talks to.
The product and UI term; code, RPC methods and database tables still say
`agent`.
_Avoid_: assistant, agent (in user-facing prose)

**Daemon (`botod`)**:
The Bun sidecar process that owns all persistent state (SQLite) and serves the
token-authenticated WebSocket API the desktop app talks to.
_Avoid_: backend, server

**Provider**:
An external agent CLI that executes sessions for a bot: claude, codex, gemini,
cursor, opencode, aider, devin or grok. Claude and Codex run through native
drivers; the rest speak ACP.
_Avoid_: model, LLM

**Session (provider session)**:
One live conversation process between a bot and its provider. It holds the
context until dropped — by a new session, compaction or a placement change.
_Avoid_: chat (the UI thread), conversation

**Turn**:
A single prompt→reply cycle inside a session, streamed as items while it runs.
_Avoid_: message, run (a run belongs to a routine)

**Queue**:
The per-bot FIFO of pending prompts, drained oldest-first while the bot is idle.
Cancelling or a failed turn pauses it.

**Task**:
A first-class unit of work with its own provider-session scope and a situation
lifecycle: `run` → `wait`/`muted` → `done`. Files it produces plus its final
reply become deliveries.
_Avoid_: job

**Delivery**:
What a finished task hands back: the files under its task directory plus the
final reply.

**Instance**:
An ephemeral extra runtime spawned to help a bot drain queued work, up to its
`maxInstances`. It has no session resume, usage or compaction.

**Workspace**:
A bot's own working directory — its files, attachments, Pages and screenshots.
Local sessions also get the Shared Workspace as an extra directory.

**Shared Workspace**:
`~/Boto/Workspace`, a directory every local bot can reach for collaboration.

**Shared root**:
`~/Boto/Shared`, the global store holding bot-to-bot Transfers and the skills
library.

### Collaboration

**Bridge**:
The `boto` MCP stdio server injected into every provider session. It is how a
bot reaches daemon capabilities: messaging, file sharing, vault reads, app
tools, browser, computer use.

**Channel**:
A group chat of bots plus the user; the UI labels it "Group chats". Posts route
to the channel owner; bot replies are posted back to the channel.
_Avoid_: room

**Channel owner**:
The member bot that receives user posts and coordinates the channel's work.
Defaults to the first member.

**Subagent**:
An ephemeral child bot another bot spawns for a bounded task. It reports one
batched result back to its parent and is deleted afterwards unless kept.
_Avoid_: task (a Task is the first-class unit)

**Transfer**:
A file one bot shares with another via `share_file`, copied under the Shared
root with a checksum manifest.

**Routine**:
A saved prompt bound to a bot with a `schedule`, `webhook` or `manual` trigger;
each firing is a run.

**Page**:
A self-contained HTML artifact a bot publishes to its workspace's `Pages/`
directory, viewed in the app's sandboxed iframe.
_Avoid_: artifact, document

**Email draft**:
A pending outbound email a bot composes. Only the user can send; bots never
send mail directly.

**Connected app**:
A third-party MCP server the daemon itself runs and exposes to bots as
`<slug>-<tool>` — from the built-in catalog or a custom stdio/HTTP server.
Secrets live in the vault.
_Avoid_: integration, plugin (a plugin is a marketplace bundle)

### Trust and secrets

**Approval**:
A user decision gate on a bridge tool call. The call blocks until the user
responds (once / for this task / always / deny) or it expires.
_Avoid_: permission — that is the provider's own consent, below

**Permission (provider)**:
A provider CLI's native tool-use consent request, surfaced as permission cards
and answered via `permissions.respond`. Distinct from an Approval: approvals
gate bridge tools, permissions belong to the provider.

**Approval rules**:
Glob-matched tool policies, per bot or global, resolving to `ask` or `allow`.
`ask` always beats `allow`.

**App permission kind**:
The classification of an app tool's operation: `read | write | send | pay |
book | del`, each mapped to `off | ask | allow`. The sensitive kinds —
`send/pay/book/del` — can never be set to `allow`.

**Vault**:
The AES-256-GCM secret store. Values are write-only over RPC and reach a bot
only through a per-secret allowlist.

**VM credentials (`vmcred`)**:
Provider sign-in secrets reserved for remote placements (firecracker, localvm).
Stored in the vault but never on a bot's allowlist.

### Knowledge library

**Memory**:
A durable per-bot note written via `remember`; injected into fresh sessions.
_Avoid_: fact, note

**Skill**:
A versioned `SKILL.md` in the shared skills library, available to every bot.
_Avoid_: command, playbook

**Agent template**:
A marketplace recipe that creates a preconfigured bot and installs its listed
skills.

**Plugin**:
A marketplace bundle that installs a set of skills together.

**Marketplace**:
The checksum-verified registry of installable skills, agent templates, apps
and plugins.
_Avoid_: store

### Connectivity

**Gateway**:
An external messaging surface (Telegram, Slack or Discord) whose inbound
messages become external turns on a bot and whose replies return to the same
thread.

**Mobile companion**:
An opt-in LAN web app paired by a 6-digit code, limited to an allowlisted RPC
surface.

**Team**:
Boto users connected through a relay who share bots and exchange messages.

**Relay**:
The self-hostable Bun server that routes team frames. It stores no chat
content.
_Avoid_: server (that's botod)

### Remote execution

**Host**:
A machine registered as a place to run bot sessions — an SSH host or the local
Lima VM.

**Placement**:
The binding of a bot to where its sessions run: local, an SSH host, a
Firecracker microVM or the local VM.

**MicroVM**:
The per-session Firecracker VM that isolates a remote provider run. It is the
security boundary for remote execution.

**Local VM ("Computador")**:
The Lima-managed Linux VM on the user's own machine, registered as a `localvm`
host. Settings label: "Computador"; placement option: "VM local".

**Machine**:
A bot's live guest desktop inside a microVM or the local VM, streamed to the
app. Exactly one controller owns its input at a time: the agent or the user.

**Takeover**:
User control of a Machine — or of the bot's browser — suspending agent input
until released.

**Computer Use**:
Per-bot opt-in control of the user's own desktop: screenshot, click, type, key.
Distinct from a Machine, which is a guest desktop.

### Runtime housekeeping

**Compaction**:
Replacing a session's history with an agent-written summary when the context
window fills; the provider session is dropped and the next one starts from the
summary.

**Usage**:
A session's context-window snapshot plus cumulative input/output tokens and
cost.

**Default bot**:
The bot the UI falls back to. No bot is seeded on fresh installs; the first one
created is adopted as the default.

### Naming history

**Boto**:
Current product name, renamed from UpBot (earlier BobAgent). The old names
survive only in migration code and legacy file paths.
_Avoid_: UpBot, BobAgent in new prose and code
