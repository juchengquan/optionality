/** The vendor corpus holds what each vendor's field mapping computes today.
 *
 *  `cases.test.ts`'s job for `domain/`, done for the pure logic in each vendor's `fields.ts` —
 *  which that guard cannot cover, because it holds its module list to the `domain/` DIRECTORY and
 *  these are not in it. The coverage guard below is the reason this file exists rather than a bare
 *  staleness check: a corpus nothing holds to the module's exports is a corpus that goes quietly
 *  out of date, which is what `cases.test.ts` was written to stop.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildFrom, render } from "./build.ts";
import { VENDOR_INPUTS, VENDOR_MODULES } from "./vendors.ts";

const CASES = join(import.meta.dirname, "../../../testdata/vendors");

describe("testdata/vendors/", () => {
  const built = buildFrom(VENDOR_INPUTS, VENDOR_MODULES);

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

  it("covers every function each vendor's field mapping exports", () => {
    // the guard that makes this a corpus rather than a sample. A new field mapper — a vendor that
    // starts reporting a grade, a greek the service did not carry — is canonical the moment it is
    // written, and a Python port would have nothing to be held to.
    const exported = Object.entries(VENDOR_MODULES).flatMap(([m, mod]) =>
      Object.entries(mod).filter(([, v]) => typeof v === "function").map(([fn]) => `${m}.${fn}`));
    const covered = new Set(
      Object.entries(VENDOR_INPUTS).flatMap(([m, cs]) => cs.map((c) => `${m}.${c.fn}`)));
    expect(exported.filter((f) => !covered.has(f)),
      "a vendor field mapper nothing cases — add inputs to cases/vendors.ts").toEqual([]);
    // and there IS something to compare: an empty namespace would pass the filter above
    expect(exported.length, "no field mappers found at all").toBeGreaterThanOrEqual(5);
  });

  it("states every constant each one exports, which the coverage test cannot see", () => {
    // `PRICE_TICKS` and `GREEK_TICKS` are the tick-id tables, and they are the whole translation
    // for prices: a delayed id mapped to the wrong field would show a bid as a last.
    const exported = Object.entries(VENDOR_MODULES).flatMap(([m, mod]) =>
      Object.entries(mod).filter(([, v]) => typeof v !== "function").map(([k]) => `${m}.${k}`));
    const stated = Object.entries(built).flatMap(([m, file]) =>
      Object.keys(file.constants).map((k) => `${m}.${k}`));
    expect(exported.filter((n) => !stated.includes(n))).toEqual([]);
    expect(stated.filter((n) => !exported.includes(n))).toEqual([]);
    expect(stated.length).toBeGreaterThanOrEqual(2);
  });

  it("records the two translations that are not renames", () => {
    // the reason this corpus is worth having at all. Everything else here is a field rename; these
    // two change the MEANING, and a port that got either wrong would be plausible and wrong.
    const expectOf = (m: string, fn: string) =>
      built[m]!.cases.find((c) => c.fn === fn)!.expect as Record<string, unknown>;
    // IBKR's fraction becomes the service's percent: 0.1368 -> 13.68, where moomoo said 14.007
    expect(expectOf("ibkr-fields", "greekFields").option_implied_volatility)
      .toBeCloseTo(13.6797785, 7);
    // and Yahoo's bogus book is dropped rather than carried or averaged
    const gspc = expectOf("yahoo-fields", "toRecord");
    expect(gspc.bid_price).toBeUndefined();
    expect(gspc.ask_price).toBeUndefined();
    expect(gspc.mid_price).toBeUndefined();
    expect(gspc.last_price).toBe(7376.86);
  });
});
