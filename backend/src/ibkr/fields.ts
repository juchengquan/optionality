/** Turning a Client Portal snapshot row into the record the service reads (ADR 0015).
 *
 *  The counterpart of `opend/snapshot.ts`, and it carries the same warning: this is the one place
 *  in the client where a wrong name or a wrong reading is SILENT. A missing `option_delta` does
 *  not throw — it makes five of the owner's monitors stop alarming, which is why #167 made that
 *  silence a notice before this file existed.
 *
 *  Two differences from moomoo's mapping are structural rather than cosmetic:
 *
 *  - **Every figure arrives as a string**, and not always a bare one. The gateway prefixes a price
 *    with `C` while the market is shut and `H` while the contract is halted, separates thousands,
 *    and abbreviates volume for display. So nothing here trusts `Number()` with what it was sent.
 *  - **The multiplier is not in the snapshot.** moomoo reports `option_contract_size` per quote;
 *    IBKR has it on the security definition, so the conid cache carries it in and this stamps it
 *    on. Every P&L figure in the service is points times that number.
 *
 *  What is deliberately NOT here: `update_time`. moomoo's means LAST TRADE and nothing in the
 *  reference has been confirmed to mean the same, so the column reads "—" rather than reading some
 *  other timestamp as a trade. One of PR 6's questions.
 */
import type { SnapshotRow } from "./types.ts";
import { compactStrikeDate, type SpxContract } from "../domain/contract.ts";
import type { Quote } from "../domain/quote.ts";

/** A resolved contract: what the service calls it, what IBKR calls it, and what the security
 *  definition said about it. `conids.ts` builds these; this module consumes them. */
export interface ContractSpec {
  /** the service's own spelling, which keys everything downstream */
  code: string;
  conid: number;
  /** the points-to-money multiplier from `secdef/info`, absent if the gateway omitted it */
  multiplier?: number;
  contract: SpxContract;
}

/** Each field id this client requests, and the record key it becomes.
 *
 *  Exactly the figures the service consumes — the dashboard's columns, the bot's tables and the
 *  domain's maths — as `opend/snapshot.ts` does for the other provider. Rho is absent because the
 *  Client Portal exposes no rho; nothing reads it.
 */
const MAPPING: Record<string, string> = {
  "31": "last_price",
  "70": "high_price",
  "71": "low_price",
  "84": "bid_price",
  "85": "ask_vol",
  "86": "ask_price",
  "87": "volume",
  "88": "bid_vol",
  "7295": "open_price",
  "7296": "prev_close_price",
  "7308": "option_delta",
  "7309": "option_gamma",
  "7310": "option_theta",
  "7311": "option_vega",
  // a PERCENT, as moomoo's is: 18.5 means 18.5%. The one field where agreeing on the number is
  // not enough — PR 6 compares both providers on the same contract at the same instant, and a
  // factor of 100 here would pass every test and corrupt every stored sample.
  "7633": "option_implied_volatility",
};

/** The `fields=` parameter, built from the mapping so the two cannot drift: a field requested and
 *  unmapped is a wasted entitlement, and a field mapped and never requested never arrives. */
export const SNAPSHOT_FIELDS = Object.keys(MAPPING).join(",");

/** Suffixes the gateway uses on volume, which is a display string where every other field is a
 *  number. */
const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

/** One of the gateway's strings as a number, or undefined for anything that is not one.
 *
 *  Undefined and never NaN: the domain reads an absent figure as "no complete value — do not
 *  alarm", and reads NaN as a number it can compare. An unreadable greek must be the first.
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  // the leading C or H is a freshness marker (close, halted), the commas are display, the % is
  // the unit the key already states
  let text = value.trim().replace(/^[A-Za-z]/, "").replace(/,/g, "").replace(/%$/, "");
  let scale = 1;
  const last = text.slice(-1).toUpperCase();
  if (SUFFIX[last] !== undefined) {
    scale = SUFFIX[last]!;
    text = text.slice(0, -1);
  }
  if (text === "" || !/^[-+]?\d*\.?\d+$/.test(text)) return undefined;
  const n = Number(text) * scale;
  return Number.isFinite(n) ? n : undefined;
}

/** `SPXW 261030 8100.00C`, which is how moomoo spells it and therefore how the dashboard and every
 *  alarm message already read. Deliberately imitated: `name` is a label, and a row that renamed
 *  itself because the deployment changed provider would read as a different contract. */
export function contractName(contract: SpxContract): string {
  const date = compactStrikeDate(contract.strike_date);
  return `SPXW ${date} ${contract.strike.toFixed(2)}${contract.option_type === "CALL" ? "C" : "P"}`;
}

/** Whether a row carries at least one of the figures that were asked for.
 *
 *  The retry above this reads it, and so does the decision to emit a record at all: a row with the
 *  conid and nothing else is the gateway saying "subscribed, nothing yet", which is a figure that
 *  did not arrive — counted by the sweep and quarantined with a notice after N of them (#167) —
 *  and NOT a contract that does not exist. Those two answers are different and the port keeps them
 *  apart (#168).
 */
export function hasFigures(row: SnapshotRow): boolean {
  return Object.keys(MAPPING).some((id) => toNumber(row[id]) !== undefined);
}

function put(into: Quote, key: string, value: unknown): void {
  if (value !== undefined && value !== null) into[key] = value;
}

/** One row, as the record the sweep, the routes and the bot read.
 *
 *  Keyed by the service's code and not the conid: nothing downstream knows a conid exists, and
 *  `position_samples` keeps its contract-code keys whichever provider filled them.
 */
export function toRecord(spec: ContractSpec, row: SnapshotRow): Quote {
  const record: Quote = { code: spec.code };

  for (const [id, key] of Object.entries(MAPPING)) put(record, key, toNumber(row[id]));

  // what the code and the definition already say, rather than fields asked of the gateway: these
  // are not market data and cannot be stale
  put(record, "name", contractName(spec.contract));
  put(record, "option_type", spec.contract.option_type);
  put(record, "option_strike_price", spec.contract.strike);
  put(record, "option_contract_size", spec.multiplier);

  const bid = record.bid_price;
  const ask = record.ask_price;
  if (typeof bid === "number" && typeof ask === "number") record.mid_price = (bid + ask) / 2;
  return record;
}
