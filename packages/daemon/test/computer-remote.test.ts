import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Agent } from "@boto/protocol";
import { ComputerUse } from "../src/computer";
import { migrations } from "../src/db/migrations";

test("remote Computer Use checks the allowlist before all remote dispatch", async () => {
  const db = new Database(":memory:");
  for (const sql of migrations) db.exec(sql);
  const computer = new ComputerUse(db);
  const calls: string[] = [];
  const action = async () => {
    calls.push("remote");
    return "ok";
  };
  computer.remote = () => ({ screenshot: action, click: action, type: action, key: action });
  const agent = { id: "remote" } as Agent;
  try {
    const results = await Promise.allSettled([
      computer.screenshot(agent),
      computer.click(agent, 1, 2, false),
      computer.type(agent, "text"),
      computer.key(agent, "return", []),
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(4).fill("rejected"));
    expect(calls).toEqual([]);
    computer.setAccess([agent.id]);
    await expect(computer.screenshot(agent)).resolves.toBe("ok");
    await expect(computer.click(agent, 1, 2, false)).resolves.toBe("ok");
    await expect(computer.type(agent, "text")).resolves.toBe("ok");
    await expect(computer.key(agent, "return", [])).resolves.toBe("ok");
    expect(calls).toHaveLength(4);
  } finally {
    db.close();
  }
});

test("remote Computer Use availability does not require a local display or local X11 tools", () => {
  const db = new Database(":memory:");
  const computer = new ComputerUse(db, {
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland" },
    which: () => null,
  });
  const action = async () => "ok";
  computer.remote = (id) =>
    id === "vm" ? { screenshot: action, click: action, type: action, key: action } : null;
  try {
    expect(computer.status("vm")).toEqual({ available: true });
    expect(computer.status("local").available).toBe(false);
    expect(computer.status().available).toBe(false);
  } finally {
    db.close();
  }
});
