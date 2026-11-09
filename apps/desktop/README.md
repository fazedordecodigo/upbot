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
- `src/ui/`: Dialog, Sheet, Dropdown, Tooltip layer, Toast provider, Switch and typed sprite icons.
- `src/views/`: one TSX file per view, importing its own same-named CSS file (even when empty).
- `src/dialogs/`: onboarding and shortcuts dialogs with their own styles.
- `src/styles/`: generated tokens, layout primitives and shared controls. Shell styles stay in `src/shell/shell.css`; view-specific rules stay with their view.
- `src/lib/`, `src/hooks/`: preserved daemon, native and data infrastructure.

Use the primitives rather than duplicating focus, keyboard or modal behavior. App navigation is in memory; the URL hash carries development daemon credentials and optionally `task=<id>` to open a task.
One view = one file + one CSS; don't edit shared files for view-specific work.

## Views and daemon wiring

The visual reference is [`docs/design/index.html`](../../docs/design/index.html),
its `assets/boto-ui.css` and icon sprite. `DESIGN.md` governs dynamic regions absent
from the prototype. Visible copy is pt-BR and uses “Agentes”; unknown numbers render
as “a definir”. Product data comes from the daemon, not sample datasets.

| Surface | Daemon methods |
| --- | --- |
| Início | `profile.get`, `tasks.list`, `tasks.deliveries`, `tasks.get`, `desktop.machines`, `approvals.list` |
| Nova tarefa | `agents.list`, `providers.getDefault`, `profile.get`, `templates.use`, `tasks.create`, `routines.create` |
| Tarefa / Área de trabalho | `tasks.get`, `tasks.history`, `tasks.instruct`, `tasks.pause`, `tasks.resume`, `tasks.stop`; `permissions.respond`, `approvals.list`, `approvals.respond`, `memories.usage`; `desktop.subscribe`, `desktop.input`, `desktop.takeover`, `desktop.release` |
| Agentes / painel / Novo agente | `agents.overview`, `agents.statuses`, `agents.create`, `agents.update`, `agents.delete`, `agents.configOptions`, `agents.setConfig`; `queue.get`, `queue.pause`, `queue.resume`, `queue.remove`, `chat.history`, `tasks.create`, `memories.list`, `desktop.machines`, `desktop.thumbnail` |
| Rotinas | `routines.list`, `routines.update`, `routines.run`, `routines.delete`; creation uses the scheduled composer and `routines.create` |
| Modelos | `templates.list`, `templates.use`; prefills Nova tarefa and forwards `templateId` when delegating |
| Marketplace | `marketplace.list`, `marketplace.install`; tabs, category/search and details use registry data |
| Configurações: Provedor de IA | `providers.list`, `providers.scan`, `providers.login`, `providers.setDefault`, `providers.setApiKey`, `providers.deleteApiKey` |
| Configurações: Você e a memória | `profile.get`, `profile.update`, `profile.forget`, `memories.list`, `memories.update`, `memories.delete` |
| Configurações: Aparência / Privacidade | `profile.update`, `permissions.list`, `permissions.respond` |
| Shell / onboarding | `tasks.list`, `tasks.search`, `agents.overview`, `routines.list`, `profile.get`, `profile.update`, `onboarding.complete` |

Subscriptions refresh snapshots after daemon events and reconnects. Loading, empty
and error states remain explicit. Permission and approval cards require real daemon
decisions; there is no approval bypass. Sidebar and composer privacy share
`profile.defaults.private`. Guia da marca uses the existing native opener, with a
browser fallback. Search, shortcuts, theme, account menu and the four-step onboarding
belong to the shell; the sidebar supports resizing, collapse and a mobile drawer.

### Removed from the UI only

Standalone E-mail, Canais/chat em grupo, Páginas, Hosts, Biblioteca, Aprovações,
Apps conectados, Cofre, Gateways, Mobile, Times, Ferramentas and usage bars are no
longer desktop navigation surfaces. Their daemon/protocol capabilities are retained.
This does not remove task approval cards or the composer's tool controls.

## Isolated development and visual checks

After `bun install`, run from the repository root in one terminal:

```sh
ROOT="$PWD"
umask 077
STATE="$(mktemp -d "$HOME/boto-preview.XXXXXX")"
openssl rand -hex 32 > "$STATE/token"
chmod 600 "$STATE/token"
TOKEN="$(cat "$STATE/token")"
printf 'Preview state directory: %s\n' "$STATE"
ACP="$(bun -e 'console.log(JSON.stringify([process.execPath, process.cwd() + "/packages/daemon/test/fixtures/fake-acp-agent.ts"]))')"
{ printf '%s\n' "$TOKEN"; cat; } | \
  BOTO_PROVIDER_COMMAND_DEVIN="$ACP" \
  FAKE_ACP_STATE_DIR="$STATE/fake-acp" \
  BOTO_MARKETPLACE_URL="file://$ROOT/marketplace/index.json" \
  bun packages/daemon/src/main.ts --data-dir "$STATE/data" --agents-root "$STATE/agents"
```

Keep stdin open: its first line authenticates the daemon; EOF stops it. The fake ACP
is a development/test provider, not product data. Do not enable shell tracing (`set -x`),
echo or commit the token, or share credential-bearing URLs. Only the state directory
path is printed; the token file is private and outside the checkout.
In separate terminals, still from the repository root:

```sh
bun run --cwd apps/desktop dev --port 1420 --strictPort
python3 -m http.server 8765 --bind 127.0.0.1
```

In another shell, reuse the private token file without printing its contents. Replace
the state suffix with the directory printed above, and use the port from `BOTO_READY`:

```sh
STATE="$HOME/boto-preview.XXXXXX" # replace with the printed directory
PORT=12345 # replace with the BOTO_READY port
TOKEN="$(cat "$STATE/token")"
xdg-open "http://localhost:1420/#port=$PORT&token=$TOKEN" # macOS: use open instead
unset TOKEN
```

Remove the preview state directory after stopping the daemon. Open the reference at
`http://127.0.0.1:8765/docs/design/index.html`. Complete onboarding in the app;
onboarding checks instead start with a fresh data directory.

For automated setup, follow `test/agent-config.test.ts` and
`packages/daemon/test/helpers.ts`: `startDaemon`, `DaemonClient.connect`,
`onboarding.complete`, `agents.create`, `providers.setDefault`, `tasks.create` with
`echo: hi`, and `routines.create` for recurring (`schedule`) and once-only (`runAt`)
routines. Compare Chrome screenshots at 1440×900, 1024×768 and 390×844 in both themes.
Without Firecracker, verify the real desktop empty state rather than fabricating a
frame. The local prototype has empty dynamic regions, inactive controls and incomplete
styles; screenshots do not establish complete pixel parity in those regions.

```sh
bun test apps/desktop/test
bun run lint && bun run typecheck
bun run --cwd apps/desktop build
```

## Design and fonts

Follow [DESIGN.md](../../DESIGN.md) and [the design system](../../docs/design-system.md).
Icons use `src/ui/icons.tsx` with the sprite in `public/assets/icons.svg`.
Bricolage Grotesque, Inter and JetBrains Mono are bundled as variable WOFF2 fonts in
`src/fonts/` under the SIL Open Font License (OFL). No font CDN is used.
`bun scripts/build-tokens.ts` generates token CSS and font-face declarations; do not edit generated CSS.
