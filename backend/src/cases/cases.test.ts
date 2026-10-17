/** The committed golden cases are what the TypeScript computes today (ADR 0014).
 *
 *  This is what turns a domain change into a red test until `make cases` has regenerated the
 *  files — and the regenerated files are what then turn the Python red until it is ported.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as contract from "../domain/contract.ts";
import * as exit from "../domain/exit.ts";
import * as expiry from "../domain/expiry.ts";
import * as monitor from "../domain/monitor.ts";
import * as position from "../domain/position.ts";
import * as quote from "../domain/quote.ts";
import * as vol from "../domain/vol.ts";
import * as timefmt from "../timefmt.ts";
import { buildCases, render } from "./build.ts";
import { INPUTS } from "./inputs.ts";

const CASES = join(import.meta.dirname, "../../../cases");

/** Exported, and deliberately not a case: each reads something only the service has. */
const NOT_PORTED = new Set([
  "exit.exitPolicy", // reads the service's Settings; the package takes the three knobs directly
  "timefmt.displayStored", // reads the database's storage format
]);

describe("cases/", () => {
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

  it("covers every function the domain exports, so a new one cannot skip the Python", () => {
    const modules = { contract, exit, expiry, monitor, position, quote, vol, timefmt };
    const exported = Object.entries(modules).flatMap(([m, mod]) =>
      Object.entries(mod).filter(([, v]) => typeof v === "function").map(([fn]) => `${m}.${fn}`));
    const covered = new Set(Object.entries(INPUTS).flatMap(([m, cs]) => cs.map((c) => `${m}.${c.fn}`)));
    expect(exported.filter((f) => !covered.has(f) && !NOT_PORTED.has(f))).toEqual([]);
  });

  it("lands on each rounding rule's boundary", () => {
    // the reason comparison is exact: these are where JavaScript and Python disagree
    const expectOf = (m: string, name: string) => built[m]!.cases.find((c) => c.name === name)!.expect;
    expect(expectOf("monitor", "12.5 rounds to even")).toBe(12);
    expect(expectOf("exit", "target DTE 12.5 rounds up, as Math.round does"))
      .toMatchObject({ target_dte: 13 });
  });
});
