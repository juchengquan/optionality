/** The committed golden cases are what the TypeScript computes today (ADR 0014).
 *
 *  This is what turns a domain change into a red test until `make cases` has regenerated the
 *  files — and the regenerated files are what then turn the Python red until it is ported.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODULES, buildCases, render } from "./build.ts";
import { INPUTS } from "./inputs.ts";

const CASES = join(import.meta.dirname, "../../../testdata/golden");

/** Exported, and deliberately not a case: each reads something only the service has. */
const NOT_PORTED = new Set([
  "exit.exitPolicy", // reads the service's Settings; the package takes the three knobs directly
  "alarm.alarmPolicy", // the same: Settings in, two knobs out (ADR 0017)
  "degraded.degradedPolicy", // and the same again, for the degraded notice
  "flapping.flappingPolicy", // and again, for the unreliable one
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
    const { modules, nested } = domainModules(new URL("../domain/", import.meta.url).pathname);
    expect(Object.keys(MODULES).sort(), "a domain module nothing cases — add it to build.ts")
      .toEqual(modules);
    // And `domain/` stays FLAT, which is the half the filter above could not see: a directory
    // entry is not a `.ts` file, so `domain/greeks/sum.ts` was invisible to it — new canonical
    // arithmetic with no case, no Python port, and every gate green. Flat is also what the port
    // mirrors: `python/src/optionality/` is module for module, snake_case the only translation
    // (CLAUDE.md), and there is nothing for a subdirectory to become on that side.
    expect(nested, "domain/ must stay flat — the Python package mirrors it module for module")
      .toEqual([]);
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

/** The `domain/` directory, read as the fact the coverage test rests on.
 *
 *  Its own function so that it can be checked against a FIXTURE TREE below rather than against
 *  this repository — the arrangement `check-boundaries.mjs` and `check-test-support.mjs` arrived
 *  at, and for their reason: a sweep of the first found three ways to gut it with every suite
 *  still green. "Add a module and watch it fail" is the right check, and doing it by hand is what
 *  lets a hole last.
 */
export function domainModules(dir: string): { modules: string[]; nested: string[] } {
  const entries = readdirSync(dir, { withFileTypes: true });
  return {
    // every extension Node will run, not only `.ts`: `.mts` is the same canonical code under a
    // name the old filter ignored
    modules: entries
      .filter((e) => e.isFile() && /\.m?ts$/.test(e.name)
        && !e.name.endsWith(".d.ts") && !/\.test\.m?ts$/.test(e.name))
      .map((e) => e.name.replace(/\.m?ts$/, ""))
      .sort(),
    nested: entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(),
  };
}

describe("reading the domain directory", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "domain-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), "export const x = 1;\n");
  };

  it("names a plain module", () => {
    write("alarm.ts");
    expect(domainModules(dir)).toEqual({ modules: ["alarm"], nested: [] });
  });

  it("names a .mts module too, which the old filter ignored", () => {
    write("greeks.mts");
    expect(domainModules(dir).modules).toEqual(["greeks"]);
  });

  it("ignores a test file and a declaration file, which are not domain modules", () => {
    write("alarm.ts");
    write("alarm.test.ts");
    write("shim.d.ts");
    expect(domainModules(dir).modules).toEqual(["alarm"]);
  });

  it("reports a subdirectory, which is how domain code escaped the gate entirely", () => {
    write("alarm.ts");
    mkdirSync(join(dir, "greeks"));
    writeFileSync(join(dir, "greeks/sum.ts"), "export const sum = () => 1;\n");
    // the old read filtered on `.endsWith(".ts")`, and "greeks" is not a `.ts` — so this module
    // needed no case and no port, and check-cases, cases.test, pytest, boundaries, test-support
    // and typecheck all passed with it in place
    expect(domainModules(dir)).toEqual({ modules: ["alarm"], nested: ["greeks"] });
  });
});
