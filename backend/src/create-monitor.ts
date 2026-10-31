/** Creating a monitor, once, for both doors onto it.
 *
 *  There are two: `POST /monitors` and the bot's `/watch` and `/watchcombo`. Each implemented the
 *  same five steps — reject an unusable threshold, reject a non-additive combo field, build the
 *  code, refuse a duplicate, prove the contract exists — and then wrote the row and linked it to
 *  whatever Position already holds its contracts. Two implementations of one feature, and they had
 *  drifted:
 *
 *    the route checked uniqueness and THEN probed the Provider; the bot probed and then checked,
 *      so `/watch` on a contract already watched spent a live Provider call to be told what the
 *      database already knew — against the rule that every call to the Provider is a bounded,
 *      deliberate one (CLAUDE.md's invariants);
 *    the route refused a non-additive combo field before an unusable threshold and the bot did the
 *      reverse, so the same input was answered with two different complaints;
 *    the route could create a rule already muted (`disabled_reason: "manual"`) and the bot could
 *      not, because that argument existed only on one path.
 *
 *  THE ORDER IS THE POINT, not just the sharing. Everything free comes before anything that costs
 *  a Provider call: two local validations, then a lookup in the database, and only then the probe.
 *
 *  What is NOT here: parsing. The route gets a zod-validated payload and the bot gets words typed
 *  into a phone, and turning either into these inputs is that door's own business. What is here
 *  starts once the values are known.
 *
 *  Faults come back as values rather than exceptions, because the two doors answer differently: a
 *  route raises an HTTP status, and the bot writes a sentence to a chat. A `duplicate` carries the
 *  code and the field instead of a message for the same reason — the two already word it their own
 *  way, and this module has no business choosing between "409" and "Already watching".
 */
import type { DatabaseSync } from "node:sqlite";

import { findMonitor, findMonitorByCodeField, insertMonitor } from "./db/queries.ts";
import { atomic } from "./db/open.ts";
import type { MonitorRow } from "./db/rows.ts";
import { newId, toSqliteBool, toSqliteJson } from "./db/values.ts";
import { toSqlDatetime } from "./db/time.ts";
import { buildSpxCode } from "./domain/contract.ts";
import { comboFieldError, thresholdFault } from "./domain/monitor.ts";
import { linkToPositions } from "./monitors.ts";
import {
  DEFAULT_COMBO_FIELD, DEFAULT_COMPARE, DEFAULT_DIRECTION, DEFAULT_ENABLED, DEFAULT_SINGLE_FIELD,
} from "./schemas/monitor.ts";
import { type QuoteFetcher, verifyContracts } from "./quotes.ts";

export interface CreateDeps {
  db: DatabaseSync;
  fetchQuotes: QuoteFetcher;
  now: () => Date;
}

/** The rule's shape, with every default still optional: applying them HERE is what stops the two
 *  doors defaulting differently, which they did by writing the same constants out separately. */
interface Common {
  threshold: number;
  field?: string;
  direction?: string;
  compare?: string;
  enabled?: boolean;
}

export interface SingleInput extends Common {
  strike_date: string;
  option_type: string;
  strike: number;
}

export interface ComboLeg {
  sign: 1 | -1;
  option_type: string;
  strike: number;
}

export interface ComboInput extends Common {
  /** the trader's own name for the combo, which is its code: it prices no single contract */
  name: string;
  strike_date: string;
  legs: ComboLeg[];
}

export type CreateFault =
  /** The rule is `thresholdFault` in the domain; the WORDING is each door's own and stays there.
   *  The bot's is deliberately longer than the API's — it is read without the form that produced
   *  it (bot/format.ts) — so the compare and threshold come back rather than a sentence. */
  | { kind: "threshold"; compare: string; threshold: number }
  | { kind: "combo-field"; message: string }
  | { kind: "unknown-contract"; message: string }
  | { kind: "duplicate"; code: string; field: string };

export function isFault(result: MonitorRow | CreateFault): result is CreateFault {
  return "kind" in result;
}

