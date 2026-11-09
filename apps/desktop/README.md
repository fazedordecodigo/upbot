# Desktop

Tauri 2, React 19 and Vite. Run commands from the repository root:

```sh
bun run --cwd apps/desktop dev
bun run --cwd apps/desktop build
bun test apps/desktop/test
```

## Layout

- `src/main.tsx`: storage migration, theme initialization, shell mount; the tray route remains empty.
- `src/shell/`: App, Sidebar, Topbar, in-memory router, daemon context and native integration.
- `src/ui/`: Dialog, Sheet, Dropdown, Tooltip layer, Toast provider, Tabs, Switch and typed sprite icons.
- `src/views/`: one TSX file per view, importing its own same-named CSS file (even when empty).
- `src/dialogs/`: onboarding and shortcuts dialogs with their own styles.
- `src/styles/`: generated tokens, layout primitives and shared controls. Shell styles stay in `src/shell/shell.css`; view-specific rules stay with their view.
- `src/lib/`, `src/hooks/`: preserved daemon, native and data infrastructure.

Use the primitives rather than duplicating focus, keyboard or modal behavior. App navigation is in memory; the URL hash carries development daemon credentials, not view routes.
One view = one file + one CSS; don't edit shared files for view-specific work.

## Design and fonts

Follow [DESIGN.md](../../DESIGN.md) and [the design system](../../docs/design-system.md).
Icons use `src/ui/icons.tsx` with the sprite in `public/assets/icons.svg`.
Bricolage Grotesque, Inter and JetBrains Mono are bundled as variable WOFF2 fonts in
`src/fonts/` under the SIL Open Font License (OFL). No font CDN is used.
`bun scripts/build-tokens.ts` generates token CSS and font-face declarations; do not edit generated CSS.
