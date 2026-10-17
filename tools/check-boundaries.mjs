/** No package reaches into another's source (ADR 0014).
 *
 *  The repository is one repo of separate packages — backend/, frontend/, and python/ once it
 *  exists — and a package may use another only through what that one PUBLISHES: its package.json
 *  `exports` for the TypeScript, its importable modules for the Python. A relative import that
 *  climbs out of its own package root is what this refuses. The frontend's
 *  `../../backend/src/app.ts` was exactly that, and it is what would have made splitting the
 *  repositories a refactor instead of a move.
 *
 *  `testdata/golden/` is the one shared directory: the golden cases are data both suites read, written by
 *  the TypeScript, and reading them by path is the point.
 *
 *  A script rather than ESLint: the repo has no ESLint, and one rule did not justify a toolchain.
 *  It reads specifiers with a regex, which is enough for the forms this repo writes — `from "x"`,
 *  `import("x")`, bare `import "x"` — and is checked the way every guard here is, by adding a
 *  crossing and watching it fail.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PACKAGES = ["backend", "frontend", "python"];
const SHARED = ["testdata/golden"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return SOURCE.test(path) ? [path] : [];
  });
}

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

const crossings = [];
for (const pkg of PACKAGES) {
  const root = join(ROOT, pkg);
  try { statSync(root); } catch { continue; }
  for (const file of walk(root)) {
    for (const [, spec] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (inside(target, root) || SHARED.some((s) => inside(target, join(ROOT, s)))) continue;
      crossings.push(`${relative(ROOT, file)}: "${spec}" leaves ${pkg}/`);
    }
  }
}

if (crossings.length > 0) {
  console.error(`${crossings.length} import(s) reach into another package's source:`);
  for (const c of crossings) console.error(`  ${c}`);
  console.error(`import what the package publishes instead (its package.json "exports")`);
  process.exit(1);
}
console.log("no package reaches into another's source");
