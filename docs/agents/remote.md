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
`--pdeathsig KILL`. On the Linux x86_64/KVM test host, boot to first guest output measured 1.7
seconds. The proxy resolves DNS once, rejects a hostname if any IPv4 answer is non-public, and
connects to the approved address. CONNECT requests are audited at `vms/<agentId>/proxy.log`
(rotated to `.1` above 1 MiB) with allow/deny decisions plus `connected`/`upstream error`
outcomes per destination; provider processes drop inherited `BOTO_*` variables while
retaining explicit RunSpec env.
MicroVM sign-in (`src/remote/credentials.ts`): `vmCredentials.list/set/delete` store
`vmcred.<provider>` in the vault (hidden from `vault.list`, never on an allowlist):
claude `oauth_token` -> `CLAUDE_CODE_OAUTH_TOKEN`, `api_key` -> `ANTHROPIC_API_KEY`; codex
`api_key` -> `OPENAI_API_KEY` + `CODEX_API_KEY`. `HostStore.launchFor` adds them to
`RemoteLaunch.credentials` and the RunSpec env only for `firecracker` placements; when Codex
reports signed out and a key is present the driver calls `account/login/start {type:"apiKey"}`.
Credentialed Codex sessions set `CODEX_HOME=/run/boto/codex-home` on guest tmpfs; fake-key
runs found no `/root/.codex/auth.json` on the persistent workspace. Fake `OPENAI_API_KEY` or
`CODEX_API_KEY` alone left `account/read` signed out. Rejected credentials surface a redacted
provider detail and a Settings → Hosts prompt. Tests: `test/vm-credentials.test.ts` and
`bun run test:firecracker:providers` (real SSH/Firecracker, fake Claude API/OAuth and Codex
keys, persistence and leak checks). Codex's home/thread cache is ephemeral; the driver falls
back to `thread/start` if a thread cannot be resumed.
Guest image: `packages/host/rootfs/` (`boto-init`, `build-rootfs.sh`); run the real host and
SSH integration tests with `bun run test:firecracker` on a Linux Firecracker host; signed-out
real Claude/Codex flows use `bun run test:firecracker:providers`. `--base <image>` overrides
`BOTO_ROOTFS_BASE`; defaults try Debian Hub, mirror.gcr.io, then public ECR, selecting the
first cached or pullable image. This host's default-provider build selected Debian Hub and took
1m 0s: rootfs 4.0 GiB apparent / 1.6 GiB allocated, 1643 MiB ext4 used; Docker image 2.35 GB
disk usage / 775 MB content size. Re-run the build after updating or reinstalling the helper;
preflight reports `guestHelperCurrent`.
Subagents (`src/subagents.ts`): bridge `spawn_subagents {tasks:[{task,name?}], provider?,
keep?}` (max 8 per call, `BOTO_MAX_SUBAGENTS` running per parent, default 8, depth 2)
creates child agents that inherit the parent's placement, sends each its task, and when the
whole batch has ended delivers one `<subagent_results>` message to the parent; non-kept
children are then deleted (stopping their process/VM). `list_subagents`, `stop_subagent`.
Tests: `test/remote.e2e.test.ts`, `packages/host/test/host.test.ts`.
