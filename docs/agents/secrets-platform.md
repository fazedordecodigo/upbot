# Vault, connectors, Computer Use, voice

Vault (`src/vault.ts`, migration 10 `vault` + `settings`): AES-256-GCM secrets; key precedence
is `BOTO_VAULT_KEY` (64 hex, tests), macOS Keychain (service `Boto`, account `vault-key`),
an existing `<data-dir>/vault.key`, then Windows DPAPI or Linux Secret Service. Linux writes
`vault.key.location` after a successful Secret Service store so a locked/unavailable keyring
cannot silently orphan secrets; when secure storage is unavailable, a 0600 plaintext key file
is used with a warning. Windows DPAPI runs `powershell.exe` with .NET-only scripts and
`$PSModuleAutoLoadingPreference = 'None'`: `Add-Type -AssemblyName` took 25-36 s per cold call
on `windows-11-arm` (process start and the Utility module import were under 1 s). A timed-out call is retried once
(`DPAPI_TIMEOUTS_MS`, 30 s then 90 s); a persistent timeout throws and never writes a plaintext
key, while a missing `powershell.exe`, non-zero exit or write failure keeps the warned
fallback. Warnings and errors name only an error code, exit status or timeout, never
PowerShell stderr. Fallback diagnostics are covered by `test/vault-platform.test.ts` and
`test/vault-fallback.e2e.test.ts`. Existing plaintext keys are kept without migration.
Per-secret agent allowlist. RPC
`vault.list/set/setAccess/delete` (values never returned), event `vault.changed`; bridge
`vault_list`, `vault_get`. Connectors (`src/connectors.ts`) use shared secrets without
returning them: `connector.github` -> `github_api` (REST proxy, token redacted,
`BOTO_GITHUB_API` for tests); `connector.1password` -> `onepassword_read` (`op read`,
optional service-account token); `connector.bitwarden` -> `bitwarden_get` (`bw get`,
BW_SESSION). `BOTO_OP_COMMAND`/`BOTO_BW_COMMAND` override the CLIs.
Computer Use (`src/computer.ts`, `src/computer-platform.ts`): off per agent until `computer.setAccess`; bridge
`computer_screenshot` (screencapture), `computer_click` (CoreGraphics via JXA),
`computer_type` (macOS Unicode clipboard paste with prior clipboard contents restored),
`computer_key` (System Events on macOS, whitelisted keys/modifiers);
macOS refuses typing before changing the clipboard if a type cannot be materialized
(for example, an unreadable file promise); promised provider callbacks cannot be restored.
Windows uses PowerShell/.NET System.Drawing, user32 mouse input and Unicode SendInput.
Linux requires X11, xdotool and import (ImageMagick), scrot or gnome-screenshot.
`computer.access` includes an unavailable reason for Wayland/missing tools/display; the UI shows it.
Command/option map to Win/Super and Alt outside macOS; whitelist and approval gating are unchanged.
`BOTO_COMPUTER_DRYRUN=<file>` logs platform commands instead (tests); Windows typing payload
is passed only in the child environment to avoid command-line limits. Tests: `test/computer-platform.test.ts`.
Voice (`src/voice.ts`): `voice.speak` uses `BOTO_TTS_COMMAND` (text on stdin) or the
built-in default from `ttsCommand`: macOS `say`; Windows `powershell` (Windows PowerShell 5.1,
then `%SystemRoot%` path; pwsh lacks System.Speech) running the fixed `WINDOWS_SPEECH_SCRIPT`
that reads UTF-8 text from stdin; Linux `espeak-ng --stdin`, `espeak --stdin`, then Speech
Dispatcher over its SSIP unix socket (`src/voice-ssip.ts`; `SPEECHD_ADDRESS` or
`$XDG_RUNTIME_DIR/speech-dispatcher/speechd.sock`; runs `speech-dispatcher --spawn` when the
default socket is missing or refuses connections, e.g. left by a crashed server). Spoken text
never goes into argv (other local users can read it), so `spd-say` itself is never run. A new
`voice.speak` stops the previous one, and a 15-minute cap ends long speech, both with
`CANCEL SELF` before `QUIT` (the server keeps speaking after a client disconnects).
`voice.transcribe` uses `BOTO_STT_COMMAND` with `{file}`, or `whisper` on PATH (`sttCommand`).
An override always wins; if its binary is missing the feature is unavailable (no fallback).
`voice.status` reports only commands whose binary resolves on the merged PATH.
Tests: `test/voice.test.ts` (per-platform selection, SSIP escaping, Windows script on Windows
CI) and `test/voice.e2e.test.ts` (RPC with built-in defaults: fake programs as the only PATH
via a fake login shell, `fixtures/fake-tts.ts`, `fixtures/fake-speechd.ts`). UI: Vault view, Computer Use toggle, composer mic, read-aloud button;
`src-tauri/Info.plist` has the microphone usage string. Tests: `test/phase11.e2e.test.ts`.
