# Local Linux VM (Lima)

Boto can run bots inside a **complete local Linux VM** on your machine — a full Debian
desktop, not a container or a microVM. It is managed by [Lima](https://lima-vm.io): on top of
Apple's Virtualization framework (`vmType: vz`) on macOS 13+, QEMU (`vmType: qemu`) on
Linux, and WSL2 (`vmType: wsl2`) on Windows.

## Prerequisites

```sh
brew install lima            # macOS
brew install lima qemu       # Linux (or the distro's lima + qemu-system packages)
```

On **Windows**, install the Lima bundle for Windows from
[Lima releases](https://github.com/lima-vm/lima/releases) (`limactl.exe` plus its drivers on
`PATH`) and make sure WSL2 is available (`wsl --install`). The VM is then a WSL distro —
no extra hypervisor — and on first create the daemon downloads Debian's official WSL
rootfs (`<data dir>/vm/debian-wsl-<arch>.tar.gz`, checksum-verified; override with
`BOTO_LIMA_WSL_IMAGE` to point at another `.tar.gz` or URL).

That's all — the daemon materializes the versioned recipe (`vm/boto-computer.yaml`) into its
data dir, rewriting it for the host OS first (`vmType`, `mountType`, mount locations and
guest image differ per platform), and drives `limactl` itself.

## Lifecycle

Everything lives under **Settings → Computador**: status (Lima availability, instance,
install state, last error) and the actions **Criar**, **Ligar**, **Desligar**, **Instalar
helper** and **Apagar**. The same operations exist over RPC as
`localvm.status/create/start/stop/delete/install`, with `localvm.changed` events.

- **Criar** registers the `boto-computer` instance and syncs a hosts row
  (`kind: "localvm"`, `lima@<sshAddress>:<sshLocalPort>` — `sshAddress` is `127.0.0.1`
  under vz/qemu and the distro IP under wsl2) so the VM can be a placement target.
- **Ligar** boots the instance (creating it first when needed) and, in the background, waits
  for provisioning to finish — first boot installs Debian packages, Node 22, Bun and the
  provider CLIs — then uploads `boto-host` and runs its preflight. The guest counts as
  provisioned when `/var/lib/boto-computer-provisioned` (first-boot install done) and
  `/run/lima-boot-done` (Lima's per-boot signal that all provision scripts ran; `/run` is
  tmpfs, so a reboot that installs newly-added CLIs still gates) both exist.
- **Instalar helper** re-uploads the host helper after an upgrade, waiting for
  provisioning first — an installed helper implies the provider CLIs are in place.
- **Apagar** stops (if running), deletes the Lima instance — `wsl --unregister
lima-boto-computer` under wsl2 — and removes the hosts row and any placements pointing
  at it. The shared folders under `~/Boto/computer/` are kept.

Manual equivalent from the repo root:

```sh
limactl create --name boto-computer vm/boto-computer.yaml
limactl start boto-computer
limactl shell boto-computer
```

## Placing a bot on the VM

In the bot's panel, **Onde ele trabalha** → **VM local**. The placement uses
`isolation: "none"` — the whole VM is the isolation boundary, so don't stack Firecracker on
top. The provider CLI runs inside the guest via `ssh … boto-host run` with the usual
reverse-forward bridge; its files persist under the guest's `~/.boto/agents/<bot>` and the
shared `/workspace`.

MicroVM sign-in credentials (Settings → Hosts) also apply: the local VM starts signed out,
so saved Claude/Codex/etc. logins ride the run spec env just like on Firecracker. Process
placements on ordinary SSH hosts are unchanged — they keep the host's login.

## What's inside

- Debian (12 cloud image on macOS/Linux — arm64 on Apple Silicon; Debian 13 WSL rootfs on
  Windows), 2 vCPUs / 4 GiB / 20 GiB where the vmType honors them (WSL2 sizes itself).
- Xvfb `:0` (`1280x800x24`) + Openbox (`boto-xvfb`, `boto-desktop` systemd units — or
  spawned directly when the guest has no systemd), xdotool, scrot — the pieces
  `boto-host guest-desktop` needs for the live desktop.
- Chromium maximized with DevTools on `127.0.0.1:9222`, forwarded to the host as
  `127.0.0.1:47222` for Playwright/CDP (Lima tunnels forwards through the guest
  agent, which dials inside the guest — loopback binds work under wsl2 too).
- noVNC on `127.0.0.1:47080` (`boto-vnc` + `boto-novnc`) as a direct/debug view; the
  password is generated at `~/Boto/computer/shared/vnc-password`.
- The seven provider CLIs (`claude`, `codex`, `gemini`, `opencode`, `agent` for Cursor,
  `devin`, `grok` — same set as the full guest image), Node 22 and Bun, all
  checksum-verified at provision time; git, curl, jq, python3, ffmpeg, ImageMagick,
  build tools. The CLIs are checked on every boot, so a guest provisioned before a
  provider joined the recipe installs it on the next start instead of needing
  recreation (guests created by older daemon recipes keep their baked-in scripts and
  still need **Apagar** + **Criar**).

## Storage and sharing

| Guest path   | Host path                   | Mode       |
| ------------ | --------------------------- | ---------- |
| `/workspace` | `~/Boto/computer/workspace` | read/write |
| `/mnt/boto`  | `~/Boto/computer/shared`    | read-only  |

`/workspace` (virtiofs on macOS; virtiofs or reverse-sshfs on Linux; a WSL2 `/mnt/c` bind
on Windows) is where files the bot hands back should land. `/mnt/boto` is for
host→guest inputs like the VNC password — the guest cannot write it.

## Network restrictions

All other guest→host port forwards are disabled (`guestPortRange … ignore: true`), and a
guest-side iptables chain rejects traffic to `host.lima.internal` (the host's own loopback —
admin panel, voice server) and to the guest's default gateway — which on WSL2 _is_ the
Windows host — except replies, DNS and DHCP. The VM can reach the internet but
not services on this machine; Boto itself goes through the Lima SSH channel.

## Live desktop

Subscribing to the bot's machine in **LiveDesk** spawns
`ssh … DISPLAY=:0 boto-host guest-desktop` — the same scrot/xdotool NDJSON pipeline used for
Firecracker microVMs, so frames (≤10 fps), thumbnails, cursor events, takeover/release and
agent Computer Use all work identically. noVNC remains available at
`http://127.0.0.1:47080` for a smoother human-driven session.

## Troubleshooting

- **"Lima não está instalada"** — install Lima for your OS (see Prerequisites), then reopen
  Settings → Computador. On Windows also make sure `wsl --status` works; on Windows the
  feature needs Lima's Windows bundle _and_ the WSL2 platform.
- **Windows notes** — under `vmType: wsl2` the "VM" is a WSL distro (`wsl -l -v` shows
  `lima-boto-computer`); SSH reaches it at the distro IP, not 127.0.0.1, and Lima marks
  the driver experimental, so some recipe fields (cpus, memory, disk) are ignored.
- **"Preparando a VM…"** stuck — first boot provisioning can take several minutes; watch
  `limactl shell boto-computer -- sudo journalctl -u cloud-final -f` (or
  `wsl -d lima-boto-computer journalctl -f` on Windows). If it never finishes,
  `limactl stop`/`start` re-runs the provision step (the base install is guarded by the
  marker file; provider CLIs install on every boot).
- **State "broken"** — Lima reports an unexpected status; `limactl list` shows the raw
  value. `Apagar` + `Criar` rebuilds the instance (shared folders survive).
- **Provider won't launch / machine shows error** — the helper may be missing or stale;
  run **Instalar helper**. A VM created before a recipe change keeps its original
  provision: **Apagar** + **Criar** rebuilds it with the current recipe (the shared
  folders under `~/Boto/computer/` survive), or install the missing piece inside the
  guest by hand.
- **"cannot start \<cli\>: Executable not found in $PATH"** — that provider CLI isn't
  installed in the guest; current recipes install all seven. Reported to the user as
  "\<provider\>: `\<cli\>` is not installed on the remote host".
- Tests override the pieces: `BOTO_LIMA_COMMAND` (fake `limactl`, JSON array),
  `BOTO_LIMA_INSTANCE` (instance name), `BOTO_VM_READY_FILE` (provisioned probe),
  `BOTO_VM_READY_TIMEOUT_MS` / `BOTO_VM_READY_POLL_MS` (provisioning wait),
  `BOTO_SSH_COMMAND` (fake ssh). See `packages/daemon/test/localvm.e2e.test.ts`.
