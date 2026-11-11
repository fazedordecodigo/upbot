// Fake `limactl` for tests: keeps instance state in $FAKE_LIMA_HOME/state.json and
// prints the same shapes as `limactl list --json`. `create` materializes a stopped
// instance, `start`/`stop`/`delete` mutate it. Every call appends a line to
// $FAKE_LIMA_LOG for assertions.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.FAKE_LIMA_HOME || join(process.env.HOME || "/tmp", ".fake-lima");
mkdirSync(home, { recursive: true });
const stateFile = join(home, "state.json");

type Instance = {
  name: string;
  status: string;
  sshLocalPort: number;
  IdentityFile: string;
  config: { user: { name: string } };
};

const load = (): Instance[] =>
  existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as Instance[]) : [];
const save = (v: Instance[]) => writeFileSync(stateFile, JSON.stringify(v));

const argv = process.argv.slice(2);
if (process.env.FAKE_LIMA_LOG) {
  appendFileSync(process.env.FAKE_LIMA_LOG, `${JSON.stringify(argv)}\n`);
}

const [cmd, ...rest] = argv;

const find = (name: string) => load().find((i) => i.name === name);
const put = (inst: Instance) => {
  const all = load().filter((i) => i.name !== inst.name);
  all.push(inst);
  save(all);
};

if (cmd === "--version") {
  process.stdout.write("limactl version 2.3.0\n");
} else if (cmd === "list" && rest[0] === "--json") {
  for (const i of load()) process.stdout.write(`${JSON.stringify(i)}\n`);
} else if (cmd === "create") {
  const name = rest[rest.indexOf("--name") + 1]!;
  if (find(name)) {
    process.stderr.write(`instance "${name}" already exists\n`);
    process.exit(1);
  }
  put({
    name,
    status: "Stopped",
    sshLocalPort: 64000 + (name.length % 100),
    IdentityFile: join(home, "id_fake"),
    config: { user: { name: "lima" } },
  });
} else if (cmd === "start" || cmd === "stop" || cmd === "delete") {
  const name = rest[0]!;
  const inst = find(name);
  if (!inst) {
    process.stderr.write(`instance "${name}" does not exist\n`);
    process.exit(1);
  }
  if (cmd === "delete") save(load().filter((i) => i.name !== name));
  else put({ ...inst, status: cmd === "start" ? "Running" : "Stopped" });
} else {
  process.stderr.write(`fake-limactl: unsupported ${argv.join(" ")}\n`);
  process.exit(1);
}
