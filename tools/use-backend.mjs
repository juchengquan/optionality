/** Which backend the live service runs, and switching it (ADR 0021, Decision 3).
 *
 *  Either backend can be the live one, one at a time, under ONE launchd label — `com.optionality.api`
 *  — so exactly one is ever loaded. They share the port (the lock, which each takes first), the
 *  database file, the bot token and the gateway client id, so the plist differs between them in
 *  what it runs and in nothing else.
 *
 *    make use BACKEND=ts|python   check, back up (the Makefile's `deploy-backup`), then switch
 *    make deploy                  `installed`: which backend the plist runs, so it restarts that one
 *    make launchd-api-install     `render`: a first install, the TypeScript unless BACKEND says
 *
 *  **The guard.** The Python may not become the live one while the port is unfinished: switching the
 *  live service to a backend that answers half the doors must be impossible by accident, so every
 *  road to a Python plist goes through `refusals` — `check`, `render` and `switch` alike. It refuses
 *  while the door-scenario backlog (`python-backend/tests/scenarios/backlog.py`) names anything,
 *  while a TypeScript backend module has no Python port (`check-module-map.mjs`'s `unported`,
 *  measured from the tree), while `__main__.py` does not exist, and while the interpreter launchd
 *  would run is not installed. The scenarios hold what the two DO; the module map holds what they
 *  are MADE of, and reaches what no scenario does — `/docs` and `/openapi.json` are nobody's door.
 *  There is no override: a drill — the Python live for a while, by hand, on the owner's request and
 *  never on a schedule — happens once the port is done and the guard is satisfied.
 *
 *  A script rather than a recipe because the guard is the point of the target and must be readable
 *  and tested (`use-backend.test.mjs`), as `py-release.mjs`'s refusals are. It lives in `tools/`
 *  because it reads both packages' trees, which only a repo-wide tool may.
 *
 *  `DRY_RUN=1` makes `switch` print what it would run — launchctl, the plist it would write, the
 *  port and the health check — and do none of it. It is how the switch is tested without launchd;
 *  `make use` takes its backup before the script runs, so it is not a dry run of `make use`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { PY_ROOT, TS_ROOT, unported } from "./check-module-map.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export const LABEL = "com.optionality.api";
/** The port the plist sets, which the health check asks and the lock is taken on. */
export const PORT = 31415;
export const BACKENDS = ["ts", "python"];
const NAMES = { ts: "the TypeScript backend", python: "the Python backend" };

const TEMPLATE = "deploy/macos/optionality-api.launchd.plist.template";
const BACKLOG = "python-backend/tests/scenarios/backlog.py";
const SCENARIOS = "testdata/scenarios";
const DOORS = ["http", "bot", "sweep"];
const MAIN = "python-backend/src/optionality_backend/__main__.py";
const INTERPRETER = ".venv/bin/python";

const USAGE = "usage: make use BACKEND=ts|python";
const LOG = "~/Library/Logs/optionality-api.log";

// --- the plist ------------------------------------------------------------------------------------

/** What launchd runs, per backend. The same `--env-file=.env` for both: one file, read as Node reads
 *  it (`env.py`'s `load_env_file` in the Python). The Python's interpreter is the uv environment's,
 *  by its absolute path because launchd's PATH is minimal; it runs the backend from the working
 *  tree, as node runs the TypeScript, because uv installs the workspace's packages editable. */
export function programArguments(backend, { repo, node }) {
  if (backend === "ts") return [node, "--env-file=.env", "backend/src/main.ts"];
  return [join(repo, INTERPRETER), "-m", "optionality_backend", "--env-file=.env"];
}

/** What a backend sets beyond what both share (the template's PORT, database, bot flag and PATH).
 *  Python writes stdout to a file in blocks, and the log is the only thing that says why a boot
 *  failed under launchd — so the Python's last words must not wait in a buffer. */
