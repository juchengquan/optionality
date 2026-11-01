/** Cutting a release of the Python package (ADR 0016).
 *
 *  TWO steps, because CLAUDE.md forbids pushing to main: the version bump is a commit and goes
 *  through a PR like anything else, so only the tag can be applied afterwards.
 *
 *    make py-cut    on a branch — compute the date, write it, regenerate the stamps, run the gate
 *    make py-tag    on main after the bump has merged — refuse five ways, then tag and push
 *
 *  A script rather than a recipe: this is five refusals and a date, and in `make` it was four
 *  lines of nested quoting that broke the first time it was written. The guards here are the whole
 *  point of the target, so they are readable and they are tested (py-release.test.mjs).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const PYPROJECT = `${ROOT}python/pyproject.toml`;
const REPO = "https://github.com/juchengquan/optionality.git";

/** CalVer, unpadded on purpose. PEP 440 normalises a padded month — `2026.09.0` becomes
 *  `2026.9.0` — so a padded tag and `pip show` would disagree for ever (measured 2026-11-01). */
export function calver(now = new Date()) {
  return `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
}

/** A date, with an optional fourth segment for a second cut in one day. Anchored, because the
 *  point is to refuse `0.1.0` — a version that is not a date means `py-cut` was never run. */
export const DATED = /^20\d\d\.\d{1,2}\.\d{1,2}(\.\d+)?$/;

/** The span of the `[project]` table, which is the only place this package's own version lives.
 *
 *  Scoped rather than line-anchored. TOML does not order its tables, so a `[tool.x]` section with
 *  a `version` of its own can PRECEDE `[project]` — and both a bare and a line-anchored replace
 *  take the first match, which would bump some tool's pin and ship the package still calling
 *  itself 0.1.0. A mutation sweep found this: the first fixture put the decoy last, where every
 *  version of the code passed. */
function projectTable(toml) {
  const head = /^\[project\][ \t]*$/m.exec(toml);
  if (head === null) return null;
  const from = head.index + head[0].length;
  const next = /^\[/m.exec(toml.slice(from));
  return { from, to: next === null ? toml.length : from + next.index };
}

export function versionIn(toml) {
  const span = projectTable(toml);
  if (span === null) return null;
  return /^version = "(.*)"$/m.exec(toml.slice(span.from, span.to))?.[1] ?? null;
}

export function withVersion(toml, version) {
  const span = projectTable(toml);
  if (span === null) throw new Error("pyproject.toml has no [project] table");
  const body = toml
    .slice(span.from, span.to)
    .replace(/^version = ".*"$/m, `version = "${version}"`);
  return toml.slice(0, span.from) + body + toml.slice(span.to);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
const git = (...args) => run("git", args);
const make = (target) => execFileSync("make", [target], { cwd: ROOT, stdio: "inherit" });

function refuse(why) {
  console.error(why);
  process.exit(1);
}

function cut() {
  if (git("status", "--porcelain") !== "") refuse("working tree is dirty — commit first");
  const toml = readFileSync(PYPROJECT, "utf8");
  const version = calver();
  if (versionIn(toml) === version) {
    refuse(`python/pyproject.toml is already ${version} — a second cut today is ${version}.1, by hand`);
  }
  writeFileSync(PYPROJECT, withVersion(toml, version));
  console.log(`version = ${version}`);
  // the stamps come from the same pass that writes the cases, so a release cannot carry a stale one
  make("cases");
  make("check");
  console.log(`\ncut ${version} — commit it, open a PR, merge it, then 'make py-tag' on main`);
}

function tag() {
  // five refusals rather than trusting that the merge was fine, the same reason `deploy` re-checks:
  // a tag is what a notebook pins for months, and the only thing that makes it worth pinning is
  // that the whole gate passed at that commit.
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") refuse("not on main");
  if (git("status", "--porcelain") !== "") refuse("working tree is dirty");
  git("fetch", "-q", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    refuse("not level with origin/main — pull or push first");
  }
  const version = versionIn(readFileSync(PYPROJECT, "utf8"));
  if (version === null || !DATED.test(version)) {
    refuse(`version ${version === null ? "is missing" : `'${version}' is not a date`} — run 'make py-cut' first`);
  }
  const name = `py-${version}`;
  try {
    git("rev-parse", "-q", "--verify", `refs/tags/${name}`);
    refuse(`tag ${name} already exists`);
  } catch {
    // no such tag, which is what we want
  }
  make("check");
  git("tag", name);
  git("push", "-q", "origin", name);
  console.log(`\ntagged and pushed ${name}\n`);
  console.log(`  uv add "optionality @ git+${REPO}@${name}#subdirectory=python"\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (process.argv.includes("--tag")) tag();
  else if (process.argv.includes("--cut")) cut();
  else refuse("usage: py-release.mjs --cut | --tag");
}
