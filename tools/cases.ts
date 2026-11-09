/** `make cases` writes testdata/golden/*.json from the TypeScript; `make check-cases` (--check) only
 *  compares, and fails if a file is missing or stale (ADR 0014). See backend/src/cases/.
 *
 *  It writes the two FINGERPRINT stamps in the same pass (ADR 0016) — one for the TypeScript, one
 *  inside the Python package — because this is the only place that knows the cases changed. Written
 *  together, a stamp cannot lag the cases it fingerprints; written anywhere else, it could.
 *
 *  It lives in `tools/` rather than `backend/tools/` for that second stamp. Writing a generated
 *  file into `python/src/` is a repo-wide codegen step, and from inside the backend package it
 *  would have been that package reaching into another's source tree — the one thing
 *  check-boundaries exists to refuse. Its peers here do the same: they all read or write across
 *  every package. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildCases, buildFrom, render } from "../backend/src/cases/build.ts";
import { VENDOR_INPUTS, VENDOR_MODULES } from "../backend/src/cases/vendors.ts";
import { goldenHash, pythonStamp, tsStamp } from "../backend/src/cases/stamp.ts";

const REPO = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

/** Where the generated files go: this repository, unless `--root <dir>` names somewhere else.
 *
 *  That option exists for one caller, `tools/cases.test.mjs`, and it closes a real hole. That
 *  suite runs the REAL generator to prove `--check` guards both stamps, and it used to run it
 *  against the real tree on every test — so `make test-tools` REPAIRED the staleness that
 *  `make check-cases` exists to report, two targets after it had reported it, and left five
 *  regenerated files in the working tree that nobody had authored. A test may read this
 *  repository; it may not write it. */
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg === -1 ? REPO : resolve(process.argv[rootArg + 1] ?? ".");
const OUT = join(ROOT, "testdata/golden/");
/** The vendor corpus, written in the same pass and NOT hashed into the fingerprint — see
 *  `cases/vendors.ts` for why: GOLDEN_CASES answers a question about the DOMAIN, and a
 *  released package with no vendor ports would report disagreement over code it lacks. */
const VENDOR_OUT = join(ROOT, "testdata/vendors/");
const stale: string[] = [];

mkdirSync(OUT, { recursive: true });
const rendered: Record<string, string> = {};
for (const [name, file] of Object.entries(buildCases())) {
  rendered[name] = render(file);
}

for (const [name, text] of Object.entries(rendered)) {
  const path = join(OUT, `${name}.json`);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === text) continue;
  if (check) stale.push(`${name}.json`);
  else writeFileSync(path, text);
}

// the stamps, from the rendered text rather than from disk: the fingerprint is of what the
// TypeScript SAYS the cases are, so a stale checkout cannot talk itself into agreement
// the vendor corpus, before the stamps: same shape, same staleness rule, different directory and
// deliberately outside `goldenHash`
mkdirSync(VENDOR_OUT, { recursive: true });
for (const [name, file] of Object.entries(buildFrom(VENDOR_INPUTS, VENDOR_MODULES))) {
  const path = join(VENDOR_OUT, `${name}.json`);
  const text = render(file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) stale.push(`vendors/${name}.json`);
  } else writeFileSync(path, text);
}

const hash = goldenHash(rendered);
for (const [path, text] of [
  ["backend/src/golden.ts", tsStamp(hash)],
  ["python/src/optionality/_ported.py", pythonStamp(hash)],
] as const) {
  const full = join(ROOT, path);
  const current = existsSync(full) ? readFileSync(full, "utf8") : null;
  if (current === text) continue;
  if (check) stale.push(path);
  else {
    // the stamps live inside two packages, so under a `--root` their directories may not exist
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

if (check && stale.length > 0) {
  console.error(`stale golden cases: ${stale.join(", ")} — run 'make cases' and commit the result`);
  process.exit(1);
}
console.log(check ? `golden cases match the TypeScript (${hash})` : `wrote ${OUT} and both stamps (${hash})`);