const OWN_ENVIRONMENT = { ts: {}, python: { PYTHONUNBUFFERED: "1" } };

const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderPlist(backend, { repo, home, node, template }) {
  const args = programArguments(backend, { repo, node })
    .map((arg) => `        <string>${xml(arg)}</string>`).join("\n");
  const env = Object.entries(OWN_ENVIRONMENT[backend])
    .map(([k, v]) => `        <key>${xml(k)}</key>\n        <string>${xml(v)}</string>`).join("\n");
  const rendered = template
    .replace("__PROGRAM_ARGUMENTS__", `        <!-- ${NAMES[backend]}: make use BACKEND=${backend} -->\n${args}`)
    .replace("__BACKEND_ENVIRONMENT__\n", env ? `${env}\n` : "")
    .replaceAll("__REPO__", xml(repo))
    .replaceAll("__HOME__", xml(home));
  const left = rendered.match(/__[A-Z_]+__/);
  if (left) throw new Error(`${TEMPLATE} has a placeholder nothing fills: ${left[0]}`);
  return rendered;
}

/** Which backend a plist's ProgramArguments run, or null for neither. */
export function backendOf(args) {
  if (!Array.isArray(args)) return null;
  if (args.includes("backend/src/main.ts")) return "ts";
  const m = args.indexOf("-m");
  if (m >= 0 && args[m + 1] === "optionality_backend") return "python";
  return null;
}

function lint(text) {
  const path = join(tmpdir(), `${LABEL}-${process.pid}-${Date.now()}.plist`);
  writeFileSync(path, text);
  try {
    const r = spawnSync("plutil", ["-lint", path], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`the rendered plist does not lint: ${r.stdout}${r.stderr}`);
  } finally {
    rmSync(path, { force: true });
  }
}

function readPlist(path) {
  const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${path} is not a plist plutil can read: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

// --- the guard ------------------------------------------------------------------------------------

/** The scenario names in `BACKLOG = [...]`, read from the text of `backlog.py`; null when there is no
 *  list written out to read. `test_scenario_runner.py` holds the file to exactly that — a list of
 *  string constants, never computed — and this suite holds the reading to the interpreter's. A
 *  comment is skipped whole, so an entry commented out is not on the list, as it is not for Python. */
export function readBacklog(text) {
  const head = /^BACKLOG\s*(?::[^=\n]*)?=\s*\[/m.exec(text);
  if (head === null) return null;
  const names = [];
  const token = /"([^"\\\n]*)"|'([^'\\\n]*)'|#[^\n]*|\]/g;
  token.lastIndex = head.index + head[0].length;
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    if (m[0] === "]") return names;
    if (m[1] !== undefined || m[2] !== undefined) names.push(m[1] ?? m[2]);
  }
  return null;
}

