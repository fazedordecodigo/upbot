# Local Linux VM (Lima)

Boto can run bots inside a **complete local Linux VM** on your Mac — a full Debian 12
desktop, not a container or a microVM. It is managed by [Lima](https://lima-vm.io) on top of
Apple's Virtualization framework (`vmType: vz`), so it needs macOS 13+ and Apple Silicon or
an Intel Mac with `vz` support.

## Prerequisites

```sh
brew install lima
```

That's all — the daemon materializes the versioned recipe (`vm/boto-computer.yaml`) into its
data dir and drives `limactl` itself.

## Lifecycle

Everything lives under **Settings → Computador**: status (Lima availability, instance,
install state, last error) and the actions **Criar**, **Ligar**, **Desligar**, **Instalar
helper** and **Apagar**. The same operations exist over RPC as
`localvm.status/create/start/stop/delete/install`, with `localvm.changed` events.

- **Criar** registers the `boto-computer` instance and syncs a hosts row
  (`kind: "localvm"`, `lima@127.0.0.1:<sshLocalPort>`) so the VM can be a placement target.
- **Ligar** boots the instance (creating it first when needed) and, in the background, waits
  for provisioning to finish — first boot installs Debian packages, Node 22, Bun and the
  provider CLIs — then uploads `boto-host` and runs its preflight. The marker
  `/var/lib/boto-computer-provisioned` records a finished provision.
- **Instalar helper** re-uploads the host helper after an upgrade.
- **Apagar** stops (if running), deletes the Lima instance and removes the hosts row and any
  placements pointing at it. The shared folders under `~/Boto/computer/` are kept.

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

- Debian 12 (cloud image, arm64 on Apple Silicon), 2 vCPUs / 4 GiB / 20 GiB.
- Xvfb `:0` (`1280x800x24`) + Openbox (`boto-xvfb`, `boto-desktop` systemd units), xdotool,
  scrot — the pieces `boto-host guest-desktop` needs for the live desktop.
- Chromium maximized with DevTools on `127.0.0.1:9222`, forwarded to the Mac as
  `127.0.0.1:47222` for Playwright/CDP.
- noVNC on `127.0.0.1:47080` (`boto-vnc` + `boto-novnc`) as a direct/debug view; the
  password is generated at `~/Boto/computer/shared/vnc-password`.
- Provider CLIs (`claude`, `codex`), Node 22 and Bun, all checksum-verified at provision
  time; git, curl, jq, python3, ffmpeg, ImageMagick, build tools.

## Storage and sharing

| Guest path   | Mac path                     | Mode      |
| ------------ | ---------------------------- | --------- |
| `/workspace` | `~/Boto/computer/workspace`  | read/write |
| `/mnt/boto`  | `~/Boto/computer/shared`     | read-only |

`/workspace` (virtiofs) is where files the bot hands back should land. `/mnt/boto` is for
host→guest inputs like the VNC password — the guest cannot write it.

## Network restrictions

All other guest→Mac port forwards are disabled (`guestPortRange … ignore: true`), and a
guest-side iptables chain rejects traffic to `host.lima.internal` (the Mac's own loopback —
admin panel, voice server) except replies, DNS and DHCP. The VM can reach the internet but
not services on this Mac; Boto itself goes through the Lima SSH channel.

## Live desktop

Subscribing to the bot's machine in **LiveDesk** spawns
`ssh … DISPLAY=:0 boto-host guest-desktop` — the same scrot/xdotool NDJSON pipeline used for
Firecracker microVMs, so frames (≤10 fps), thumbnails, cursor events, takeover/release and
agent Computer Use all work identically. noVNC remains available at
`http://127.0.0.1:47080` for a smoother human-driven session.

## Troubleshooting

- **"Lima não está instalada"** — `brew install lima`, then reopen Settings → Computador.
- **"Preparando a VM…"** stuck — first boot provisioning can take several minutes; watch
  `limactl shell boto-computer -- sudo journalctl -u cloud-final -f`. If it never finishes,
  `limactl stop`/`start` re-runs the provision step (it's guarded by the marker file).
- **State "broken"** — Lima reports an unexpected status; `limactl list` shows the raw
  value. `Apagar` + `Criar` rebuilds the instance (shared folders survive).
- **Provider won't launch / machine shows error** — the helper may be missing or stale;
  run **Instalar helper**.
- Tests override the pieces: `BOTO_LIMA_COMMAND` (fake `limactl`, JSON array),
  `BOTO_LIMA_INSTANCE` (instance name), `BOTO_VM_READY_FILE` (provision marker),
  `BOTO_SSH_COMMAND` (fake ssh). See `packages/daemon/test/localvm.e2e.test.ts`.
