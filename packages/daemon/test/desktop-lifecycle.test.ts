import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import { migrations } from "../src/db/migrations";
import { DesktopService } from "../src/desktop";
import { HostStore } from "../src/remote/hosts";

async function withDesktop(
  run: (desktop: DesktopService, db: Database, id: string) => Promise<void>,
) {
  const old = process.env.BOTO_DESKTOP_COMMAND;
  process.env.BOTO_DESKTOP_COMMAND = JSON.stringify([
    process.execPath,
    join(import.meta.dir, "fixtures/fake-desktop-host.ts"),
  ]);
  const db = new Database(":memory:");
  for (const sql of migrations) db.exec(sql);
  db.query(
    "INSERT INTO agent_placement (agent_id, host_id, isolation, vcpus, mem_mib) VALUES ('bot', 'host-a', 'firecracker', 2, 2048)",
  ).run();
  const desktop = new DesktopService(
    db,
    new HostStore(db),
    () => ({ id: "bot", name: "Bot" }) as Agent,
    () => {},
  );
  desktop.attach("viewer", () => {});
  const id = desktop.list()[0]!.id;
  try {
    desktop.subscribe(id, "viewer");
    await desktop.thumbnail(id);
    await run(desktop, db, id);
  } finally {
    desktop.stop();
    db.close();
    if (old === undefined) delete process.env.BOTO_DESKTOP_COMMAND;
    else process.env.BOTO_DESKTOP_COMMAND = old;
  }
}

test("host transfer invalidates the old stream, dimensions and thumbnail and reconnects a viewer", async () => {
  await withDesktop(async (desktop, db, id) => {
    const previous = await desktop.thumbnail(id);
    db.query("UPDATE agent_placement SET host_id = 'host-b' WHERE agent_id = 'bot'").run();
    expect(desktop.list()[0]).toMatchObject({
      hostId: "host-b",
      width: 0,
      height: 0,
      thumbnailAt: null,
    });
    expect(
      (db.query("SELECT host_id FROM machines WHERE id = ?").get(id) as { host_id: string })
        .host_id,
    ).toBe("host-b");
    expect((await desktop.thumbnail(id)).at).not.toBe(previous.at);
  });
}, 10_000);

test("a stopped guest cannot supply its old thumbnail to a later request", async () => {
  await withDesktop(async (desktop, _db, id) => {
    const previous = await desktop.thumbnail(id);
    desktop.unsubscribe(id, "viewer");
    expect(desktop.list()[0]).toMatchObject({
      status: "stopped",
      thumbnailAt: null,
      width: 0,
      height: 0,
    });
    expect((await desktop.thumbnail(id)).at).not.toBe(previous.at);
  });
}, 10_000);

test("a guest ready message invalidates any image from the prior guest identity", async () => {
  await withDesktop(async (desktop, _db, id) => {
    const internal = desktop as unknown as {
      states: Map<string, { child: ChildProcess }>;
      onGuestMessage(state: unknown, child: ChildProcess, message: unknown): void;
    };
    const state = internal.states.get(id)!;
    internal.onGuestMessage(state, state.child, { type: "ready", width: 640, height: 480 });
    expect(desktop.list()[0]).toMatchObject({ width: 640, height: 480, thumbnailAt: null });
    expect(await desktop.thumbnail(id)).toMatchObject({ mime: "image/jpeg" });
  });
}, 10_000);
