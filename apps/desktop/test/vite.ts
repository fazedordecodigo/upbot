import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../packages/daemon/test/helpers";

export const base = "http://localhost:1420";

async function running(): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(base, { signal: AbortSignal.timeout(2000) });
  } catch {
    return false;
  }
  const [client, manifest, entry] = await Promise.all(
    ["/@vite/client", "/package.json", "/src/main.tsx?raw"].map(async (path) => {
      const result = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) });
      return result.ok ? result.text() : "";
    }),
  );
  const viteClient = realpathSync(
    join(ROOT, "apps/desktop/node_modules/vite/dist/client/env.mjs"),
  ).replaceAll("\\", "/");
  if (
    !response.ok ||
    !client.includes(viteClient) ||
    !manifest.includes('"name": "@boto/desktop"') ||
    !entry.includes(JSON.stringify(readFileSync(join(ROOT, "apps/desktop/src/main.tsx"), "utf8")))
  )
    throw new Error("Port 1420 is occupied by a server that is not this repo's desktop Vite");
  return true;
}

export async function startVite() {
  if (await running()) return { stop: async () => {} };
  const child = Bun.spawn(
    [
      process.execPath,
      join(ROOT, "apps/desktop/node_modules/vite/bin/vite.js"),
      join(ROOT, "apps/desktop"),
      "--port",
      "1420",
      "--strictPort",
    ],
    { cwd: ROOT, stdout: "ignore", stderr: "inherit" },
  );
  const stop = async () => {
    child.kill();
    await child.exited;
  };
  try {
    const deadline = Date.now() + 30000;
    while (!(await running())) {
      if (child.exitCode !== null) throw new Error(`Vite exited with code ${child.exitCode}`);
      if (Date.now() >= deadline) throw new Error("Vite did not become ready on port 1420");
      await Bun.sleep(50);
    }
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
