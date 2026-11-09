import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  sendAndWait,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

for (const scenario of ["options", "no options", "missing command"]) {
  test(`ACP config queries: ${scenario}`, async () => {
    const data = tmp("config-data-");
    const agents = tmp("config-agents-");
    const state = tmp("config-fake-");
    const token = crypto.randomUUID();
    let daemon: DaemonHandle | undefined;
    let client: DaemonClient | undefined;
    try {
      daemon = await startDaemon(data, agents, token, {
        BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify(
          scenario === "missing command"
            ? ["definitely-missing-boto-config-provider"]
            : [process.execPath, FAKE_AGENT],
        ),
        FAKE_ACP_STATE_DIR: state,
        FAKE_ACP_NEW_DELAY_MS: "200",
        FAKE_ACP_NO_CONFIG: scenario === "no options" ? "1" : "0",
      });
      const c = await DaemonClient.connect(daemon.port, token);
      client = c;
      const agent = await c.request("agents.create", { name: "Config", provider: "devin" });
      if (scenario === "missing command") {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            c.request("agents.configOptions", { agentId: agent.id }),
          ).rejects.toMatchObject({
            code: "provider_unavailable",
            message: expect.stringContaining("definitely-missing-boto-config-provider"),
          });
        }
        expect((await c.request("agents.list", {})).map((item) => item.id)).toContain(agent.id);
        return;
      }
      const requests = Array.from({ length: 3 }, () =>
        c.request("agents.configOptions", { agentId: agent.id }),
      );
      const results = await Promise.all(requests);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]?.configOptions.map((option) => option.id)).toEqual(
        scenario === "no options" ? [] : ["mode", "model"],
      );
      await expect(
        client.request("agents.setConfig", { agentId: agent.id, configId: "unknown", value: "x" }),
      ).rejects.toMatchObject({ code: "bad_request", message: "unknown configId unknown" });
      const turn = await sendAndWait(client, agent.id, "echo:session still live", 10000);
      expect(turn.status).toBe("completed");
      expect(readLog(state).filter((entry) => entry.method === "session/new")).toHaveLength(1);
    } finally {
      if (daemon) await stopDaemon(daemon, client, state, "SIGTERM");
      for (const dir of [data, agents, state]) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
}
