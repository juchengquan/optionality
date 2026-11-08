/** The committed golden cases are what the TypeScript computes today (ADR 0014).
 *
 *  This is what turns a domain change into a red test until `make cases` has regenerated the
 *  files — and the regenerated files are what then turn the Python red until it is ported.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MODULES, buildCases, render } from "./build.ts";
import { INPUTS } from "./inputs.ts";

const CASES = join(import.meta.dirname, "../../../testdata/golden");

/** Exported, and deliberately not a case: each reads something only the service has. */
const NOT_PORTED = new Set([
  "exit.exitPolicy", // reads the service's Settings; the package takes the three knobs directly
  "alarm.alarmPolicy", // the same: Settings in, two knobs out (ADR 0017)
  "degraded.degradedPolicy", // and the same again, for the degraded notice
]);

describe("testdata/golden/", () => {
  const built = buildCases();

  it("holds exactly what the TypeScript computes now — run `make cases` if this fails", () => {
    const stale = Object.entries(built)
      .filter(([name, file]) => {
        const path = join(CASES, `${name}.json`);
        return !existsSync(path) || readFileSync(path, "utf8") !== render(file);
      })
      .map(([name]) => `${name}.json`);
    expect(stale).toEqual([]);
  });

  it("holds no file for a module that has no inputs", () => {
    const files = existsSync(CASES) ? readdirSync(CASES).filter((f) => f.endsWith(".json")) : [];
    expect(files.filter((f) => !(f.replace(/\.json$/, "") in built))).toEqual([]);
  });

  it("knows every module the domain has", () => {
    // What the test below rests on, and what it could not see. Both this file and build.ts named
    // the eight modules by hand, so the coverage claim was only ever about the eight somebody had
    // remembered to list: adding domain/greeks.ts and nothing else left every check green while
    // its functions had no cases and no Python. The directory is the fact; the list must match it.
    const onDisk = readdirSync(new URL("../domain/", import.meta.url))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(Object.keys(MODULES).sort(), "a domain module nothing cases — add it to build.ts")
      .toEqual(onDisk);
  });

  it("covers every function the domain exports, so a new one cannot skip the Python", () => {
    const exported = Object.entries(MODULES).flatMap(([m, mod]) =>
      Object.entries(mod).filter(([, v]) => typeof v === "function").map(([fn]) => `${m}.${fn}`));
    const covered = new Set(Object.entries(INPUTS).flatMap(([m, cs]) => cs.map((c) => `${m}.${c.fn}`)));
    expect(exported.filter((f) => !covered.has(f) && !NOT_PORTED.has(f))).toEqual([]);
  });

  it("states every constant the domain exports, which the coverage test above cannot see", () => {
    // `covers every function` filters on `typeof v === "function"`, so the four exported VALUES —
    // MARKET_TZ, the two greek-field lists, NON_ADDITIVE_FIELDS — were mirrored on trust alone.
    // Mirrored on trust is how quotes.fetch_resilient stayed three weeks behind the architecture.
    const exported = Object.entries(MODULES).flatMap(([m, mod]) =>
      Object.entries(mod).filter(([, v]) => typeof v !== "function").map(([k]) => `${m}.${k}`));
    const stated = Object.entries(built).flatMap(([m, file]) =>
      Object.keys(file.constants).map((k) => `${m}.${k}`));
    expect(exported.filter((n) => !stated.includes(n))).toEqual([]);
    // and the converse, which is the half a sweep found missing: a FUNCTION in here would be
    // invisible in the file, because JSON.stringify drops a function-valued key and the bytes come
    // out identical. The in-memory build is where it can be seen.
    expect(stated.filter((n) => !exported.includes(n))).toEqual([]);
    // and there IS something to compare, so a filter that quietly matched nothing would pass above
    expect(stated.length).toBeGreaterThanOrEqual(4);
  });

  it("lands on each JavaScript rounding rule's boundary", () => {
    // the reason comparison is exact: these are where JavaScript and Python disagree
    const expectOf = (m: string, name: string) => built[m]!.cases.find((c) => c.name === name)!.expect;
    expect(expectOf("monitor", "12.5 rounds to even")).toBe(12);
    expect(expectOf("exit", "target DTE 12.5 rounds up, as Math.round does"))
      .toMatchObject({ target_dte: 13 });
    expect(expectOf("quote", "an exact binary half rounds up")).toBe(0.0313); // Python: 0.0312
  });
});
