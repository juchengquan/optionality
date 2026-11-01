/** No package reaches into another's source (ADR 0014).
 *
 *  The repository is one repo of separate packages — backend/, frontend/, and python/ once it
 *  exists — and a package may use another only through what that one PUBLISHES: its package.json
 *  `exports` for the TypeScript, its importable modules for the Python. A relative import that
 *  climbs out of its own package root is what this refuses. The frontend's
 *  `../../backend/src/app.ts` was exactly that, and it is what would have made splitting the
 *  repositories a refactor instead of a move.
 *
 *  `testdata/` is the shared directory: data both suites read, and reading it by path is the point.
 *  Two things live there — the golden cases (ADR 0014), written by the TypeScript, and
 *  `zone-abbreviations.json` (#174), which neither side writes and both measure themselves against.
 *  It was `testdata/golden` here until ADR 0016's lint caught up with the code and found the second
 *  one had been outside the stated boundary since the day it was added.
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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
export const PACKAGES = ["backend", "frontend", "python"];
export const SHARED = ["testdata"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx|py)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
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
const PARENTS = /\bparents\s*\[\s*(\d+)\s*\]((?:\s*\/\s*"[^"]*")*)/g;
const FILE_URL = /new\s+URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g;
const SEGMENT = /"([^"]*)"/g;

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
export function crossings(repo = ROOT, packages = PACKAGES, shared = SHARED) {
  const found = [];
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

    for (const [, spec] of text.matchAll(SPECIFIER)) {
      // a relative import only. A bare `optionality.position` is the package importing itself
      // through its own name, which is what a consumer does and is the point.
      if (!spec.startsWith(".")) continue;
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
      ...[...text.matchAll(FILE_URL)].map(([match, spec]) => [match, resolve(dirname(file), spec)]),
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

const found = crossings();
if (found.length > 0) {
  console.error(`${found.length} reference(s) reach into another package's source:`);
  for (const c of found) console.error(`  ${c}`);
  console.error(`use what the package publishes (its package.json "exports"), or testdata/ for shared data`);
  process.exit(1);
}
console.log("no package reaches into another's source");
