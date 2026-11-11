# Remote hosts, Firecracker, subagents

Operator setup and guest image build: [docs/remote-hosts.md](../remote-hosts.md).

`src/remote/hosts.ts` (`HostStore`, migration 14: `hosts`, `agent_placement`, `subagents`).
RPC `hosts.list/create/delete/install/check`, `placements.list/set`, `subagents.list`;
events `hosts.changed`, `placement.updated`, `subagent.updated`; UI `components/HostsView.tsx`
(Settings → Hosts). SSH runs the system `ssh` with `BatchMode=yes`,
`StrictHostKeyChecking=accept-new`, keepalives, `-p`, optional `-i`, then `--` and the target
(validated by `SshTarget`, so it cannot be an option); remote commands are single-quoted.
`BOTO_SSH_COMMAND` (JSON array) replaces `ssh` (tests: `test/fixtures/fake-ssh.ts`,
`$FAKE_SSH_HOME`, `$FAKE_SSH_LOG`, targets `unreachable*` fail). Install uploads
`packages/host/src/main.ts` (embedded as text) to
`${BOTO_HOST_ROOT:-$HOME/.boto}/bin/boto-host.ts` and runs `preflight`; install and
check honor the same remote `BOTO_HOST_ROOT`. When an agent's placement has a host,
`AgentRuntime` passes a `RemoteLaunch` to
the driver: the provider command is spawned as `ssh -R <sock>:127.0.0.1:<daemon port> ...
boto-host run` (first stdin line = RunSpec JSON), and the `boto` MCP server becomes
`boto-host bridge` on the host (POSTs `/bridge` through the forwarded socket). Changing a
placement drops the provider session. Firecracker placement requires a host whose preflight
says `firecrackerReady` (Linux + /dev/kvm + firecracker + vmlinux + rootfs.ext4 + `mkfs.ext4`,
with no stale guest helper);
there is no fallback. Build the guest from a checkout with
`bash packages/host/rootfs/build-rootfs.sh`; the host needs Docker, curl, sudo and e2fsprogs,
and the user needs `/dev/kvm` access (`sudo usermod -aG kvm "$USER"`, then re-login).
`packages/host` (`boto-host run` with `isolation: "firecracker"`) boots one VM per session
(`firecracker --no-api --config-file`, fresh root disk copied from the base rootfs, vCPU 1-32,
memory 256-65536 MiB) and gives each agent a persistent sparse `workspace.ext4` (default
8192 MiB, configurable with `BOTO_VM_WORKSPACE_MIB`) mounted at `/persist`, with `/workspace`
and `/root` bind-mounted from it. It connects vsock 1024 for provider stdio, serves guest vsock
5000 (bridge) and 3128 (CONNECT proxy), syncs storage when a provider exits, and removes the
per-run root disk on session end. With `setpriv` installed, Firecracker runs with
`--pdeathsig KILL`. On the Linux x86*64/KVM test host, boot to first guest output measured 1.7
seconds. The proxy resolves DNS once, rejects a hostname if any IPv4 answer is non-public, and
connects to the approved address. CONNECT requests are audited at `vms/<agentId>/proxy.log`
(rotated to `.1` above 1 MiB) with allow/deny decisions plus `connected`/`upstream error`
outcomes per destination; provider processes drop inherited `BOTO*\*` variables while
retaining explicit RunSpec env.
MicroVM sign-in (`src/remote/credentials.ts`): `vmCredentials.list/set/delete`store`vmcred.<provider>`in the vault (hidden from`vault.list`, never on an allowlist):
claude `oauth_token`->`CLAUDE_CODE_OAUTH_TOKEN`, `api_key`->`ANTHROPIC_API_KEY`; codex
`api_key`->`OPENAI_API_KEY`+`CODEX_API_KEY`. `HostStore.launchFor`adds them to`RemoteLaunch.credentials`and the RunSpec env only for`firecracker`and`localvm`placements (both start signed out); when Codex
reports signed out and a key is present the driver calls`account/login/start {type:"apiKey"}`.
Credentialed Codex sessions set `CODEX_HOME=/run/boto/codex-home`on guest tmpfs; fake-key
runs found no`/root/.codex/auth.json`on the persistent workspace. Fake`OPENAI_API_KEY`or`CODEX_API_KEY`alone left`account/read`signed out. Rejected credentials surface a redacted
provider detail and a Settings → Hosts prompt. Tests:`test/vm-credentials.test.ts`and`bun run test:firecracker:providers`(real SSH/Firecracker, fake Claude API/OAuth and Codex
keys, persistence and leak checks). Codex's home/thread cache is ephemeral; the driver falls
back to`thread/start`if a thread cannot be resumed.
Guest image:`packages/host/rootfs/` (`boto-init`, `build-rootfs.sh`); run the real host and
SSH integration tests with `bun run test:firecracker`on a Linux Firecracker host; signed-out
real Claude/Codex flows use`bun run test:firecracker:providers`. `--base <image>`overrides`BOTO_ROOTFS_BASE`; defaults try Debian Hub, mirror.gcr.io, then public ECR, selecting the
first cached or pullable image. This host's default-provider build selected Debian Hub and took
1m 0s: rootfs 4.0 GiB apparent / 1.6 GiB allocated, 1643 MiB ext4 used; Docker image 2.35 GB
disk usage / 775 MB content size. Re-run the build after updating or reinstalling the helper;
preflight reports `guestHelperCurrent`.
Subagents (`src/subagents.ts`): bridge `spawn_subagents {tasks:[{task,name?}], provider?,
keep?}`(max 8 per call,`BOTO_MAX_SUBAGENTS`running per parent, default 8, depth 2)
creates child agents that inherit the parent's placement, sends each its task, and when the
whole batch has ended delivers one`<subagent_results>`message to the parent; non-kept
children are then deleted (stopping their process/VM).`list_subagents`, `stop_subagent`.
Tests: `test/remote.e2e.test.ts`, `packages/host/test/host.test.ts`.

