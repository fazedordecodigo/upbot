# CI, releases, updates, branding

- `.github/workflows/ci.yml`: lint/typecheck on Ubuntu; tests, daemon build, Rust check and
  desktop build on macOS ARM64 and Linux/Windows x64 and ARM64.
- `.github/workflows/release.yml`: on `v*` tags, tauri-action builds macOS `.app`/`.dmg`,
  Linux x64/ARM64 `.AppImage`/`.deb`/`.rpm` and per-user Windows x64/ARM64 NSIS
  `.exe` into a draft release. Linux uses Ubuntu 22.04 on both architectures for the same
  glibc baseline. Native Bun host detection in `beforeBuildCommand` builds the matching sidecar.
  It composes `latest.json` from five architecture-specific updater assets and signatures
  before publishing (macOS `.app.tar.gz`, Linux AppImage, Windows NSIS; not deb/rpm).
  RPM and deb packages do not self-update.
  Updater signing uses the `TAURI_SIGNING_PRIVATE_KEY` repo secret (pubkey in `tauri.conf.json`
  `plugins.updater`); Apple signing/notarization turn on when `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (+ `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`) secrets exist. Partial secret groups and notarization without signing fail.
  `Entitlements.plist` covers Bun JIT, microphone and Apple Events for the app and sidecar.
  Tauri notarizes/staples the app; the workflow notarizes/staples the DMG, verifies both,
  and replaces the uploaded DMG. Windows Authenticode uses `WINDOWS_CERTIFICATE` (base64
  PFX) and `WINDOWS_CERTIFICATE_PASSWORD`, imported into the runner's user certificate store;
  SHA-256/RFC 3161 signing covers the app, sidecar and installer, with post-build verification.
  No signing secrets keeps macOS ad-hoc and Windows unsigned; updater signing is separate.
  Bump `version` in `tauri.conf.json` before tagging.
- In-app updates: `tauri-plugin-updater` + `components/UpdateButton.tsx` (sidebar footer).
  Repository URLs now use `fazedordecodigo/boto`. Installed clients polling the old
  `upbot` endpoint follow GitHub's repository redirect; do not recreate an `upbot`
  repository under the account, which would break that redirect. Release metadata uses
  `github.repository` for asset URLs. The v0.4.0 tag shipped as UpBot but reported 0.3.0;
  workspace packages, desktop Rust crate and host now prepare 0.5.0 consistently.
  CHANGELOG keeps post-v0.4.0 work under `0.5.0 (Unreleased)` until the next tag.
- Icon source: `apps/desktop/branding/icon.svg` -> `icon.png` (Chrome headless render) ->
  `bunx tauri icon branding/icon.png` (from `apps/desktop`).
