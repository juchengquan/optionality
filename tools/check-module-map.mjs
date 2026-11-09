/** Module for module: every TypeScript backend module has a Python counterpart, or says why not.
 *
 *  ADR 0021 makes the Python a second backend, ported from the TypeScript the way the domain was —
 *  same file, `snake_case` the only translation — and held to it at the three doors. The doors say
 *  whether the two BEHAVE the same; this says whether the Python has the same PARTS, so a failure
 *  points at one file instead of at a scenario that fails three layers away.
 *
 *  It lives in `tools/` because it reads two packages' trees, which `check-boundaries` refuses to
 *  any package and allows only to a repo-wide tool — the reason `check-loads.ts` lives here too.
 *
 *  The table is four parts:
 *
 *  - **`TS_ONLY`**: TypeScript with no Python counterpart, each with the reason. Printed when it
 *    is wrong, for the reason `check-seams` prints its own: a guard that only says "refused"
 *    teaches the next person to delete it.
 *  - **`RENAMED`**: where the Python name is not the TypeScript name translated.
 *  - **`PY_ONLY`**: the other direction, with reasons. Empty, and meant to stay small.
 *  - **`BACKLOG`**: what is not ported yet. ADR 0021 allows a backlog only during the first port,
 *    and only one that SHRINKS. A test cannot read history, so the shrinking is held the other
 *    way round: a ported module still listed fails, and a NEW TypeScript module cannot join the
 *    backlog without someone writing it in here — in a diff, against a list frozen on 2026-11-09.
 *    Outside the first port that is lockstep: a TypeScript module and its port land together.
 *    When the backlog is empty the port is done, and this constant should be deleted with it.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

export const TS_ROOT = "backend/src";
export const PY_ROOT = "python-backend/src/optionality_backend";

/** TypeScript backend modules that have no Python counterpart, and why. */
export const TS_ONLY = {
  "entrypoints/http/hc.types.ts":
    "a compile-time check that the dashboard's typed client calls every endpoint; the dashboard "
    + "takes its types from the TypeScript, and the Python's routes are held to the same JSON by "
    + "the HTTP door scenarios instead",
};

/** Where translating the name gives the wrong Python name. */
export const RENAMED = {
  "main.ts": "__main__.py",
};

/** Python backend modules with no TypeScript counterpart, and why. */
export const PY_ONLY = {};

/** Not yet ported. Frozen on 2026-11-09 with everything the backend had; it may only shrink. */
export const BACKLOG = [
  "create-monitor.ts",
  "db/migrate.ts",
  "db/open.ts",
  "db/queries/index.ts",
  "db/queries/links.ts",
  "db/queries/monitors.ts",
  "db/queries/positions.ts",
  "db/queries/references.ts",
  "db/queries/samples.ts",
  "db/queries/sql.ts",
  "db/rows.ts",
  "db/time.ts",
  "db/values.ts",
  "engine/health.ts",
  "engine/index.ts",
  "engine/positions.ts",
  "engine/scheduler.ts",
  "engine/sweeper.ts",
  "entrypoints/bot/bot.ts",
  "entrypoints/bot/commands/context.ts",
  "entrypoints/bot/commands/create.ts",
  "entrypoints/bot/commands/edit.ts",
  "entrypoints/bot/commands/index.ts",
  "entrypoints/bot/commands/service.ts",
  "entrypoints/bot/commands/watchlist.ts",
  "entrypoints/bot/format.ts",
  "entrypoints/http/app.ts",
  "entrypoints/http/deps.ts",
  "entrypoints/http/errors.ts",
  "entrypoints/http/index.ts",
  "entrypoints/http/listen.ts",
  "entrypoints/http/openapi.ts",
  "entrypoints/http/routes/health.ts",
  "entrypoints/http/routes/monitors.ts",
  "entrypoints/http/routes/positions.ts",
  "entrypoints/http/routes/references.ts",
  "entrypoints/http/validate.ts",
  "env.ts",
  "holdings.ts",
  "hydrate.ts",
  "main.ts",
  "monitors.ts",
  "notify.ts",
  "ports.ts",
  "references.ts",
  "schemas/index.ts",
  "schemas/monitor.ts",
  "schemas/position.ts",
  "schemas/reference.ts",
  "schemas/sources.ts",
  "telegram.ts",
  "vendors/ibkr/vendor.ts",
  "vendors/index.ts",
  "vendors/opend/vendor.ts",
  "vendors/yahoo/vendor.ts",
  "watchlist.ts",
];

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv", "dist"]);

