/** Every `make <target>` this repo tells you to run is a target the Makefile has.
 *
 *  Written because it had rotted twice over. The two differentials that held the TypeScript against
 *  the Python it was replacing — `diff-api` and `diff-opend` — went with the Python itself (#145),
 *  and nine comments in backend/src went on naming them as commands to run. One was the only check
 *  named on the OpenD field mapping, which is the file where a wrong name is silent: a reader
 *  following it gets "No rule to make target" and learns nothing about what holds that mapping now.
 *
 *  The rule is the backticked phrase, because that is how this repo writes a command: inside
 *  backticks it is something to RUN, so it must exist. A retired one is named without that word —
 *  "the `diff-api` differential", past tense, with what replaced it — which is also the more honest
 *  sentence, since the thing being described is history. Matching unbackticked prose was tried and
 *  is useless: "make the" and "make room" are English, and this very file would be twelve findings.
 *
 *  Scope is deliberately the code and the standing instructions, not docs/. `docs/adr/` and
 *  `docs/cutover.md` are dated records, and "0 over 288 across 8 live contracts" is a true
 *  statement about 2026-10-15 that must not be rewritten to stay lint-clean. A comment in
 *  backend/src carries no date and reads as current.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
// where an instruction reads as something to do NOW: the source, the tools, and the two files that
// are read before working here
const SCAN_DIRS = ["backend/src", "backend/tools", "frontend/src", "tools"];
const SCAN_FILES = ["CLAUDE.md", "README.md", ".env.example"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", ".out"]);
const TEXT = /\.(ts|tsx|mts|js|mjs|jsx|md|sql|example)$/;
// a backticked command, with whatever arguments follow it: `make check`, `make restore FROM=<f>`
const INVOCATION = /`make\s+([a-z][a-z0-9-]*)(?:\s[^`]*)?`/g;

/** A target is a RULE: `name:` at the start of a line. Deliberately not what `.PHONY` declares —
 *  counting those was the first version, and a mutation showed what it cost: renaming the `serve`
 *  rule to `serve-local` while `.PHONY` still said `serve` passed the check, which is exactly the
 *  rename this is here to catch. A name declared phony with no rule cannot be run either. */
function targets(makefile) {
  return new Set(
    [...makefile.matchAll(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/gm)].map(([, name]) => name),
  );
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : (TEXT.test(path) ? [path] : []);
  });
}

const known = targets(readFileSync(join(ROOT, "Makefile"), "utf8"));
const files = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SCAN_FILES.map((f) => join(ROOT, f)).filter((f) => { try { statSync(f); return true; } catch { return false; } }),
];

const dead = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [, target] of line.matchAll(INVOCATION)) {
      if (known.has(target)) continue;
      dead.push(`${relative(ROOT, file)}:${i + 1}: make ${target}`);
    }
  });
}

if (dead.length > 0) {
  console.error(`${dead.length} reference(s) to a make target that does not exist:`);
  for (const d of dead) console.error(`  ${d}`);
  console.error("add the target, or name the retired one without `make` and say what replaced it");
  process.exit(1);
}
console.log(`every make target named in the code exists (${known.size} targets)`);
