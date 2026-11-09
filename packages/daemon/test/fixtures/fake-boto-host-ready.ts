#!/usr/bin/env bun
// Stand-in for the uploaded remote helper in tests: `preflight` reports a Firecracker-ready
// host (so `placements.set` accepts isolation "firecracker" on machines without KVM); every
// other subcommand is forwarded to the real helper source.
import { join } from "node:path";

const REAL = join(import.meta.dir, "../../../host/src/main.ts");
const cmd = process.argv[2];
if (cmd === "preflight") {
  process.stdout.write(
    `${JSON.stringify({
      root: process.env.BOTO_HOST_ROOT ?? `${process.env.HOME}/.boto`,
      os: "linux",
      arch: "x86_64",
      kernelRelease: "6.1.0-fake",
      bun: Bun.version,
      kvm: true,
      firecracker: { path: "/usr/local/bin/firecracker", version: "v1.12.1" },
      kernelImage: "vmlinux",
      rootfs: "rootfs.ext4",
      mkfsExt4: "/usr/sbin/mkfs.ext4",
      guestHelperCurrent: true,
      providers: {},
      firecrackerReady: true,
    })}\n`,
  );
} else {
  const child = Bun.spawn(["bun", REAL, ...process.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
