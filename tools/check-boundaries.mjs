/** No package reaches into another's source (ADR 0014).
 *
 *  The repository is one repo of separate packages — typescript/ (the library, ADR 0021),
 *  backend/, frontend/, python/ and python-backend/ (also ADR 0021) — and a package may use
 *  another only through what that one PUBLISHES: its package.json `exports` for the TypeScript,
 *  its importable modules for the Python. A relative import that climbs out of its own package
 *  root is what this refuses. The frontend's `../../backend/src/app.ts` was exactly that, and it
 *  is what would have made splitting the repositories a refactor instead of a move.
 *
 *  `testdata/` is the shared directory: data both suites read, and reading it by path is the point.
 *  Two things live there — the golden cases (ADR 0014), written by the TypeScript, and
 *  `zone-abbreviations.json` (#174), which neither side writes and both measure themselves against.
 *  It was `testdata/golden` here until ADR 0016's lint caught up with the code and found the second
 *  one had been outside the stated boundary since the day it was added.
 *
 *  `schema/` is the second shared directory (ADR 0021): `schema.sql`, the migrations and the
 *  pre-migration baseline, which lived in `backend/src/db/` until the Python became a second
 *  backend. One database file, one schema, the same `.sql` migrations applied by whichever backend
 *  starts first — so the files belong to neither, and inside `backend/` the Python could have read
 *  them only by reaching into another package's source tree.
 *
 *  A script rather than ESLint: the repo has no ESLint, and one rule did not justify a toolchain.
 *  It reads specifiers with a regex, which is enough for the forms this repo writes — `from "x"`,
 *  `import("x")`, bare `import "x"` — and is checked the way every guard here is, by adding a
 *  crossing and watching it fail.
 *
 *  Two things were added in ADR 0016, because `python` was named here from the start and never
 *  actually checked: the file pattern admitted only TypeScript and JavaScript, so NO Python file
 *  was ever read and the half of the paragraph above about "its importable modules for the Python"
 *  was unenforced.
 *
 *  And paths, not only imports. The Python's one crossing is a FILESYSTEM reach —
 *  `Path(__file__).resolve().parents[2] / "testdata" / "golden"` in `test_cases.py` — which is
 *  legal, because that directory is the shared ground, and was invisible to a check that read
 *  import specifiers. Nothing stopped the next one landing in `backend/src/` and reading the
 *  canonical TypeScript as data. A package boundary that only guards the door nobody uses is
 *  decoration.
 *
 *  And DIRECTION, since ADR 0021 split the library out of the backend. Everything above is about
 *  HOW one package reaches another, and a published name passes all of it — so
 *  `import type { Settings } from "backend"` inside the library would have been legal, and would
 *  have put the service inside the thing whose whole promise is that it runs with no service.
 *  `DEPENDS` says which package may import which by name, the way `test_standalone.py` holds the
 *  Python's library away from everything impure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
export const PACKAGES = ["typescript", "backend", "frontend", "python", "python-backend"];
export const SHARED = ["testdata", "schema"];
/** Which packages each may import BY NAME, as directories (ADR 0021).
 *
 *  Directories, not npm names, and resolved through each package.json: the library's directory is
 *  `typescript/` and its name is `optionality`, because the compiler owns `typescript` on npm. A
 *  table of names would have to say `optionality` and mean a directory nobody would look for.
 *
 *  The library imports nothing here; that row is the reason this table exists. A package with NO
 *  row may import nothing by name either, rather than anything: a sixth package arriving
 *  unguarded until somebody remembered this table is the "complete by diligence" failure
 *  `hc.types.ts` had. Importing ITSELF by its own name is always allowed — that is a consumer's
 *  path through its own exports, not a dependency.
 *
 *  The Python's imports carry no quotes and are not read here; `test_standalone.py` holds its
 *  library, and the coming `python-backend/` lint holds that one (ADR 0021). */