## Local Linux VM (`localvm.*`)

Operator guide: [docs/local-vm.md](../local-vm.md). `src/remote/localvm.ts`
(`LocalVmService`) manages one Lima instance (default `boto-computer`,
`BOTO_LIMA_INSTANCE` to rename) from the recipe `vm/boto-computer.yaml`, embedded into the
daemon binary and materialized under `<dataDir>/vm/` on create. RPC
`localvm.status/create/start/stop/delete/install`, event `localvm.changed`;
`LocalVmStatus` carries `available` (limactl works), `state`
(`absent|stopped|running|broken`), `busy`, `installed`, `hostId` and the last error
`detail`. The instance registers as a hosts row via `HostStore.upsertLocalVm`
(`kind: "localvm"`, `instance`, `lima@127.0.0.1:<sshLocalPort>`, Lima's IdentityFile —
migration 33 adds `hosts.kind`/`hosts.instance`, defaulting to `"ssh"`); `syncHost`
re-reads `limactl list --json` after every lifecycle call and once at boot (`localvm.sync`,
failures logged, never fatal). Placements on that row use `isolation: "none"` — the whole
VM is the boundary — so providers launch through the unchanged ssh + `boto-host run` path,
the bridge uses the same `-R` forward, and `remoteLaunch` merges the saved microVM
credentials into the RunSpec env (`credentialed = vm || kind === "localvm"`).
`create`/`start` are serialized under a `busy` label; `start` boots first if needed, then
`prepare` polls the guest's `/var/lib/boto-computer-provisioned` marker over ssh (15 min,
3 s) and runs `hosts.install` — first boot provision installs the desktop (Xvfb :0 +
Openbox + scrot/xdotool + Chromium CDP 9222 + noVNC 6080), Node 22, Bun and the provider
CLIs. Overrides: `BOTO_LIMA_COMMAND` (JSON array), `BOTO_VM_READY_FILE` (probe path);
tests `test/localvm.test.ts`, `test/localvm.e2e.test.ts` + `fixtures/fake-limactl.ts`
(`FAKE_LIMA_HOME`, `FAKE_LIMA_LOG`). Settings → Computador (`settings/LocalVm.tsx`) shows
status/actions; the bot panel offers **VM local** in "Onde ele trabalha".

## Live guest desktop (`desktop.*`)

