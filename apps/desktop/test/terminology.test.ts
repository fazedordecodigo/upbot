import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../../packages/daemon/test/helpers";

test("desktop source consistently calls bots bots without changing agent identifiers", () => {
  const src = join(ROOT, "apps/desktop/src");
  const offenders = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(src)].filter((file) =>
    /\bagentes?\b/iu.test(readFileSync(join(src, file), "utf8")),
  );
  expect(offenders).toEqual([]);
});
