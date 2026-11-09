import { expect, test } from "bun:test";
import { RuntimeManager } from "../src/runtime/runtime-manager";

test("stream reads flush primary and extra instances with each stream's cursor", () => {
  const flushed: string[] = [];
  const runtime = (name: string, seq: number) => ({
    flushStreamText(beforeSeq?: number) {
      if (beforeSeq === undefined || seq < beforeSeq) flushed.push(name);
    },
  });
  const primary = runtime("primary", 5);
  const extra = runtime("extra", 9);
  const manager: RuntimeManager = Object.assign(Object.create(RuntimeManager.prototype), {
    runtimes: new Map([["bot", primary]]),
    scheduler: { extras: (id: string) => (id === "bot" ? [extra] : []) },
  });
  manager.flushStreamText("bot", 8);
  expect(flushed).toEqual(["primary"]);
  flushed.length = 0;
  manager.flushStreamText("bot");
  expect(flushed).toEqual(["primary", "extra"]);
  flushed.length = 0;
  manager.flushStreamText("missing");
  expect(flushed).toEqual([]);
});
