// Fake speech program: `bun fake-tts.ts <name> [args...]` stores its arguments and the full
// stdin in $FAKE_TTS_DIR/<name>.json (written atomically once stdin closes).
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [name = "tts", ...args] = process.argv.slice(2);
const dir = process.env.FAKE_TTS_DIR;
if (!dir) process.exit(2);
const input = await Bun.stdin.text();
const file = join(dir, `${name}.json`);
writeFileSync(`${file}.tmp`, JSON.stringify({ args, input }));
renameSync(`${file}.tmp`, file);
