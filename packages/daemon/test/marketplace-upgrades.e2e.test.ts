import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

async function registryTest(
  run: (
    client: DaemonClient,
    source: string,
    root: string,
    registry: {
      skill: (id: string, body: string) => void;
      plugin: (id: string, skills: string[]) => void;
    },
  ) => Promise<void>,
) {
  const root = tmp("marketplace-upgrade-");
  const items = new Map<string, object>();
  const files = new Map<string, string>();
  const registry = {
    skill(id: string, body: string) {
      const raw = `---\nname: ${id}\n---\n${body}\n`;
      files.set(`${id}.md`, raw);
      items.set(id, {
        id,
        kind: "skill",
        name: id,
        url: `${id}.md`,
        sha256: createHash("sha256").update(raw).digest("hex"),
      });
    },
    plugin(id: string, skills: string[]) {
      items.set(id, { id, kind: "plugin", skills });
    },
  };
  registry.skill("review-a", "version one");
  registry.skill("review-b", "second skill");
  registry.plugin("review-bundle", ["review-a"]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname.slice(1);
      return path === "index.json"
        ? Response.json({ items: [...items.values()] })
        : new Response(files.get(path) ?? "missing");
    },
  });
  const source = `http://127.0.0.1:${server.port}/index.json`;
  const token = crypto.randomUUID();
  const daemon = await startDaemon(join(root, "data"), join(root, "agents"), token, {
    BOTO_MARKETPLACE_URL: source,
    BOTO_SHARED_ROOT: join(root, "shared"),
    BOTO_VAULT_KEY: "33".repeat(32),
  });
  const client = await DaemonClient.connect(daemon.port, token);
  try {
    await run(client, source, root, registry);
  } finally {
    server.stop(true);
    await stopDaemon(daemon, client);
    await removeDir(root);
  }
}

test("builtin marketplace uninstall disconnects the app and clears its installed state", async () => {
  await registryTest(async (client) => {
    const source = "builtin:apps";
    await client.request("marketplace.install", {
      source,
      id: "github",
      secrets: { GITHUB_TOKEN: "fake-upgrade-token" },
    });
    expect((await client.request("apps.list", {})).some((app) => app.catalogId === "github")).toBe(
      true,
    );
    await client.request("marketplace.uninstall", { source, id: "github" });
    expect((await client.request("apps.list", {})).some((app) => app.catalogId === "github")).toBe(
      false,
    );
    expect(await client.request("marketplace.get", { source, id: "github" })).toMatchObject({
      installed: false,
    });
    await expect(
      client.request("marketplace.uninstall", { source, id: "github" }),
    ).resolves.toMatchObject({ ok: true });
  });
}, 30_000);

test("expanded plugins require every current registry skill before appearing installed", async () => {
  await registryTest(async (client, source, _root, registry) => {
    await client.request("marketplace.install", { source, id: "review-bundle" });
    registry.plugin("review-bundle", ["review-a", "review-b"]);
    expect(await client.request("marketplace.get", { source, id: "review-bundle" })).toMatchObject({
      installed: false,
    });
    await client.request("marketplace.install", { source, id: "review-bundle" });
    expect(await client.request("marketplace.get", { source, id: "review-bundle" })).toMatchObject({
      installed: true,
    });
    expect((await client.request("skills.get", { name: "review-b" })).body.trim()).toBe(
      "second skill",
    );
  });
}, 30_000);

test("legacy plugins remain visible without claiming ownership of preexisting skills", async () => {
  await registryTest(async (client, source, root) => {
    await client.request("marketplace.install", { source, id: "review-bundle" });
    const db = new Database(join(root, "data", "boto.db"));
    db.query("DELETE FROM marketplace_artifacts").run();
    db.query("DELETE FROM marketplace_installations").run();
    db.close();
    expect(await client.request("marketplace.get", { source, id: "review-bundle" })).toMatchObject({
      installed: true,
    });
    await expect(
      client.request("marketplace.uninstall", { source, id: "review-bundle" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect((await client.request("skills.get", { name: "review-a" })).body.trim()).toBe(
      "version one",
    );
    await client.request("marketplace.install", { source, id: "review-bundle" });
    await client.request("marketplace.uninstall", { source, id: "review-bundle" });
    expect(await client.request("marketplace.get", { source, id: "review-bundle" })).toMatchObject({
      installed: false,
    });
    expect((await client.request("skills.get", { name: "review-a" })).body.trim()).toBe(
      "version one",
    );
  });
}, 30_000);

test("unmanaged legacy skills are preserved with an explicit error instead of a successful removal", async () => {
  await registryTest(async (client, source) => {
    await client.request("skills.save", {
      name: "review-a",
      description: "User skill",
      body: "keep me",
    });
    await expect(
      client.request("marketplace.uninstall", { source, id: "review-a" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect((await client.request("skills.get", { name: "review-a" })).body.trim()).toBe("keep me");
  });
}, 30_000);

test("skill reinstall updates owned unmodified content and refuses to overwrite user edits", async () => {
  await registryTest(async (client, source, _root, registry) => {
    await client.request("marketplace.install", { source, id: "review-a" });
    registry.skill("review-a", "version two");
    await client.request("marketplace.install", { source, id: "review-a" });
    expect((await client.request("skills.get", { name: "review-a" })).body.trim()).toBe(
      "version two",
    );
    await client.request("skills.save", {
      name: "review-a",
      description: "User",
      body: "user revision",
    });
    registry.skill("review-a", "version three");
    await expect(
      client.request("marketplace.install", { source, id: "review-a" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect((await client.request("skills.get", { name: "review-a" })).body.trim()).toBe(
      "user revision",
    );
  });
}, 30_000);

test("updated owned skills retain provenance for a later safe uninstall", async () => {
  await registryTest(async (client, source, _root, registry) => {
    await client.request("marketplace.install", { source, id: "review-a" });
    registry.skill("review-a", "upgraded content");
    await client.request("marketplace.install", { source, id: "review-a" });
    await client.request("marketplace.uninstall", { source, id: "review-a" });
    await expect(client.request("skills.get", { name: "review-a" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await client.request("marketplace.get", { source, id: "review-a" })).toMatchObject({
      installed: false,
    });
  });
}, 30_000);
