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
 *  The table is three parts:
 *
 *  - **`TS_ONLY`**: TypeScript with no Python counterpart, each with the reason. Printed when it
 *    is wrong, for the reason `check-seams` prints its own: a guard that only says "refused"
 *    teaches the next person to delete it.
 *  - **`RENAMED`**: where the Python name is not the TypeScript name translated.
 *  - **`PY_ONLY`**: the other direction, with reasons. Empty, and meant to stay small.
 *
 *  There is no fourth. ADR 0021's first port had a `BACKLOG`, frozen on 2026-11-09 with every
 *  module the backend had and allowed only to shrink; it emptied on 2026-11-10 with
 *  `entrypoints/http/openapi.ts` and was deleted, as it said it would be. What is left is lockstep:
 *  a TypeScript module and its port land in the same change, or the module says in `TS_ONLY` why
 *  it has none.
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
export const PY_ONLY = {
  "schemas/zod.py":
    "zod's refusals in zod's words, which the TypeScript has from the zod library: a refused request "
    + "answers with z.prettifyError's text, the dashboard prints it verbatim, and pydantic says other "
    + "things, and in places refuses other values",
};

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

/** Every TypeScript backend module that is not TypeScript-only and has no Python file where its
 *  port belongs, and how many such modules there are: `{ portable, missing: [{ ts, py }] }`.
 *
 *  `make use`'s guard (`use-backend.mjs`) asks this on whatever tree is checked out, which
 *  `make check` may never have seen. */
export function unported(repo = ROOT, table = { tsOnly: TS_ONLY, renamed: RENAMED }) {
  const { tsOnly, renamed } = table;
  const py = new Set(files(join(repo, PY_ROOT), (n) => n.endsWith(".py")));
  const portable = tsModules(repo).filter((m) => !(m in tsOnly));
  const missing = portable
    .map((m) => ({ ts: m, py: pythonFor(m, renamed) }))
    .filter(({ py: target }) => !py.has(target));
  return { portable: portable.length, missing };
}

/** The TypeScript backend's modules: every `.ts` under `backend/src/`, less tests and declarations. */
function tsModules(repo) {
  return files(join(repo, TS_ROOT),
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"));
}

/** What is wrong, one line each; empty when the two backends have the same parts. */
export function findings(repo = ROOT, table = {
  tsOnly: TS_ONLY, renamed: RENAMED, pyOnly: PY_ONLY,
}) {
  const { tsOnly, renamed, pyOnly } = table;
  const ts = tsModules(repo);
  const py = new Set(files(join(repo, PY_ROOT), (n) => n.endsWith(".py")));
  const tsSet = new Set(ts);
  const out = [];

  for (const [name, entries] of [["TS_ONLY", Object.keys(tsOnly)], ["RENAMED", Object.keys(renamed)]]) {
    for (const m of entries) {
      if (!tsSet.has(m)) out.push(`${name} names ${m}, which is not in ${TS_ROOT}/ any more`);
    }
  }

  const counterparts = new Set();
  for (const m of ts) {
    if (m in tsOnly) continue;
    const target = pythonFor(m, renamed);
    counterparts.add(target);
    if (!py.has(target)) {
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
  const ts = tsModules(ROOT).length;
  const portable = ts - Object.keys(TS_ONLY).length;
  console.log(`module map holds: all ${portable} backend modules ported, `
    + `${Object.keys(TS_ONLY).length} TypeScript-only`);
}