export const DEPENDS = {
  typescript: [],
  backend: ["typescript"],
  frontend: ["backend"],
  python: [],
  "python-backend": [],
};
/** Directories no guard walks into.
 *
 *  Exported so `guards.test.mjs` can hold every guard's list to one floor: this constant is
 *  copied in five files, which is why `.claude` was missing from all five at once.
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".venv",
  "__pycache__",
  ".out",
  // `.claude` holds agent WORKTREES — `.claude/worktrees/<agent>` is a checkout of this same
  // repository on another branch, registered with git and live. Walking into one lints that
  // branch's code against THIS branch's rules, which fails for everybody: on 2026-11-10 a
  // leftover worktree on `feat/redesign-figures` made `make check` red on a clean main.
  ".claude",
]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx|py)$/;
/** A specifier in double quotes, single quotes or BACKTICKS: a template literal with no `${}` is one
 *  fixed path, and `import(\`../../x.ts\`)` passed every guard until a review wrote one. A template
 *  that interpolates is built at runtime, which no lint can read, so `$` ends the match. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*)(["'`])([^"'`$]+)\1/g;
/** ...but not in Python, where a backtick is a docstring's markup — "ported from `backend/src/`" —
 *  and never a string. */
const PY_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'$]+)\1/g;
/** `require(...)` and `import.meta.resolve(...)` name a module as surely as an import does; the
 *  Python has neither, so they are read only where SPECIFIER is. */
/** Python's relative import, which the pattern above cannot see: its specifier carries no quotes.
 *  Admitting `.py` to the file list alone therefore bought the path check and nothing else — a
 *  mutation sweep caught that, by adding `from ...backend.src import thing` and watching it pass.
 *
 *  The dots are the climb, counted the way Python counts them: one dot is the file's own package,
 *  so N dots is N-1 directories up. The dotted module path that follows is directories. */
const PY_IMPORT = /^[ \t]*from\s+(\.+)([\w.]*)\s+import\s/gm;
/** The two ways a file in this repo reaches the filesystem by path rather than by import, with the
 *  rest of the expression captured: where a climb LANDS is the whole question, and the climb alone
 *  does not say — `parents[2]` is the repository root from `python/tests/`, legal only because of
 *  the `/ "testdata" / "golden"` that follows it. So the segments come too. */
