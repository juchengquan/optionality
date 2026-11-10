/** Stored rows into the shapes the domain works in (ADR 0009, phase 5).
 *
 *  The split is deliberate: a row holds `legs` as JSON text and `enabled` as 0 or 1, because that is
 *  what SQLite holds and what the Python wrote. The domain holds parsed legs and real booleans. One
 *  of the two has to be converted, and doing it here means no row type ever claims to be something
 *  it is not and no domain function ever parses JSON.
 *
 *  **A row is CHECKED on its way in, not cast** (#266). The conversion was a cast, so legs that
 *  parsed but were not legs — a leg with no sign, a side of "sold" — reached the maths, which swept
 *  them with a NaN where the sign should be, while the Python port's models refused the same row and
 *  quarantined it: two backends acting differently on one database file with every gate green. Now
 *  a row is refused HERE, before any figure is computed from it, and every caller that can meet one
 *  already hydrates inside the guard that quarantines a rule it cannot read, or leaves out a holding
 *  (`engine/sweeper.ts`). Legs that are not JSON at all are refused the same way, with JSON.parse's
 *  error as the cause.
 *
 *  What is checked is what the domain's TYPES say, and nothing more: a value of the right kind that
 *  is still wrong — a strike date that is no date, a threshold of 0 — is the domain's to refuse, and
 *  already is. The first fault in field order is the one named, in words the Python's `hydrate.py`
 *  repeats exactly, because `/positions/values` answers with them. Only a hand edit, a bad import
 *  or a damaged restore writes such a row; the write paths validate.
 */
import type { Leg, Position, Side } from "optionality/domain/position";
import type { Monitor, MonitorLeg } from "optionality/domain/monitor";
import { fromSqliteJson } from "./db/values.ts";
import type { MonitorRow, PositionRow } from "./db/rows.ts";

/** A test of one stored value, and the words for what it must be. */
type Rule = readonly [test: (value: unknown) => boolean, must: string];

const TEXT: Rule = [(v) => typeof v === "string", "text"];
const TEXT_OR_NULL: Rule = [(v) => v === null || typeof v === "string", "text or null"];
const NUMBER: Rule = [(v) => typeof v === "number", "a number"];
const NUMBER_OR_NULL: Rule = [(v) => v === null || typeof v === "number", "a number or null"];
const WHOLE: Rule = [(v) => Number.isInteger(v), "a whole number"];
const SIGN: Rule = [(v) => v === 1 || v === -1, "1 or -1"];
const OPTION_TYPE: Rule = [(v) => v === "CALL" || v === "PUT", '"CALL" or "PUT"'];
const SIDE: Rule = [(v) => v === "short" || v === "long", '"short" or "long"'];

/** Reads one row's values, refusing the first that is not what its rule says. */
function reader(kind: string, name: unknown) {
  const label = typeof name === "string" ? `${kind} ${name}` : `a ${kind}`;
  const refuse = (path: string, must: string): never => {
    throw new Error(`${label} cannot be read: ${path} must be ${must}`);
  };
  const take = <T>(path: string, value: unknown, [test, must]: Rule): T =>
    test(value) ? (value as T) : refuse(path, must);
  const list = (path: string, value: unknown): unknown[] =>
    Array.isArray(value) ? value : refuse(path, "a list");
  const fields = (path: string, value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : refuse(path, "an object");
  // JSON.parse's own words are V8's, which no other parser repeats; its error stays as the cause.
  // A NUMBER is what SQLite hands back for legs of '5' (the column's affinity is NUMERIC), and it is
  // read as the number it is; anything else that is not text is refused here, rather than by what
  // JSON.parse happens to make of `String(bytes)`
  const json = (path: string, value: unknown): unknown => {
    if (typeof value === "number") return Number.isFinite(value) ? value : refuse(path, "JSON");
    if (value !== null && typeof value !== "string") return refuse(path, "JSON");
    try {
      return fromSqliteJson<unknown>(value);
    } catch (err) {
      throw new Error(`${label} cannot be read: ${path} must be JSON`, { cause: err });
    }
  };
  return { take, list, fields, json };
}

export function toMonitor(row: MonitorRow): Monitor & { id: string } {
  const { take, list, fields, json } = reader("monitor", row.code);
  const monitor = {
    id: take<string>("id", row.id, TEXT),
    code: take<string>("code", row.code, TEXT),
    strike_date: take<string>("strike_date", row.strike_date, TEXT),
    option_type: take<string>("option_type", row.option_type, TEXT),
    strike: take<number>("strike", row.strike, NUMBER),
    field: take<string>("field", row.field, TEXT),
    threshold: take<number>("threshold", row.threshold, NUMBER),
    direction: take<string>("direction", row.direction, TEXT),
    compare: take<string>("compare", row.compare, TEXT),
  };
  const stored = json("legs", row.legs);
  const legs = stored === null ? null : list("legs", stored).map((value, i): MonitorLeg => {
    const leg = fields(`legs[${i}]`, value);
    return {
      sign: take<1 | -1>(`legs[${i}].sign`, leg.sign, SIGN),
      option_type: take<"CALL" | "PUT">(`legs[${i}].option_type`, leg.option_type, OPTION_TYPE),
      strike: take<number>(`legs[${i}].strike`, leg.strike, NUMBER),
    };
  });
  return { ...monitor, legs };
}

export function toPosition(row: PositionRow): Position & { id: string } {
  const { take, list, fields, json } = reader("position", row.name);
  const position = {
    id: take<string>("id", row.id, TEXT),
    name: take<string>("name", row.name, TEXT),
    strategy: take<string | null>("strategy", row.strategy, TEXT_OR_NULL),
    opened_at: take<string | null>("opened_at", row.opened_at, TEXT_OR_NULL),
    strike_date: take<string>("strike_date", row.strike_date, TEXT),
    contracts: take<number>("contracts", row.contracts, WHOLE),
    entry: take<number | null>("entry", row.entry, NUMBER_OR_NULL),
  };
  const legs = list("legs", json("legs", row.legs) ?? []).map((value, i): Leg => {
    const leg = fields(`legs[${i}]`, value);
    return {
      side: take<Side>(`legs[${i}].side`, leg.side, SIDE),
      option_type: take<"CALL" | "PUT">(`legs[${i}].option_type`, leg.option_type, OPTION_TYPE),
      strike: take<number>(`legs[${i}].strike`, leg.strike, NUMBER),
    };
  });
  return { ...position, legs };
}