function scenarioFiles(repo, door) {
  try {
    return readdirSync(join(repo, SCENARIOS, door)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Why `backend` cannot be the live one in the tree at `repo`, one line each; empty when it can.
 *  The TypeScript is never refused: it is the canonical backend and the way back. */
export function refusals(backend, repo = ROOT) {
  if (backend !== "python") return [];
  const out = [];

  const corpus = Object.fromEntries(DOORS.map((d) => [d, scenarioFiles(repo, d)]));
  const total = DOORS.reduce((n, d) => n + corpus[d].length, 0);
  let backlog = [];
  if (existsSync(join(repo, BACKLOG))) {
    backlog = readBacklog(readFileSync(join(repo, BACKLOG), "utf8"));
  }
  if (total === 0) {
    out.push(`no door scenarios under ${SCENARIOS}/: nothing shows the Python behaves as the TypeScript does`);
  } else if (backlog === null) {
    out.push(`cannot read BACKLOG in ${BACKLOG}: it must be a list written out, as test_scenario_runner.py holds it`);
  } else if (backlog.length > 0) {
    const waiting = (d) => backlog.filter((n) => n.startsWith(`${d}/`) && corpus[d].includes(n.slice(d.length + 1))).length;
    const missing = DOORS.reduce((n, d) => n + waiting(d), 0);
    out.push(`${total - missing} of ${total} door scenarios ported`);
    for (const d of DOORS) {
      if (waiting(d) > 0) out.push(`  ${d.padEnd(5)}  ${waiting(d)} of ${corpus[d].length} still on the backlog`);
    }
  }
  // the PARTS, as well as the behaviour: a module no scenario reaches (/docs and /openapi.json are
  // nobody's door) would otherwise go live as the TypeScript's alone. `main.ts` is left to the line
  // after this one, which says the same thing in the words a missing process deserves.
  const modules = unported(repo);
  const parts = modules.missing.filter((m) => m.ts !== "main.ts");
  if (modules.portable === 0) {
    out.push(`no TypeScript backend modules under ${TS_ROOT}/: nothing to hold the Python's parts to`);
  } else if (parts.length > 0) {
    out.push(`${modules.portable - modules.missing.length} of ${modules.portable} backend modules ported`);
    for (const m of parts) out.push(`  ${m.ts} has no port at ${PY_ROOT}/${m.py}`);
  }
  if (!existsSync(join(repo, MAIN))) out.push(`${MAIN} does not exist: main.ts is not ported yet`);
  try {
    accessSync(join(repo, INTERPRETER), constants.X_OK);
  } catch {
    out.push(`no interpreter at ${INTERPRETER} for launchd to run: \`uv sync --all-packages\` installs it`);
  }
  return out;
}

class Refused extends Error {}

function refuse(backend, repo) {
  const lines = refusals(backend, repo);
  if (lines.length === 0) return;
  throw new Refused([
    `refusing to switch to ${NAMES[backend]}: the port is not done (ADR 0021)`,
    ...lines.map((l) => `  ${l}`),
    `The backlogs are ${BACKLOG} and tools/check-module-map.mjs; both are empty when the port is done.`,
    "Until then the live service stays on the TypeScript: `make use BACKEND=ts`.",
  ].join("\n"));
}

// --- switching ------------------------------------------------------------------------------------

/** What `switchTo` does to the machine, behind one object so a test can script it and a dry run can
 *  print it. Nothing else in this file runs launchctl, writes the plist or reaches the port. */
function realSystem() {
  return {
    dry: false,
    launchctl(args) {
      const r = spawnSync("launchctl", args, { encoding: "utf8" });
      return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    write(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      const next = `${path}.new-${process.pid}`;
      writeFileSync(next, text);
      renameSync(next, path);
    },
    portHeld(port) {
      return new Promise((resolve) => {
        const socket = connect({ port, host: "127.0.0.1" });
        socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
    },
    async health(url) {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status;
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The same answers a switch that worked would get, printed instead of run. */
export function drySystem(say) {
  return {
    dry: true,
    launchctl(args) {
      say(`would run: launchctl ${args.join(" ")}`);
      // `print` failing is what "no longer loaded" looks like
      return { status: args[0] === "print" ? 113 : 0, output: "" };
    },
    write(path, text) { say(`would write ${path} (${text.length} bytes)`); },
    async portHeld(port) { say(`would check that nothing holds port ${port}`); return false; },
    async health(url) { say(`would wait for 200 from ${url}`); return 200; },
    async sleep() {},
  };
}

export function systemFor(env, say = console.log) {
  return env.DRY_RUN && env.DRY_RUN !== "0" ? drySystem(say) : realSystem();
}

const plistPath = (home) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

/** Stop whatever `com.optionality.api` runs, install `backend`'s plist under the same label, start
 *  it, and wait for `/health` to answer 200. Each failure after the stop says that NOTHING is
 *  serving, and how to put the TypeScript back. */
export async function switchTo(backend, {
  repo = ROOT, home, uid, node, sys, say = console.log, waits = { unload: 30, port: 10, health: 60 },
}) {
  refuse(backend, repo);
  const plist = renderPlist(backend, { repo, home, node, template: readFileSync(join(repo, TEMPLATE), "utf8") });
  lint(plist);

  const target = plistPath(home);
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const down = `${LABEL} is NOT loaded, so nothing is serving; \`make use BACKEND=ts\` puts the TypeScript back.`;
  say(`switching ${LABEL} to ${NAMES[backend]}`);

  // not loaded at all is fine: the wait below is what says it is gone
  sys.launchctl(["bootout", service]);
  for (let i = 0; sys.launchctl(["print", service]).status === 0; i++) {
    if (i >= waits.unload) throw new Error(`${LABEL} is still loaded ${waits.unload}s after bootout; nothing was switched.`);
    await sys.sleep(1000);
  }
  // The lock would refuse the new backend, and /health would then answer 200 from whatever holds the
  // port — a switch that reported success while the old code served.
  for (let i = 0; await sys.portHeld(PORT); i++) {
    if (i >= waits.port) {
      throw new Error(`port ${PORT} is still held with ${LABEL} stopped: something outside launchd serves it `
        + `(\`lsof -nP -iTCP:${PORT} -sTCP:LISTEN\`). ${down}`);
    }
    await sys.sleep(1000);
  }

  sys.write(target, plist);
  const boot = sys.launchctl(["bootstrap", domain, target]);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap refused ${target}: ${boot.output.trim()}. ${down}`);

  const url = `http://127.0.0.1:${PORT}/health`;
  for (let i = 0; (await sys.health(url)) !== 200; i++) {
    if (i >= waits.health) {
      throw new Error(`no 200 from /health after ${waits.health}s: ${LABEL} is loaded with ${NAMES[backend]} `
        + `but not serving. Read ${LOG} (\`make api-logs\`); \`make use BACKEND=ts\` puts the TypeScript back.`);
    }
    await sys.sleep(1000);
  }
  say(sys.dry ? "dry run: nothing was done" : `${LABEL} runs ${NAMES[backend]}, and /health answers 200`);
}

// --- the command line -----------------------------------------------------------------------------

function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { /* not here */ }
  }
  return null;
}

async function main([command, backend, path]) {
  const home = process.env.HOME || homedir();
  if (command === "installed") {
    const plist = plistPath(home);
    if (!existsSync(plist)) {
      throw new Refused(`no ${LABEL} plist at ${plist}: \`make use BACKEND=ts\` installs one`);
    }
    const running = backendOf(readPlist(plist).ProgramArguments);
    if (running === null) throw new Refused(`${plist} runs neither backend; \`make use BACKEND=ts\` replaces it`);
    try {
      refuse(running, ROOT);
    } catch (err) {
      throw new Refused(`${LABEL} runs ${NAMES[running]}, and this tree cannot back it:\n${err.message}`);
    }
    console.log(running);
    return;
  }
  if (!["check", "render", "switch"].includes(command) || !BACKENDS.includes(backend)
    || (command === "render" && !path)) {
    console.error(`${USAGE}\n  (node tools/use-backend.mjs check|switch <backend> | render <backend> <path> | installed)`);
    process.exitCode = 2;
    return;
  }
  const node = onPath("node");
  if (!node) throw new Refused("node not found on the PATH");

  if (command === "switch") {
    await switchTo(backend, { home, uid: process.getuid(), node, sys: systemFor(process.env) });
    return;
  }
  refuse(backend, ROOT);
  const plist = renderPlist(backend, { repo: ROOT, home, node, template: readFileSync(join(ROOT, TEMPLATE), "utf8") });
  lint(plist);
  if (command === "check") {
    console.log(`ready to switch ${LABEL} to ${NAMES[backend]}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new-${process.pid}`, plist);
  renameSync(`${path}.new-${process.pid}`, path);
  console.log(`${path}: ${NAMES[backend]}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Refused ? err.message : err.message ?? err);
    process.exit(1);
  });
}