const PARENTS = /\bparents\s*\[\s*(\d+)\s*\]((?:\s*\/\s*(["'])[^"']*\3|\s*\.\s*joinpath\(\s*(?:["'][^"']*["']\s*,?\s*)*\))*)/g;
const FILE_URL = /new\s+URL\(\s*(["'`])([^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const SEGMENT = /["']([^"']*)["']/g;
/** The same climb spelled `.parent` at a time: `Path(__file__).resolve().parent` is the file's own
 *  directory, so N of them is N-1 levels up — the spelling a review found every check blind to. */
const PARENT_CHAIN =
  /\b__file__\s*\)(?:\s*\.\s*resolve\(\s*\))?((?:\s*\.\s*parent\b(?!s))+)((?:\s*\/\s*(["'])[^"']*\3|\s*\.\s*joinpath\(\s*(?:["'][^"']*["']\s*,?\s*)*\))*)/g;
/** `os.path.join(os.path.dirname(__file__), "..", "x")`, the `__file__` optionally made absolute
 *  first: the oldest spelling of the same climb. */
const OS_PATH_JOIN =
  /\bos\.path\.join\(\s*os\.path\.dirname\(\s*(?:os\.path\.(?:abspath|realpath)\(\s*)?__file__\s*\)?\s*\)\s*((?:,\s*["'][^"']*["']\s*)*)\)/g;
/** ...and the same directory with a path appended as text: `${import.meta.dirname}/../x` inside a
 *  template, or `import.meta.dirname + "/../x"`. */
const DIR_TEXT = /(?:\$\{\s*(?:import\.meta\.dirname|__dirname)\s*\}([^`$]*)`|\b(?:import\.meta\.dirname|__dirname)\s*\+\s*(["'`])([^"'`$]*)\2)/g;

/** The text of every `join(...)` or `resolve(...)` call, arguments balanced, so a directory held in
 *  a variable can be followed: `const here = dirname(fileURLToPath(import.meta.url))`, then
 *  `join(here, "../../x")` — or `const ROOT = join(import.meta.dirname, "../..")`, then
 *  `join(ROOT, "backend/src")`, the spelling the review of #422 found every check blind to. */
function calls(text) {
  const found = [];
  for (const m of text.matchAll(/\b(?:join|resolve)\(/g)) {
    let depth = 0, quote = null, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")" && --depth === 0) break;
    }
    found.push(text.slice(m.index, i + 1));
  }
  return found;
}

/** Split call arguments on their top-level commas. */
function args(inner) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) { if (c === quote && inner[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Where a TypeScript expression for a DIRECTORY points, or null where it cannot be read: the
 *  module's own directory however it is spelled, a variable holding one, and `join`/`resolve` of
 *  one with segments that are literals or variables holding literals. A segment that is anything
 *  else — an imported name — makes the whole unreadable, and an unreadable path is not refused. */
function directory(expr, file, dirs, strings) {
  const e = expr.trim();
  if (/^(?:import\.meta\.dirname|__dirname)$/.test(e)) return dirname(file);
  if (/^dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)$/.test(e)) return dirname(file);
  const url = /^fileURLToPath\(\s*new\s+URL\(\s*(["'`])([^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)\s*\)$/.exec(e);
  if (url) return resolve(dirname(file), url[2]);
  if (/^\w+$/.test(e)) return dirs.get(e) ?? null;
  const call = /^(?:join|resolve)\(([\s\S]*)\)$/.exec(e);
  if (!call) return null;
  const [first, ...rest] = args(call[1]);
  const base = first === undefined ? null : directory(first, file, dirs, strings);
  if (base === null) return null;
  const segments = rest.map((a) => {
    const q = /^(["'`])([^"'`$]*)\1$/.exec(a);
    return q ? q[2] : (strings.get(a) ?? null);
  });
  return segments.includes(null) ? null : resolve(base, ...segments);
}

/** Every path a TypeScript file builds from its own directory through a variable or a call. */
function heldDirectoryReaches(text, file) {
  const dirs = new Map();
  const strings = new Map();
  for (const [, name, value] of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/g)) {
    const q = /^\s*(["'`])([^"'`$]*)\1\s*$/.exec(value);
    if (q) { strings.set(name, q[2]); continue; }
    const dir = directory(value, file, dirs, strings);
    if (dir !== null) dirs.set(name, dir);
  }
  const found = calls(text).map((call) => [call, directory(call, file, dirs, strings)]);
  for (const [name, dir] of dirs) {
    for (const [match, tail] of text.matchAll(new RegExp(`\\$\\{\\s*${name}\\s*\\}([^\`$]*)\``, "g"))) {
      found.push([match, resolve(dir, `./${tail}`)]);
    }
  }
  return found.filter(([, target]) => target !== null);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return SOURCE.test(path) ? [path] : [];
  });
}

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** Every crossing under `root`, as lines. A function over a root rather than a script over this
 *  repository, so the guard itself can be tested against a fixture tree — it never had a test, and
 *  a mutation sweep found three ways to gut it with every suite still green, including removing
 *  `.py` from the files it reads. "Add a crossing and watch it fail" is the right check; doing it
 *  by hand is what let the hole last. */
export function crossings(repo = ROOT, packages = PACKAGES, shared = SHARED, depends = DEPENDS) {
  const found = [];
  const names = npmNames(repo, packages);
  for (const pkg of packages) {
    const root = join(repo, pkg);
    try { statSync(root); } catch { continue; }
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
    /** An IMPORT may only climb out of its package into declared shared ground: it creates a
     *  source dependency, and the whole rule is that a dependency on another package goes through
     *  what that package publishes. */
    const importable = (target) =>
        inside(target, root) || shared.some((s) => inside(target, join(repo, s)));
    /** A PATH is data access, and the offence is landing inside ANOTHER PACKAGE — reading its
     *  source tree as bytes, which `parents[2] / "backend" / "src"` would do just as effectively
     *  as an import. Deliberately laxer than the import rule in one way: a climb to the repository
     *  root itself is not another package's source, and tools legitimately resolve it to print
     *  repo-relative names. What it must not do is land in a sibling. */
    const readable = (target) =>
        inside(target, root) || !packages.some((p) => inside(target, join(repo, p)));

    for (const [, , spec] of text.matchAll(file.endsWith(".py") ? PY_SPECIFIER : SPECIFIER)) {
      if (!spec.startsWith(".")) {
        // a name: legal as a ROUTE, being what the other package publishes, so the only question
        // is whether this package may depend on that one at all
        const dep = names.get(packageName(spec));
        if (dep === undefined || dep === pkg || (depends[pkg] ?? []).includes(dep)) continue;
        found.push(`${relative(repo, file)}: "${spec}" makes ${pkg}/ depend on ${dep}/, `
          + `and ${pkg}/ may import ${listed(depends[pkg])} by name`);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (importable(target)) continue;
        found.push(`${relative(repo, file)}: "${spec}" leaves ${pkg}/`);
    }

    for (const [, dots, mod] of text.matchAll(PY_IMPORT)) {
      const target = resolve(dirname(file), "../".repeat(dots.length - 1), mod.split(".").join("/"));
      if (importable(target)) continue;
        found.push(`${relative(repo, file)}: "from ${dots}${mod} import" leaves ${pkg}/`);
    }

    // and the filesystem reaches, resolved whole. `parents[0]` is the file's own directory, so N
    // levels up is N `..` from there, and then whatever the expression joins on.
    const reaches = [
      ...[...text.matchAll(PARENTS)].map(([match, levels, joined]) => [
        match,
        resolve(dirname(file), "../".repeat(Number(levels)),
                [...joined.matchAll(SEGMENT)].map(([, seg]) => seg).join("/")),
      ]),
      ...[...text.matchAll(PARENT_CHAIN)].map(([match, chain, joined]) => [
        match,
        resolve(dirname(file), "../".repeat(chain.split("parent").length - 2),
                [...joined.matchAll(SEGMENT)].map(([, seg]) => seg).join("/")),
      ]),
      ...[...text.matchAll(FILE_URL)].map(([match, , spec]) => [match, resolve(dirname(file), spec)]),
      ...[...text.matchAll(DIR_TEXT)].map(([match, inTemplate, , appended]) => [
        match, resolve(dirname(file), `./${inTemplate ?? appended}`),
      ]),
      ...[...text.matchAll(OS_PATH_JOIN)].map(([match, joined]) => [
        match, resolve(dirname(file), ...[...joined.matchAll(SEGMENT)].map(([, seg]) => seg)),
      ]),
      ...(file.endsWith(".py") ? [] : heldDirectoryReaches(text, file)),
    ];
    for (const [match, target] of reaches) {
      if (readable(target)) continue;
        found.push(
          `${relative(repo, file)}: ${match} reads ${relative(repo, target)}, another package's source`,
        );
    }
    }
  }
  return found;
}

/** Each package's npm name, to its directory. Only a package.json names one: the Python's
 *  `pyproject.toml` says `optionality` as well, and its imports are not read by name here. */
function npmNames(repo, packages) {
  const names = new Map();
  for (const pkg of packages) {
    try {
      const { name } = JSON.parse(readFileSync(join(repo, pkg, "package.json"), "utf8"));
      if (name) names.set(name, pkg);
    } catch { /* no package.json: nothing to be imported by */ }
  }
  return names;
}

/** `optionality/domain/alarm` is `optionality`; `@scope/x/y` is `@scope/x`. */
const packageName = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

const listed = (deps) => (deps?.length ? deps.map((d) => `${d}/`).join(", ") : "nothing");

const found = crossings();
if (found.length > 0) {
  console.error(`${found.length} reference(s) reach into another package's source:`);
  for (const c of found) console.error(`  ${c}`);
  const ground = SHARED.map((s) => `${s}/`).join(" or ");
  console.error(`use what the package publishes (its package.json "exports"), or ${ground} for shared ground`);
  process.exit(1);
}
console.log("no package reaches into another's source");
