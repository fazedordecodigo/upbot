import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Agent } from "@boto/protocol";
import { ComputerUse } from "../src/computer";
import { typeCommand } from "../src/computer-platform";
import { migrations } from "../src/db/migrations";

test("unreadable clipboard types fail before clearing or pasting", () => {
  const nil = { isNil: () => true };
  let cleared = false;
  const item = {
    types: { count: 1, objectAtIndex: () => "public.file-promise" },
    dataForType: () => nil,
    stringForType: () => nil,
    propertyListForType: () => nil,
  };
  const board = {
    pasteboardItems: { count: 1, objectAtIndex: () => item },
    clearContents: () => {
      cleared = true;
    },
  };
  const script = typeCommand({ platform: "darwin" }, "text")[4];
  expect(() =>
    runInNewContext(`${script}\nrun(["text"]);`, {
      ObjC: { import: () => {}, unwrap: (value: unknown) => value },
      $: {
        NSPasteboard: { generalPasteboard: board },
        NSMutableArray: { alloc: { init: {} } },
        NSPasteboardItem: { alloc: { init: {} } },
      },
    }),
  ).toThrow("Unable to preserve clipboard type: public.file-promise");
  expect(cleared).toBe(false);
});

test("queued macOS typing rechecks access before executing", async () => {
  const db = new Database(":memory:");
  for (const sql of migrations) db.exec(sql);
  const computer = new ComputerUse(db, { platform: "darwin" });
  const agent = { id: "queued" } as Agent;
  computer.setAccess([agent.id]);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exec = spyOn(computer as unknown as { exec(cmd: string[]): Promise<void> }, "exec");
  exec.mockImplementation(async () => {
    started();
    await blocked;
  });
  try {
    const first = computer.type(agent, "A");
    await entered;
    const second = computer.type(agent, "B").catch((error: Error) => error);
    computer.setAccess([]);
    release();
    await first;
    expect(await second).toBeInstanceOf(Error);
    expect(((await second) as Error).message).toContain("Computer Use is not enabled for you");
    expect(exec).toHaveBeenCalledTimes(1);
  } finally {
    release();
    exec.mockRestore();
    db.close();
  }
});

test("Unicode typing preserves text as data and serializes clipboard access, including after errors", async () => {
  const db = new Database(":memory:");
  for (const sql of migrations) db.exec(sql);
  const computer = new ComputerUse(db, { platform: "darwin" });
  const commands: string[][] = [];
  const exec = spyOn(computer as unknown as { exec(cmd: string[]): Promise<void> }, "exec");
  let active = 0;
  let maximum = 0;
  exec.mockImplementation(async (cmd) => {
    commands.push(cmd);
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    active--;
    if (cmd.at(-1) === "fail") throw new Error("paste failed");
  });
  const agent = { id: "unicode" } as Agent;
  try {
    await expect(computer.type(agent, "ação")).rejects.toThrow("not enabled");
    computer.setAccess([agent.id]);
    for (const text of ["", "a".repeat(5001), "a\0b"]) {
      await expect(computer.type(agent, text)).rejects.toThrow("1-5000");
    }
    expect(commands).toEqual([]);
    const texts = ["ação é ç 😀", "ação é ç".normalize("NFD"), '\"\\\n\t; do shell script "no"'];
    expect(await Promise.all(texts.map((text) => computer.type(agent, text)))).toEqual(
      texts.map((text) => `typed ${text.length} characters`),
    );
    expect(maximum).toBe(1);
    expect(commands.map((cmd) => cmd.at(-1))).toEqual(texts);
    for (const cmd of commands) {
      expect(cmd.slice(0, 4)).toEqual(["osascript", "-l", "JavaScript", "-e"]);
      expect(cmd[4]).toContain("item.dataForType(type)");
      expect(cmd[4]).toContain("finally");
      expect(cmd[4]).toContain("board.changeCount === version");
      expect(cmd[4]).toContain("board.writeObjects(saved)");
      expect(cmd[4]).not.toContain("ação");
    }
    await expect(computer.type(agent, "fail")).rejects.toThrow("paste failed");
    expect(await computer.type(agent, "é")).toBe("typed 1 characters");
  } finally {
    exec.mockRestore();
    db.close();
  }
});
