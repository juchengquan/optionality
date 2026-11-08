/** The golden cases, computed (ADR 0014).
 *
 *  Calls the TypeScript on every input in inputs.ts and records what it returned. The encoding is
 *  plain JSON plus three tags, because JSON has no dates, no sets and no exceptions:
 *
 *  - `{"$date": "<ISO instant>"}` — a Date argument
 *  - `{"$set": [...]}` — a Set result, its members sorted
 *  - `{"$throws": true}` — the function threw; what it said is not part of the contract
 *  - `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}` — a number JSON cannot write (ADR 0017)
 *
 *  `testdata/golden/README.md` repeats this for whoever reads the files from Python.
 */
import * as alarm from "../domain/alarm.ts";
import * as contract from "../domain/contract.ts";
import * as degraded from "../domain/degraded.ts";
import * as exit from "../domain/exit.ts";
import * as expiry from "../domain/expiry.ts";
import * as js from "../domain/js.ts";
import * as lifecycle from "../domain/lifecycle.ts";
import * as monitor from "../domain/monitor.ts";
import * as position from "../domain/position.ts";
import * as quote from "../domain/quote.ts";
import * as reference from "../domain/reference.ts";
import * as vol from "../domain/vol.ts";
import * as timefmt from "../domain/timefmt.ts";
import { INPUTS } from "./inputs.ts";

/** Every module of the domain, by name. Exported because `cases.test.ts` holds it to the
 *  DIRECTORY: this list and the one in that test were written out separately, so a new
 *  `domain/greeks.ts` would have been absent from both and the test that covers "every function
 *  the domain exports" would have passed over it in silence — no golden file required, no Python
 *  port required, and ADR 0014's one guard against the two implementations drifting apart quietly
 *  off. Static imports rather than a dynamic walk, so the compiler still checks every name; the
 *  test is what makes the list complete. */
export const MODULES: Record<string, Record<string, unknown>> = {
  alarm, contract, degraded, exit, expiry, js, lifecycle, monitor, position, quote,
  reference, vol, timefmt,
};

function encode(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Set) return { $set: [...value].map(encode).sort() };
  // The four numbers JSON has no spelling for. Until ADR 0017 a non-finite result was an error
  // here, which was right while every cased function was arithmetic over real figures — and wrong
  // the moment `domain/js.ts` cased `Number()`, whose whole contract includes answering NaN.
  //
  // `-0` is in the list for the same reason, and it retires the one exception ADR 0017 wrote down:
  // it reasoned that -0 could not be compared because JSON cannot carry it, and a tag carries it.
  // `String(-0)` is "0", so it needs Object.is to be seen at all.
  if (typeof value === "number" && !Number.isFinite(value)) return { $num: String(value) };
  if (Object.is(value, -0)) return { $num: "-0" };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  }
  return value;
}

export interface Case {
  fn: string;
  name: string;
  args: unknown[];
  expect: unknown;
}

export interface CaseFile {
  module: string;
  /** The module's exported VALUES — what it states rather than what it computes.
   *
   *  Cased since ADR 0017's follow-up, because the coverage guard below filters on
   *  `typeof v === "function"` and these four were therefore mirrored on trust: `MARKET_TZ`,
   *  the two greek-field lists and `NON_ADDITIVE_FIELDS`. Mirrored on trust is how
   *  `quotes.fetch_resilient` stayed three weeks behind the architecture, so trust is not enough.
   *  Always written, even empty, so a module that gains its first constant shows a diff. */
  constants: Record<string, unknown>;
  cases: Case[];
}

/** The module's exported values, by name. Types are gone at runtime, so what is left is the
 *  constants — and a function, which is what `cases` is for. */
export function constantsOf(mod: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(mod)
      .filter(([, v]) => typeof v !== "function")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, encode(v)]),
  );
}

/** Every module's cases, as the files under testdata/golden/ hold them. */
export function buildCases(): Record<string, CaseFile> {
  const out: Record<string, CaseFile> = {};
  for (const [name, inputs] of Object.entries(INPUTS)) {
    const mod = MODULES[name];
    if (!mod) throw new Error(`no module ${name}`);
    out[name] = {
      module: name,
      constants: constantsOf(mod),
      cases: inputs.map(({ fn, name: label, args }) => {
        const f = mod[fn];
        if (typeof f !== "function") throw new Error(`${name}.${fn} is not a function`);
        let expect: unknown;
        try {
          expect = encode((f as (...a: unknown[]) => unknown)(...args));
        } catch (err) {
          if (err instanceof Error && err.message.includes("which JSON cannot carry")) throw err;
          expect = { $throws: true };
        }
        return { fn, name: label, args: encode(args) as unknown[], expect };
      }),
    };
  }
  return out;
}

/** The exact text of one module's file, so a regeneration that changes nothing changes no byte. */
export const render = (file: CaseFile) => `${JSON.stringify(file, null, 2)}\n`;
