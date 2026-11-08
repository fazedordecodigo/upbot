# Approvals

`src/approvals.ts` (`ApprovalService`): every bridge tool call passes `gate()`. Rules
(`settings.approval_rules`, glob on tool names, per bot or `agentId: null`): "ask" beats
"allow". App permissions are authoritative: off denies without an approval, allow passes
only for read/write, ask creates an approval. Explicit ask rules still require review;
neither specific nor wildcard allow rules bypass app permissions. Sensitive app tools
always ask unless off (then deny). App-tool approvals carry appId, appName and permission.
Unknown operations use write (ask by default), never the default read allow.
For app requests, `task` approves once and grants the same app+kind for the current turn
only (non-sensitive kinds); turn end clears grants. `always` sets a non-sensitive app
kind to allow and returns previousLevel for undo via apps.update. For sensitive kinds,
task/always approve only this call, leave ask unchanged and never create an allow rule.
Non-app approvals retain tool-name-rule behavior. Decisions emit approval.updated;
permission changes also emit apps.changed. Apps, composer, Approvals and RunPanel
refresh from these events. Undo restores only the previous preference, never an executed
external action; task and deny expose no undo.
A pending approval blocks the call; background turns (from another bot, routine, gateway,
team or group chat — `AgentRuntime.currentTurn().background`) expire after
`BOTO_APPROVAL_BACKGROUND_TTL_MS` (10 min), others after `BOTO_APPROVAL_TTL_MS` (60 min);
a finished turn expires its approvals. Bridge `request_secret` (masked form, value goes to the
vault allowlisted to the bot) and `request_takeover` (user uses the bot browser, clicks Done).
RPC `approvals.list/respond/rules/setRules` (also allowed for mobile), events
`approval.updated`, `approvals.rulesChanged`. Codex gets `tool_timeout_sec = 3600` for MCP
servers so waits do not time out. UI: `ApprovalCards` above the composer, Settings →
Approvals. Tests: `test/approvals.e2e.test.ts`, `test/approval-audit.test.ts`.
Every terminal decision persists to `approval_audit` (migration 21): `approval.decided`
(status, decision, kind, tool, app/permission, ageMs — never args or secret values),
`approval.auto_denied` for off permissions, `approval.permission_escalated` for
`always` escalations (app previousLevel or created ruleId), `approval.rules_changed`
(added/removed/changed rule ids) and `approval.app_permissions_changed` (source connect/update/
restore, per-kind from/to). Failed or overridden decisions include requestedDecision, reason
and failure. `approval.secret_allowlist_read_failed` records vault allowlist failures; error
details in the audit and stderr are limited to code/name, never message or stack. Tests:
`test/approval-audit.test.ts` and
`test/approvals.e2e.test.ts` cover the audit trail.

Desktop notifications: `apps/desktop/src/lib/notifications.ts` owns approval eligibility,
bounded summaries, actions, persisted one-hour mute and daemon decisions. Only pending
approvals notify; unknown/incomplete/oversized details, secrets, takeover, pay, book and del
open the app. Notifications never offer always. Permission buttons are deny/task;
sends require recipient and full content. Closing a notification does not decide it.
Inline results replace the same identifier; only a real preference undo can offer
Desfazer for six seconds. Current once/task/deny decisions have no undo.
macOS uses objc2 UserNotifications categories/delegate only in a real .app bundle;
unbundled development is a no-op. Muting skips macOS delivery (not replayed on unmute).
Windows uses WinRT ToastNotification XML (reminder requests), the app's AUMID and
per-user COM activation registration; mute uses SuppressPopup plus silent audio and
is also in the toast context menu. General settings expose mute on every platform.
Mute changes and the persisted startup deadline sync to native on every platform. Linux
skips expiry re-presentation while muted, dropping the entry without replay on unmute.
Linux uses freedesktop D-Bus notifications with replacement by approval id.
Unmuted interrupted notices are kept without a deadline and only offer review. During mute,
retention changes local state only: every action opens review, expiry is not replayed, and
unmuting never presents the notice again. Pending requests
use a timeout until expiresAt and are re-presented on early server expiry; closing never
decides. Muted posts close the previous notification without delivery or replay.
Buttons and click callbacks require
the server's actions capability; without it notifications show but clicks cannot be reported.
Native callbacks queue actions until the main frontend can drain them; the daemon
remains authoritative. `approval-badge.ts` counts unexpired pending approvals from
`approvals.list` (startup/reconnect) and `approval.updated`, expiring them locally.
The main window calls `set_approval_badge`: macOS Dock count, Windows taskbar overlay
(1–9, then 9+), Linux Unity launcher count where supported by the desktop environment
and installed .desktop entry. Zero clears it; email drafts are not counted. Badges
on macOS require `UNAuthorizationOptions::Badge` alongside alert/sound authorization;
existing installs may need System Settings → Notifications → Boto → Badge application icon
enabled after upgrading. The app respects the system's disabled badge preference. Badges
ignore notification mute, which suppresses popups rather than passive pending state.
Blocked calls are memory-only and die with the daemon. Pending approvals are mirrored in
`approval_records` (migration 22) with only the audit fields (kind, tool, secretName, app
id/name, permission, background, expiresAt — never args, detail, bot-written titles or secret
values); a decision or expiry deletes the row. `ApprovalService.suspend()` runs first on
shutdown so closing runtimes do not expire them. On start, `interruptLeftovers()` marks leftover
rows `interrupted` (`interruptedAt`) and writes `approval.interrupted` (reason `daemon_restart`)
in one transaction per approval (a failed audit write keeps the row pending for the next
start), and keeps the latest 50. `approvals.list` returns them with `detail: ""` and a title
rebuilt from the tool/secret name; `approvals.respond` rejects them with `not_found`
("interrupted by a daemon restart"); nothing is resumed or re-run. UI: "Interrompido pelo
reinício", no actions. Toast clicks for those IDs open Settings → Approvals with
`INTERRUPTED_NOTICE` and remove the toast; unknown IDs keep the generic unavailable notice.
Startup/reconnect preserves delivered interrupted toasts without posting them again;
they are removed on review or when the retained interrupted record is pruned.
Tests: `test/approvals-restart.e2e.test.ts` (SIGKILL and SIGTERM restarts),
`test/approval-audit.test.ts`, desktop `test/notifications.test.ts`.
Windows registers its COM activator before spawning the daemon; `-ToastActivated`
payloads and COM callbacks share the native queue. The single-instance plugin forwards
second-launch arguments and focuses the existing window before another daemon starts.