Agents placed in a Firecracker microVM get a real desktop: `boto-init` starts `Xvfb :0`
(`1280x800x24`, override with `BOTO_DESKTOP_GEOMETRY`), Openbox and a `socat` listener on
vsock **5900** that runs `boto-host guest-desktop`. The guest hostname is the machine name
passed by `boto-host run` on the kernel command line (`boto.name=<slug>`, `RunSpec.machineName`).

- **Host side** (`packages/host/src/main.ts`): `boto-host desktop` reads `{agentId}` on the
  first stdin line, waits for the agent's running microVM (`vms/<id>/r*/firecracker.pid`,
  `BOTO_DESKTOP_CONNECT_TIMEOUT_MS`, default 90 s), connects to vsock 5900 and relays NDJSON
  both ways. `guest-desktop` captures frames with `scrot` (JPEG q60, ≤10 fps, only while a
  `stream` message asked for it) plus a 20 % thumbnail every `thumbEveryMs`, drives the
  display with `xdotool` and emits `cursor {x,y,kind}` after agent actions. It keeps its own
  controller state (`controller` messages) and refuses `input` (user) unless the controller
  is the user and `agent`/`screenshot` unless it is the agent, so a stale daemon can never
  move the pointer behind the user's back. Exported helpers (`encodeDesktopMessage`,
  `DesktopDecoder`, `validateDesktopEvents`, `DesktopControllerState`) are unit-tested in
  `packages/host/test/host.test.ts`; the gated real test boots a guest and checks frames,
  pointer movement and refusal.
- **Wire** (`daemon → guest`): `stream {fps,thumbEveryMs}`, `controller {controller}`,
  `input {events}`, `agent {id,events}`, `screenshot {id}`. (`guest → daemon`):
  `ready {width,height,name}`, `frame {seq,mime,data,width,height}`, `thumb {...}`,
  `cursor {x,y,kind}`, `done {id,text}`, `error {id?,code}`. Lines are capped at 8 MiB.
- **Daemon** (`packages/daemon/src/desktop.ts`, `DesktopService`): one `Machine` per agent
  with a `firecracker` or `localvm` placement, named `<agent-slug>-NN` (persisted in
  `machines`, migration 23; `HostStore.machineNameFor` feeds the name into the run spec).
  It spawns `ssh … bun ~/.boto/bin/boto-host.ts desktop` for Firecracker (vsock relay) or,
  on a `localvm` host, `DISPLAY=:0 … boto-host.ts guest-desktop` inside the guest itself
  (no `desktop` relay, no `{agentId}` intro line). Tests override the command with
  `BOTO_DESKTOP_COMMAND`, a JSON array) lazily on subscribe/thumbnail/agent action and when
  `agent.status` turns running. Frames are forwarded only to connections that called
  `desktop.subscribe` for that machine (`Rpc.handle(raw, {id})` carries the WebSocket
  connection id; `main.ts` attaches/detaches connections). Throttle: ≤10 fps; the guest only
  grabs frames while someone is subscribed, thumbnails every 5 s otherwise.
- **Control**: `controller` is `agent` until a connection calls `desktop.takeover`
  ("Assumir o controle"); the owning connection alone may `desktop.input`; `desktop.release`
  ("Devolver ao Boto"), the owner disconnecting or the stream ending hand control back.
  While the user controls, `ComputerUse` calls routed through `computer.remote` (set to
  `DesktopService.remoteComputer`) throw so the agent waits, and pending `takeover`
  approvals are completed with `done` on release (the bridge `request_takeover` flow).
  Machine events (`desktop.machine`) are broadcast like `placement.updated`; frames and
  cursors never leave their subscribers.
- **Agent Computer Use in a microVM**: screenshots are written inside the guest
  (`/workspace/computer/screen-<ts>.png`) so the provider running there can read them;
  clicks/typing/keys become `agent` events and surface as `desktop.cursor`.
- Tests: `packages/daemon/test/desktop.test.ts` (in-process service with
  `fixtures/fake-desktop-host.ts`), `packages/daemon/test/desktop.e2e.test.ts` (daemon,
  fake ssh, `fixtures/fake-boto-host-ready.ts` makes preflight report Firecracker ready).
