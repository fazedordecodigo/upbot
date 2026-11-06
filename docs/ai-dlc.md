# AWS AI-DLC in this repository

This repo uses the official [AWS AI-DLC workflows](https://github.com/awslabs/aidlc-workflows)
(AI-Driven Development Life Cycle) as development guidance for Cursor. Boto's
application behavior stays as it is. The installed release is
`awslabs/aidlc-workflows`, which is separate from the AWS SDK and from the
Python `boto` package.

The product architecture in [AGENTS.md](../AGENTS.md) stays in force. The
AI-DLC block at the bottom of that file, between `<!-- BEGIN AI-DLC:agents -->`
and `<!-- END AI-DLC:agents -->`, is owned by the installer. Leave that block,
the `# BEGIN AI-DLC:gitignore` block in `.gitignore`, and the generated trees
under `.cursor/` and `aidlc/` as the installer wrote them. The next refresh
treats a hand edit of those files as a local modification and stops.

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/awslabs/aidlc-workflows |
| Release | [v2.11.3](https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.3) |
| Docs | https://awslabs.github.io/aidlc-workflows/ |
| AWS post | https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/ |
| Installed by | `aidlc config --harness cursor` from the native 2.11.3 runtime |
| Project pin | `.aidlc-version` (`2.11.3`) |
| Stamp | `.cursor/tools/data/aidlc-stamp.json` |

The native installer for that tag verifies `checksums.txt` and
`aidlc-release.intoto.jsonl`. With a GitHub CLI that supports
`attestation verify --signer-workflow`, `--source-ref`, and `--source-digest`,
it also checks the release attestation against `awslabs/aidlc-workflows` on
github.com and `refs/tags/v2.11.3`. This checkout was installed that way on
Linux x64.

`v2.11.3` is the current stable release. The relative `docs/guide/` and
`docs/reference/` paths inside the generated onboarding point at that upstream
repository, published at https://awslabs.github.io/aidlc-workflows/. They are
not files in this repo.

## License

Boto itself stays under the MIT license in [LICENSE](../LICENSE).

The AI-DLC files (the `.cursor/` workflow tree and the `aidlc/` method shell)
come from Amazon's `awslabs/aidlc-workflows` and are
[MIT No Attribution (MIT-0)](https://github.com/awslabs/aidlc-workflows/blob/v2.11.3/LICENSE),
copyright Amazon.com, Inc. or its affiliates. MIT-0 does not require the
copyright notice to be copied, and the generated files do not carry per-file
headers. The upstream license text is kept at
[aidlc-LICENSE.txt](aidlc-LICENSE.txt) so those files are not read as part of
Boto's MIT license. Do not remove it when refreshing AI-DLC.

## What is installed

Cursor is the only harness configured. This repository had no Claude Code,
Codex, Kiro, opencode, or Copilot instruction files; contributor guidance
already lives in `AGENTS.md`, which Cursor reads. `aidlc config` merged its
block into the existing `AGENTS.md` and `.gitignore` instead of replacing them.

- `.cursor/` — Cursor rules, skills, agents, hooks, and the engine. Start with
  `.cursor/rules/aidlc-onboarding.mdc` (`alwaysApply: true`).
- `aidlc/spaces/default/memory/` — the method the engine reads. `project.md`
  is still the upstream template. It was not filled in with Boto requirements.
- `.aidlc-version` — the committed pin.

Git ignores per-user cursors and machine-local runtime state, including
`aidlc/active-memory/` and `aidlc/.aidlc-sessions/`. The `aidlc` command
itself is per-user (`$HOME/.local/bin/aidlc` on macOS and Linux) and is not
committed.

Biome does not format or lint `.cursor/` or `aidlc/`. Those trees are
upstream-owned; reformatting them would make `aidlc config` refuse the next
refresh. Application sources stay on the existing Biome rules.

## Install the command

Each machine needs the `aidlc` command that matches `.aidlc-version`. Hooks
call that command. This native install does not use Bun.

macOS, Linux, or WSL, pinned to the committed release:

```sh
version=$(tr -d '[:space:]' < .aidlc-version)
tmp=$(mktemp -d)
curl -fsSL "https://github.com/awslabs/aidlc-workflows/releases/download/v${version}/install.sh" -o "$tmp/install.sh"
sh "$tmp/install.sh" --version "$version"
rm -rf "$tmp"
export PATH="$HOME/.local/bin:$PATH"
```

The Unix installer does not edit a shell profile. Add `$HOME/.local/bin` to
the PATH of any shell you use. If Cursor was already open, quit it fully and
reopen it so hooks see `aidlc`. A new tab is not enough. Windows uses
`install.ps1` from the same release; see the upstream
[Install and Lifecycle](https://awslabs.github.io/aidlc-workflows/guide/18-install-and-lifecycle/)
guide.

From the repo root:

```sh
aidlc doctor
```

`aidlc doctor` should report no failures. One environmental warning is
normal on macOS and Linux: `aidlc` is on the shell PATH but not on the
system-wide PATH, so a Cursor app launched from a desktop icon may not see it.
The Cursor CLI (`cursor` on PATH) is optional; the IDE reads the same
`.cursor/` tree.

A clone already contains the workflow. Run `aidlc config --harness cursor`
only when doctor says the workspace shell or `aidlc/active-memory/` copy is
missing. That refresh keeps the pin and the existing Boto text outside the
managed blocks.

## Start a workflow

In Cursor chat, describe the work with the AI-DLC command:

```text
/aidlc <what you want changed>
```

Useful checks, which do not advance a workflow:

- `/aidlc --doctor`
- `/aidlc --status` or `/aidlc-status`
- `/aidlc-jump --stage <slug>` or `--phase <name>`
- `/aidlc-scope <name>`

AI-DLC asks for missing decisions and stops at approval gates. Answer those in
the chat. Artifacts for a piece of work land under
`aidlc/spaces/default/intents/`. Commit that record with the code, as the
managed `AGENTS.md` block describes.

Headless `agent -p` runs can use the read-only commands. They cannot pass an
approval gate, because Cursor only records a human turn for an interactive
submission.

This install does not start a lifecycle. Ask for `/aidlc` when the work should
follow the workflow.

## Update

Finish any open AI-DLC workflow before changing the project files. Upstream's
troubleshooting entry for a project/runtime version skew is: finish the active
workflow, then run `aidlc config`.

1. Install the release you want on this machine: `aidlc update` for the newest
   stable release, or `aidlc update --version X.Y.Z` for an exact one.
2. Point this repo at it and refresh the Cursor files:

```sh
aidlc config --pin X.Y.Z
aidlc config --harness cursor
aidlc doctor
```

3. Commit `.aidlc-version` and the files the refresh changed. Do not edit the
   generated trees by hand.

`aidlc config --pin` switches the engine immediately and leaves the project
files as they were until `aidlc config --harness cursor`. If those two
versions differ, the pin command says to run `aidlc config` to finish.

## Other harnesses

These were not installed. Add one later only if people actually use it:

| Harness | Command | Invoke |
| --- | --- | --- |
| Claude Code | `aidlc config --harness claude` | `/aidlc` |
| Kiro | `aidlc config --harness kiro-ide` | `/aidlc` |
| Kiro CLI | `aidlc config --harness kiro` | `/aidlc` |
| Codex CLI | `aidlc config --harness codex` | `$aidlc` |
| opencode | `aidlc config --harness opencode` | `/aidlc` |

Those Kiro names are the ones in the 2.11.3 release (`version.json` product
names). Later docs on `main` swap them and add `kiro-v2`. Use the names this
pin accepts.

GitHub Copilot cannot be added beside Cursor. Copilot owns the whole
`AGENTS.md` file, and Cursor shares a marked block with the other harnesses
above. Upstream refuses that combination.
