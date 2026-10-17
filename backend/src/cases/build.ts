/** The golden cases, computed (ADR 0014).
 *
 *  Calls the TypeScript on every input in inputs.ts and records what it returned. The encoding is
 *  plain JSON plus three tags, because JSON has no dates, no sets and no exceptions:
 *
 *  - `{"$date": "<ISO instant>"}` — a Date argument
 *  - `{"$set": [...]}` — a Set result, its members sorted
 *  - `{"$throws": true}` — the function threw; what it said is not part of the contract
 *
 *  `testdata/golden/README.md` repeats this for whoever reads the files from Python.
 */
import * as contract from "../domain/contract.ts";
import * as exit from "../domain/exit.ts";
import * as expiry from "../domain/expiry.ts";
import * as monitor from "../domain/monitor.ts";
import * as position from "../domain/position.ts";
import * as quote from "../domain/quote.ts";
import * as vol from "../domain/vol.ts";
import * as timefmt from "../domain/timefmt.ts";
import { INPUTS } from "./inputs.ts";

const MODULES: Record<string, Record<string, unknown>> = {
  contract, exit, expiry, monitor, position, quote, vol, timefmt,
};

function encode(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Set) return { $set: [...value].map(encode).sort() };
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`a case produced ${value}, which JSON cannot carry`);
  }
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

/** Every module's cases, as the files under testdata/golden/ hold them. */
export function buildCases(): Record<string, { module: string; cases: Case[] }> {
  const out: Record<string, { module: string; cases: Case[] }> = {};
  for (const [name, inputs] of Object.entries(INPUTS)) {
    const mod = MODULES[name];
    if (!mod) throw new Error(`no module ${name}`);
    out[name] = {
      module: name,
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
export const render = (file: { module: string; cases: Case[] }) => `${JSON.stringify(file, null, 2)}\n`;