/** Every file under `dir` whose name `keep` accepts, relative to `dir`, with `/` separators. */
function files(dir, keep) {
  const out = [];
  const visit = (at) => {
    let names;
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(full);
      } else if (keep(name)) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  visit(dir);
  return out.sort();
}

/** The Python file a TypeScript module is ported to: the same path, `snake_case`, and a
 *  directory's door (`index.ts`) as its package's `__init__.py`. */
export function pythonFor(tsPath, renamed = RENAMED) {
  if (renamed[tsPath]) return renamed[tsPath];
  const dir = dirname(tsPath);
  const name = basename(tsPath, ".ts");
  const py = name === "index" ? "__init__.py" : `${name.replaceAll(/[-.]/g, "_")}.py`;
  return dir === "." ? py : `${dir}/${py}`;
}

/** What is wrong, one line each; empty when the two backends have the same parts. */
export function findings(repo = ROOT, table = {
  tsOnly: TS_ONLY, renamed: RENAMED, pyOnly: PY_ONLY, backlog: BACKLOG,
}) {
  const { tsOnly, renamed, pyOnly, backlog } = table;
  const ts = files(join(repo, TS_ROOT),
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"));
  const py = new Set(files(join(repo, PY_ROOT), (n) => n.endsWith(".py")));
  const tsSet = new Set(ts);
  const queued = new Set(backlog);
  const out = [];

  for (const [name, entries] of [["TS_ONLY", Object.keys(tsOnly)], ["RENAMED", Object.keys(renamed)]]) {
    for (const m of entries) {
      if (!tsSet.has(m)) out.push(`${name} names ${m}, which is not in ${TS_ROOT}/ any more`);
    }
  }
  for (const m of backlog) {
    if (!tsSet.has(m)) out.push(`the backlog names ${m}, which is not in ${TS_ROOT}/ any more`);
    if (m in tsOnly) out.push(`${m} is both TypeScript-only and on the backlog`);
  }

  const counterparts = new Set();
  for (const m of ts) {
    if (m in tsOnly) continue;
    const target = pythonFor(m, renamed);
    counterparts.add(target);
    if (py.has(target) && queued.has(m)) {
      out.push(`${m} is ported (${PY_ROOT}/${target}): take it off the backlog`);
    } else if (!py.has(target) && !queued.has(m)) {
      out.push(`${m} has no Python counterpart at ${PY_ROOT}/${target}: port it in the same `
        + "change (lockstep, ADR 0021), or say in TS_ONLY why it has none");
    }
  }

  // the other direction. A directory needs no `__init__.py` in Python 3, so one where the
  // TypeScript has no door is a package marker and asks nothing; one where it HAS a door is that
  // door's port, and was counted above.
  for (const f of py) {
    if (counterparts.has(f) || f in pyOnly) continue;
    if (basename(f) === "__init__.py") continue;
    out.push(`${PY_ROOT}/${f} has no TypeScript counterpart: module for module (ADR 0021), `
      + "or say in PY_ONLY why it has none");
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = findings();
  if (found.length > 0) {
    console.error(`${found.length} problem(s) between ${TS_ROOT}/ and ${PY_ROOT}/:`);
    for (const line of found) console.error(`  ${line}`);
    process.exit(1);
  }
  const ts = files(join(ROOT, TS_ROOT),
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts")).length;
  const portable = ts - Object.keys(TS_ONLY).length;
  console.log(`module map holds: ${portable - BACKLOG.length} of ${portable} backend modules ported, `
    + `${BACKLOG.length} on the backlog, ${Object.keys(TS_ONLY).length} TypeScript-only`);
}