/** Every column of a new monitor, so neither door writes a half-built row. */
function blank(now: Date, over: Partial<MonitorRow>): MonitorRow {
  return {
    id: newId(),
    code: "",
    strike_date: "",
    option_type: "",
    strike: 0,
    field: "",
    threshold: 0,
    direction: DEFAULT_DIRECTION,
    compare: DEFAULT_COMPARE,
    legs: null,
    scope: null,
    enabled: 1,
    disabled_reason: null,
    triggered: 0,
    last_value: null,
    last_checked_at: null,
    last_alarm_at: null,
    created_at: toSqlDatetime(now),
    ...over,
  } as MonitorRow;
}

/** The shared tail: refuse a duplicate, prove the contracts exist, then write and link.
 *
 *  `contracts` is what the rule WATCHES — the contract itself for a single, the legs for a combo,
 *  whose own code is a name. The probe sees them deduplicated and sorted because that is a batch;
 *  the link sees them as given, because `linkToPositions` matches Positions by contract and a
 *  repeated leg is still the same contract.
 */
async function finish(
  deps: CreateDeps, code: string, field: string, contracts: string[], row: () => MonitorRow,
): Promise<MonitorRow | CreateFault> {
  const { db } = deps;
  if (findMonitorByCodeField(db, code, field)) return { kind: "duplicate", code, field };
  // last, and only now: this is the one step that leaves the machine
  const missing = await verifyContracts([...new Set(contracts)].sort(), deps.fetchQuotes);
  if (missing) return { kind: "unknown-contract", message: missing };
  return atomic(db, () => {
    const inserted = insertMonitor(db, row());
    linkToPositions(db, inserted.id, contracts);
    // re-read, because linking can WRITE to the row it just linked: a rule whose contracts are
    // wholly held by one Position gets `scope: "all"` from linkToPositions, and returning the row
    // as inserted hands the caller a scope of null for a monitor the database says owns the lot.
    return findMonitor(db, inserted.id)!;
  });
}

export async function createSingleMonitor(
  deps: CreateDeps, input: SingleInput,
): Promise<MonitorRow | CreateFault> {
  const compare = input.compare ?? DEFAULT_COMPARE;
  if (thresholdFault(compare, input.threshold)) {
    return { kind: "threshold", compare, threshold: input.threshold };
  }

  const code = buildSpxCode(input.strike_date, input.option_type, input.strike);
  const field = input.field ?? DEFAULT_SINGLE_FIELD;
  const enabled = input.enabled ?? DEFAULT_ENABLED;

  return finish(deps, code, field, [code], () => blank(deps.now(), {
    code,
    strike_date: input.strike_date,
    option_type: input.option_type,
    strike: input.strike,
    field,
    threshold: input.threshold,
    direction: input.direction ?? DEFAULT_DIRECTION,
    compare,
    enabled: toSqliteBool(enabled),
    disabled_reason: enabled ? null : "manual",
  }));
}

export async function createComboMonitor(
  deps: CreateDeps, input: ComboInput,
): Promise<MonitorRow | CreateFault> {
  const field = input.field ?? DEFAULT_COMBO_FIELD;
  // checked here rather than in the schema: inside a union, a refinement's message is buried
  // under the other branch's "field required" errors
  const notAdditive = comboFieldError(field);
  if (notAdditive) return { kind: "combo-field", message: notAdditive };

  const compare = input.compare ?? DEFAULT_COMPARE;
  if (thresholdFault(compare, input.threshold)) {
    return { kind: "threshold", compare, threshold: input.threshold };
  }

  const enabled = input.enabled ?? DEFAULT_ENABLED;
  const legCodes = input.legs.map((l) => buildSpxCode(input.strike_date, l.option_type, l.strike));

  return finish(deps, input.name, field, legCodes, () => blank(deps.now(), {
    code: input.name,
    strike_date: input.strike_date,
    option_type: "CMB",
    strike: 0,
    field,
    threshold: input.threshold,
    direction: input.direction ?? DEFAULT_DIRECTION,
    compare,
    legs: toSqliteJson(input.legs),
    enabled: toSqliteBool(enabled),
    disabled_reason: enabled ? null : "manual",
  }));
}
