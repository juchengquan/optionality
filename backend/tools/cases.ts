/** `make cases` writes tests/golden/*.json from the TypeScript; `make check-cases` (--check) only
 *  compares, and fails if a file is missing or stale (ADR 0014). See backend/src/cases/. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { buildCases, render } from "../src/cases/build.ts";

const OUT = new URL("../../tests/golden/", import.meta.url).pathname;
const check = process.argv.includes("--check");
const stale: string[] = [];

mkdirSync(OUT, { recursive: true });
for (const [name, file] of Object.entries(buildCases())) {
  const path = join(OUT, `${name}.json`);
  const text = render(file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === text) continue;
  if (check) stale.push(`${name}.json`);
  else writeFileSync(path, text);
}

if (check && stale.length > 0) {
  console.error(`stale golden cases: ${stale.join(", ")} — run 'make cases' and commit the result`);
  process.exit(1);
}
console.log(check ? "golden cases match the TypeScript" : `wrote ${OUT}`);
