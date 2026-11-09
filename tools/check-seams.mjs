/** A seam's interior is private: only its entry file may be imported from outside it.
 *
 *  `check-boundaries.mjs` states the rule BETWEEN packages — no package reaches into another's
 *  source tree, only into what it publishes. This states the same rule INSIDE one, for the few
 *  directories where the whole point is that callers go through one door.
 *
 *  The one that provoked it is `backend/src/vendors/`. ADR 0015 and 0019 both rest on every
 *  market-data vendor being reached through one seam — `openVendors` opens each vendor ONCE and
 *  hands the Provider back among the sources, which is what makes "one client either way"
 *  structural rather than remembered. IB Gateway allows one connection per client id and the
 *  SECOND DISPLACES THE FIRST IN SILENCE, so a second client is not an inefficiency, it is a
 *  provider that stops answering for reasons nobody can see.
 *
 *  Nothing enforced it. `vendors.ts` was the only importer of `opend/`, `ibkr/` and `yahoo/` —
 *  measured, three lines in one file, not even the suites reached past it — but that was a fact
 *  about today rather than a rule, and the cheapest way to fix a dashed row is to import the
 *  client that has the figure. A convention nothing checks is a convention, and conventions are
 *  what a deadline spends (the sentence `check-test-support.mjs` was written under).
 *
 *  A script rather than an ESLint rule, for the reason that file gives: the repo has no ESLint and
 *  two rules do not justify a toolchain. It reads specifiers with the same pattern — `from "x"`,
 *  `import("x")`, bare `import "x"` — and is checked against a FIXTURE TREE rather than against
 *  this repository, which is what a sweep of `check-boundaries` taught: three ways to gut it left
 *  every suite green.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Each directory whose interior is private, and the files that are not.
 *
 *  `why` is printed when the rule is broken, because a guard that only says "refused" teaches the
 *  next person to delete it.
 *
 *  Every door is listed HERE rather than inferred, and each one that is not the obvious `index.ts`
 *  carries its own reason. A door with a reason is a door; a blanket exemption — "anything under
 *  `tools/` may reach in" — is a hole with a comment, and that distinction is the whole difference
 *  between this file and no file.
 */
export const SEAMS = [
  {
    dir: "backend/src/vendors",
    doors: [
      "index.ts",
      // the fake IB GATEWAY, not a client: recorded replies plus the socket that serves them, and
      // the one definition `make ibkr-fake-gateway` and the suite share so the two cannot drift
      // (CLAUDE.md). It lives beside `wire.ts` and `messages.ts` because it speaks that protocol —
      // moving it out would reach INTO the seam instead, which is the same hole reversed.
      "ibkr/fake.ts",
    ],
    /** What may NEVER become a door, whatever the pressure.
     *
     *  Found by a mutation sweep: adding `"ibkr/client.ts"` to the list above passed every test
     *  this file had, because the fixture tests declare their own seam and the one test about the
     *  real `SEAMS` only asked that a door and a reason exist. A guard whose exemption list can be
     *  opened from the inside is not a guard — and the pressure is concrete: the cheapest way to
     *  fix a dashed row is to import the client that has the figure.
     *
     *  A client is the connection itself, and a `vendor.ts` is the descriptor `VENDORS` is built
     *  from — naming either as a door is naming the thing the seam exists for. */
    never: /\/(client|vendor)\.ts$/,
    why: "a vendor is reached through `openVendors` (ADR 0015, 0019) — IB Gateway allows one "
      + "connection per client id and the second displaces the first in silence",
  },
];

/** Exported so the test can ask what a seam actually contains. */
export function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return SOURCE.test(path) ? [path] : [];
  });
}

const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

/** Every import that reaches past a seam, as lines.
 *
 *  Takes a root and the seams so the guard can be tested against a fixture tree, which is the
 *  arrangement `check-boundaries.mjs` and `check-test-support.mjs` both arrived at.
 */
export function breaches(repo = ROOT, seams = SEAMS) {
  const found = [];
  for (const seam of seams) {
    const dir = join(repo, seam.dir);
    // a door the seam itself forbids is a breach of the seam, reported before any import is read:
    // this is the rule that cannot be relaxed by relaxing the rule
    for (const door of seam.doors) {
      if (seam.never?.test(`/${door}`)) {
        found.push(`${seam.dir}/: "${door}" is named as a door, and ${seam.never} may never be one`);
      }
    }
    const doors = new Set(seam.doors.map((d) => join(repo, seam.dir, d)));
    let files;
    try {
      files = walk(repo);
    } catch {
      continue;                                   // no such tree; nothing to say about it
    }
    for (const file of files) {
      if (inside(file, dir)) continue;            // the interior may import itself
      const text = readFileSync(file, "utf8");
      for (const [, spec] of text.matchAll(SPECIFIER)) {
        if (!spec.startsWith(".")) continue;      // a package specifier is check-boundaries' business
        const target = resolve(dirname(file), spec);
        if (!inside(target, dir) || doors.has(target)) continue;
        found.push(
          `${relative(repo, file)}: imports "${spec}" — ${relative(repo, target)} is inside `
          + `${seam.dir}/, whose doors are ${seam.doors.join(", ")}`,
        );
      }
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = breaches();
  if (found.length > 0) {
    console.error(`${found.length} import(s) reach past a seam:`);
    for (const line of found) console.error(`  ${line}`);
    for (const seam of SEAMS) console.error(`${seam.dir}/: ${seam.why}`);
    process.exit(1);
  }
  console.log(`no import reaches past a seam (${SEAMS.length} checked)`);
}
