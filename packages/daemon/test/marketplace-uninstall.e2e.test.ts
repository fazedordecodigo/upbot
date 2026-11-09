import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient, removeDir, startDaemon, stopDaemon, tmp } from "./helpers";

test("marketplace uninstall preserves shared, preexisting, modified and unrelated artifacts across restart", async () => {
  const dirs = [tmp("uninstall-data-"), tmp("uninstall-agents-"), tmp("uninstall-shared-")];
  const names = ["owned", "shared", "modified", "preexisting"];
  const files: Record<string, string> = Object.fromEntries(
    names.map((name) => [name, `---\nname: ${name}\n---\n${name} body\n`]),
  );
  const items = names.map((name) => ({
    id: name,
    kind: "skill",
    name,
    url: `${name}.md`,
    sha256: createHash("sha256").update(files[name]!).digest("hex"),
  }));
  files["bot.json"] = JSON.stringify({
    name: "Installed bot",
    provider: "devin",
    instructions: "Template instructions",
  });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1).replace(/\.md$/, "");
      return name === "index.json"
        ? Response.json({
            items: [
              ...items,
              { id: "first", kind: "plugin", skills: names },
              { id: "second", kind: "plugin", skills: ["shared"] },
              {
                id: "bot",
                kind: "agent",
                url: "bot.json",
                sha256: createHash("sha256").update(files["bot.json"]!).digest("hex"),
              },
            ],
          })
        : new Response(files[name] ?? "missing");
    },
  });
  const source = `http://127.0.0.1:${server.port}/index.json`;
  const token = crypto.randomUUID();
  const env = { BOTO_SHARED_ROOT: dirs[2]!, BOTO_MARKETPLACE_URL: source };
  let daemon = await startDaemon(dirs[0]!, dirs[1]!, token, env);
  let client = await DaemonClient.connect(daemon.port, token);
  try {
    await client.request("skills.save", {
      name: "preexisting",
      description: "mine",
      body: "original user skill",
    });
    await client.request("marketplace.install", { source, id: "first" });
    await client.request("marketplace.install", { source, id: "second" });
    await client.request("skills.save", {
      name: "modified",
      description: "changed",
      body: "user revision",
    });
    writeFileSync(join(dirs[2]!, "Skills", "owned", "notes.txt"), "unrelated user artifact");
    await stopDaemon(daemon, client);
    daemon = await startDaemon(dirs[0]!, dirs[1]!, token, env);
    client = await DaemonClient.connect(daemon.port, token);
    await client.request("marketplace.uninstall", { source, id: "first" });
    await expect(client.request("skills.get", { name: "owned" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(existsSync(join(dirs[2]!, "Skills", "owned", "notes.txt"))).toBe(true);
    expect(await client.request("skills.get", { name: "shared" })).not.toBeNull();
    expect((await client.request("skills.get", { name: "modified" })).body.trim()).toBe(
      "user revision",
    );
    expect((await client.request("skills.get", { name: "preexisting" })).body.trim()).toBe(
      "original user skill",
    );
    expect(await client.request("marketplace.get", { source, id: "first" })).toMatchObject({
      installed: false,
    });
    expect(await client.request("marketplace.get", { source, id: "second" })).toMatchObject({
      installed: true,
    });
    await client.request("marketplace.uninstall", { source, id: "first" });
    await expect(
      client.request("marketplace.uninstall", { source, id: "unknown" }),
    ).resolves.toMatchObject({ ok: true });
    await client.request("marketplace.uninstall", { source, id: "second" });
    expect(await client.request("skills.get", { name: "shared" })).not.toBeNull();
    const first = await client.request("marketplace.install", { source, id: "bot" });
    const second = await client.request("marketplace.install", { source, id: "bot" });
    await client.request("agents.update", { id: second.agent!.id, role: "User customization" });
    await client.request("marketplace.uninstall", { source, id: "bot" });
    const agents = await client.request("agents.list", {});
    expect(agents.some((agent) => agent.id === first.agent!.id)).toBe(false);
    expect(agents.find((agent) => agent.id === second.agent!.id)?.role).toBe("User customization");
  } finally {
    server.stop(true);
    await stopDaemon(daemon, client);
    for (const dir of dirs) removeDir(dir);
  }
}, 30_000);
