/** Nothing the service runs may import the test harness.
 *
 *  `backend/testing/` builds a whole app for a test: a fake Provider that prices every code it is
 *  asked for, a sweeper that has never swept, a bearer token of `"tok"`. Every one of those is
 *  correct in a test and a lie in the service — a route that reached the fake would answer the
 *  dashboard with invented figures, and nothing would look wrong.
 *
 *  This was unguarded while the harness lived at `backend/src/testing.ts`, beside the modules it
 *  fakes and loaded by `check-loads.ts` along with them. Moving it out of `src/` is what makes
 *  `src/` mean "the service"; this is what keeps it meaning that, because a directory's meaning
 *  that nothing checks is a convention and conventions are what a deadline spends.
 *
 *  A script rather than an ESLint rule, for the reason `check-boundaries.mjs` gives: the repo has
 *  no ESLint, and one rule does not justify a toolchain. It reads specifiers with that file's
 *  pattern — `from "x"`, `import("x")`, bare `import "x"` — and is checked against a fixture tree
 *  rather than against this repository.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** The directory name that means "for tests only", in any package. */
const SUPPORT = "testing";

/** A file that is allowed to reach for it: a test, or test support itself. */
function mayImport(path) {
  return /\.(test|spec)\.(ts|tsx|mts|js|mjs|jsx)$/.test(path)
    || path.split(sep).includes(SUPPORT);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return SOURCE.test(path) ? [path] : [];
  });
}

/** Every production module that imports test support, as lines.
 *
 *  Takes a root so the guard can be tested against a fixture tree — the arrangement
 *  `check-boundaries.mjs` arrived at after a sweep found three ways to gut it with every suite
 *  still green.
 */
export function leaks(repo = ROOT) {
  const found = [];
  for (const file of walk(repo)) {
    if (mayImport(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      if (!spec.startsWith(".")) continue;
      const target = relative(repo, resolve(dirname(file), spec));
      if (!target.split(sep).includes(SUPPORT)) continue;
      found.push(`${relative(repo, file)}: imports "${spec}" — ${target} is test support`);
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = leaks();
  if (found.length > 0) {
    console.error(`${found.length} production module(s) import test support:`);
    for (const line of found) console.error(`  ${line}`);
    console.error("the harness fakes the Provider; a service that reached it would invent figures");
    process.exit(1);
  }
  console.log("no production module imports test support");
}
