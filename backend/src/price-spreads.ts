/** Pricing any SPX structure an agent names, live, in one bounded call (#452, ADR 0027): the service
 *  behind `GET /spreads/quote`, paired with `routes/spreads.ts`.
 *
 *  Three parts, in the order a request meets them:
 *
 *    1. **The grammar** (`parseSpreads`): `<expiry>:<legs>[@<entry>]`, one per `spread=`, every
 *       refusal decided here, before anything leaves the machine.
 *    2. **The budget** (`SpreadPricer`): ONE Provider batch for every distinct leg of every
 *       structure, shared for `SHARED_FOR_MS` by any request that normalises to the same one, and at
 *       most `spreadQuoteCallsPer30s` of them in any 30 seconds whoever asks — the HTTP door and the
 *       MCP door reach this one instance through the one app, so they share both. A batch in flight
 *       is joined; a cached one spends nothing.
 *    3. **The answer** (`priceStructures`): each structure valued from that batch by the domain's own
 *       functions — `comboFieldSum` for the value and the greeks, `naturalPrice`, `strikeDistances`,
 *       `payoffAtExpiry` — all reckoned at the instant the batch was fetched, so a cached answer is
 *       the same answer. Each leg says its last stored regular-session close beside it, never summed.
 *
 *  It never trades and never writes: the only call that leaves the machine is the market-data batch,
 *  the bounded call CLAUDE.md's first invariant names for this route.
 */
import type { DatabaseSync } from "node:sqlite";

import { buildSpxCode, normalizeStrikeDate } from "optionality/domain/contract";
import { closeSample, daysToExpiry, inSession, marketDate, marketPhase, valuedTiming, type MarketPhase } from "optionality/domain/expiry";
import { COMBO_GREEK_FIELDS, comboFieldSum, type Monitor, type MonitorLeg } from "optionality/domain/monitor";
import { type Payoff, payoffAtExpiry } from "optionality/domain/payoff";
import type { Leg } from "optionality/domain/position";
import {
  type ByCode, type NaturalPrice, derivedSpx, displayRecords, midPrice, naturalPrice, sessionSpx,
  strikeDistances, type StrikeDistance,
} from "optionality/domain/quote";
import { displayTime } from "optionality/domain/timefmt";
import type { QuoteBatch, QuoteFetcher } from "optionality/quotes";
import { pricedWatchSamplesHolding } from "./db/queries/index.ts";
import { displayStored } from "./db/time.ts";
import { MAX_LEG_QTY } from "./schemas/position.ts";
import { MAX_PROBE_LEGS } from "./schemas/spread.ts";
import { LAST_CLOSE_DAYS, type LastClose, storedLegMap } from "./watch-history.ts";

/** How long a batch is shared by the requests that normalise to it (#452: "5-second shared cache"),
 *  the MCP door's `LIVE_FOR_MS` by another name, because here it is the route's. */
export const SHARED_FOR_MS = 5000;
/** The window `spreadQuoteCallsPer30s` counts calls over. */
export const CAP_WINDOW_MS = 30_000;
/** The most legs one structure may have: `POST /spreads`' six (#334). */
export const MAX_STRUCTURE_LEGS = 6;

export interface PricedLeg {
  side: "short" | "long";
  option_type: "CALL" | "PUT";
  strike: number;
  qty: number;
}

/** One structure as asked for: its expiry (YYYY-MM-DD), its legs in the order given, its Entry. */
export interface Structure {
  expiry: string;
  legs: PricedLeg[];
  entry: number | null;
}

export interface QuoteFault {
  status: 422 | 429;
  message: string;
}

const refuse = (message: string, status: 422 | 429 = 422): QuoteFault => ({ status, message });

const STRUCTURE = /^([^:@]*):([^@]*)(?:@(-?\d+(?:\.\d+)?))?$/;
/** A raw `+` in a query string arrives as a space, so a space where a sign goes reads as `+`. */
const LEG = /^([-+ ])([CP])([1-9]\d*)(?:x(\d+))?$/;
const EXAMPLE = "e.g. ?spread=20261218:-P6800,%2BP6750";

/** The structures `given` asks for, or why not — every refusal before any Provider call (ADR 0027):
 *  no `spread`, a structure or a leg that is not the grammar, a quantity outside 1–10, an expiry
 *  before New York's market day (the sweep's own rule for an expired rule), more than
 *  `MAX_STRUCTURE_LEGS` in a structure, more than `MAX_PROBE_LEGS` in all. */
export function parseSpreads(given: string[], now: Date): Structure[] | QuoteFault {
  if (given.length === 0) return refuse(`give at least one spread: ?spread=<expiry>:<legs>, ${EXAMPLE}`);
  const today = marketDate(now);
  const out: Structure[] = [];
  for (const [i, raw] of given.entries()) {
    const which = `spread ${i + 1}`;
    const whole = STRUCTURE.exec(raw);
    if (whole === null) {
      return refuse(`${which} "${raw}" is not <expiry>:<legs>[@<entry>], e.g. 20261218:-P6800,+P6750@1.25`);
    }
    const [, date, legText, entryText] = whole;
    let expiry: string;
    try {
      expiry = normalizeStrikeDate(date!);
    } catch {
      return refuse(`${which}: invalid expiry '${date}': use YYYYMMDD or YYYY-MM-DD`);
    }
    const legs: PricedLeg[] = [];
    for (const [j, text] of legText!.split(",").entries()) {
      const m = LEG.exec(text);
      if (m === null) {
        return refuse(`${which}, leg ${j + 1} "${text}" is not ±<C|P><strike>[x<qty>], e.g. -P6800 or +C7350x2`);
      }
      const qty = m[4] === undefined ? 1 : Number(m[4]);
      if (qty < 1 || qty > MAX_LEG_QTY) {
        return refuse(`${which}, leg ${j + 1}: a quantity is 1 to ${MAX_LEG_QTY}, not ${m[4]}`);
      }
      legs.push({ side: m[1] === "-" ? "short" : "long", option_type: m[2] === "C" ? "CALL" : "PUT", strike: Number(m[3]), qty });
    }
    if (legs.length > MAX_STRUCTURE_LEGS) {
      return refuse(`${which} has ${legs.length} legs: at most ${MAX_STRUCTURE_LEGS} in a spread`);
    }
    if (expiry < today) return refuse(`${which}: ${date} has expired`);
    out.push({ expiry, legs, entry: entryText === undefined ? null : Number(entryText) });
  }
  const legCount = out.reduce((n, s) => n + s.legs.length, 0);
  if (legCount > MAX_PROBE_LEGS) {
    return refuse(`this request has ${legCount} legs: at most ${MAX_PROBE_LEGS} in one request`);
  }
  return out;
}

const legCode = (expiry: string, l: PricedLeg) => buildSpxCode(expiry, l.option_type, l.strike);

/** The key a request is shared under: each structure's expiry, legs and entry in a fixed order, and
 *  the structures in a fixed order — so the same structures asked another way round are one key. */
export function normalised(structures: Structure[]): string {
  return structures
    .map((s) => `${s.expiry} ${s.legs.map((l) => `${l.side} ${l.option_type} ${l.strike} x${l.qty}`).sort().join(",")} @${s.entry ?? ""}`)
    .sort()
    .join("|");
}

/** One leg as answered: as asked, its code, the quote's figures, its mid by `midPrice`'s one rule,
 *  why it has no mid, and its last stored regular-session close. */
export interface LegQuote extends PricedLeg {
  code: string;
  bid_price: number | null;
  ask_price: number | null;
  mid_price: number | null;
  option_implied_volatility: number | null;
  option_delta: number | null;
  option_gamma: number | null;
  option_theta: number | null;
  option_vega: number | null;
  option_contract_size: number | null;
  fetched_at: string | null;
  error: string | null;
  last_known: LastClose | null;
}

export type PayoffBasis = "entry" | "mid" | "shape";

/** A payoff as served: `payoffAtExpiry`'s, with the three figures a shape cannot have null. */
export type ServedPayoff = Omit<Payoff, "breakevens"> & { breakevens: number[] | null };

export interface StructureQuote {
  expiry: string;
  dte: number;
  entry: number | null;
  legs: LegQuote[];
  value: number | null;
  natural: NaturalPrice | null;
  greeks: Record<(typeof COMBO_GREEK_FIELDS)[number], number | null>;
  spx: number | null;
  spx_reason: string | null;
  short_strikes: StrikeDistance[];
  payoff: ServedPayoff | null;
  payoff_basis: PayoffBasis | null;
  error: string | null;
}

export interface SpreadsQuote {
  phase: MarketPhase;
  fetched_at: string | null;
  spreads: StructureQuote[];
}

/** A figure from the wire, or null for anything that is not a finite number. */
const figure = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Each contract's last stored REGULAR-SESSION close, from any watched set holding it (`watch_samples`,
 *  the one table that stores a contract's own mid), chosen as `lastCloses` chooses a rule's: by
 *  `closeSample` over the latest `LAST_CLOSE_DAYS` priced days, today's left out while the session
 *  runs, since it is the session so far. Null where no such row has one. */
export function lastKnownCloses(db: DatabaseSync, codes: string[], tz: string, now: Date): Map<string, LastClose | null> {
  const today = inSession(now) ? marketDate(now) : null;
  const out = new Map<string, LastClose | null>();
  for (const code of codes) {
    const days = pricedWatchSamplesHolding(db, code, LAST_CLOSE_DAYS)
      .filter((s) => s.observed_on !== today)
      .map((s) => ({ ...s, cost_to_close: storedLegMap(s.legs_mid)?.[code] ?? null }));
    const close = closeSample(days);
    if (close === null || close.cost_to_close === null) { out.set(code, null); continue; }
    const timing = valuedTiming(close.observed_at);
    out.set(code, {
      price: close.cost_to_close,
      observed_on: close.observed_on,
      observed_at: timing === "unrecorded" ? null : displayStored(close.observed_at, tz),
      timing,
    });
  }
  return out;
}

/** The structures valued from one batch fetched at `at`, in the order asked (ADR 0027). */
export function priceStructures(
  structures: Structure[], batch: QuoteBatch, at: Date, displayTz: string,
  lastKnown: Map<string, LastClose | null>,
): SpreadsQuote {
  const byCode = displayRecords(batch.records, displayTz, at);
  // every leg's mid by the one rule, from its own two sides, whatever the vendor sent beside them
  const withMids: ByCode = Object.fromEntries(Object.entries(byCode).map(([code, r]) =>
    [code, { ...r, mid_price: midPrice(r.bid_price, r.ask_price) }]));
  const unknown = new Set(batch.unknown);
  // once for the batch: every structure was priced by it, as every row of /quotes is
  const spx = sessionSpx(at, derivedSpx(batch.records));

  const spreads = structures.map((s): StructureQuote => {
    const codes = s.legs.map((l) => legCode(s.expiry, l));
    const dte = daysToExpiry(s.expiry, at);
    const legs = s.legs.map((l, i): LegQuote => {
      const code = codes[i]!;
      const record = byCode[code];
      const mid = withMids[code]?.mid_price as number | null | undefined ?? null;
      const error = unknown.has(code) ? "unknown contract"
        : record === undefined ? "no quote returned"
          : mid === null ? "no two-sided quote" : null;
      return {
        ...l, code,
        bid_price: figure(record?.bid_price),
        ask_price: figure(record?.ask_price),
        mid_price: mid,
        option_implied_volatility: figure(record?.option_implied_volatility),
        option_delta: figure(record?.option_delta),
        option_gamma: figure(record?.option_gamma),
        option_theta: figure(record?.option_theta),
        option_vega: figure(record?.option_vega),
        option_contract_size: figure(record?.option_contract_size),
        fetched_at: record === undefined ? null : (record.fetched_at as string | null),
        error,
        last_known: lastKnown.get(code) ?? null,
      };
    });
    const signed: MonitorLeg[] = s.legs.map((l) => ({
      sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike, qty: l.qty,
    }));
    const combo: Monitor = {
      code: "", strike_date: s.expiry, option_type: "CMB", strike: 0, field: "mid_price", threshold: 0,
      direction: "above", compare: "abs", legs: signed,
    };
    const shortStrikes = strikeDistances(codes.filter((_, i) => s.legs[i]!.side === "short"), withMids, spx.price, dte);
    const missing = [...new Set(codes.filter((c) => unknown.has(c)))];
    const common = {
      expiry: s.expiry, dte, entry: s.entry, legs, spx: spx.price, spx_reason: spx.reason,
      short_strikes: shortStrikes,
    };
    if (missing.length > 0) {
      return {
        ...common, value: null, natural: null,
        greeks: Object.fromEntries(COMBO_GREEK_FIELDS.map((f) => [f, null])) as StructureQuote["greeks"],
        payoff: null, payoff_basis: null, error: `unknown contract: ${missing.join(", ")}`,
      };
    }
    const value = comboFieldSum(combo, withMids, "mid_price");
    const asLegs: Leg[] = s.legs.map((l) => ({ side: l.side, option_type: l.option_type, strike: l.strike, qty: l.qty }));
    let payoff: ServedPayoff;
    let basis: PayoffBasis;
    if (s.entry !== null) {
      [payoff, basis] = [payoffAtExpiry(asLegs, s.entry, 1), "entry"];
    } else if (value !== null) {
      // opening at the mid: a long's mid is paid, so the Entry it would be is the value's negative
      [payoff, basis] = [payoffAtExpiry(asLegs, -value, 1), "mid"];
    } else {
      // no price paid, so no P&L: the legs' own value at expiry, and nothing said of breaking even
      [payoff, basis] = [{ ...payoffAtExpiry(asLegs, 0, 1), breakevens: null, max_profit: null, max_loss: null }, "shape"];
    }
    return {
      ...common,
      value,
      natural: naturalPrice(codes.map((code, i) => ({ code, sign: signed[i]!.sign, qty: s.legs[i]!.qty })), withMids),
      greeks: Object.fromEntries(COMBO_GREEK_FIELDS.map((f) => [f, comboFieldSum(combo, withMids, f)])) as StructureQuote["greeks"],
      payoff, payoff_basis: basis, error: null,
    };
  });
  return { phase: marketPhase(at), fetched_at: displayTime(at, displayTz), spreads };
}

export interface PricerDeps {
  db: DatabaseSync;
  fetchQuotes: QuoteFetcher;
  now: () => Date;
  displayTz: string;
  /** `SPREAD_QUOTE_CALLS_PER_30S` */
  callsPer30s: number;
}

/** A batch asked for at `at`: shared until it is `SHARED_FOR_MS` old, failed or not. */
interface Reading {
  at: Date;
  batch: Promise<QuoteBatch>;
}

/** What a request comes to: an answer, a refusal, or the Provider's failure for the route to word. */
export type Priced = { answer: SpreadsQuote } | { refused: QuoteFault } | { failed: unknown };

/** The budget and the cache, one per app: every caller of `GET /spreads/quote` shares them. */
export class SpreadPricer {
  private readonly deps: PricerDeps;
  /** batches by normalised request, each until it is `SHARED_FOR_MS` old */
  private readonly shared = new Map<string, Reading>();
  /** when each Provider call was made, the oldest first, for as long as it counts */
  private readonly calls: number[] = [];

  constructor(deps: PricerDeps) {
    this.deps = deps;
  }

  async price(given: string[]): Promise<Priced> {
    const now = this.deps.now();
    const structures = parseSpreads(given, now);
    if (!Array.isArray(structures)) return { refused: structures };
    const key = normalised(structures);
    const t = now.getTime();
    // forget what can no longer be shared or counted; a clock that went BACK trusts nothing old
    for (const [k, r] of this.shared) {
      const age = t - r.at.getTime();
      if (age < 0 || age >= SHARED_FOR_MS) this.shared.delete(k);
    }
    while (this.calls.length > 0 && t - this.calls[0]! >= CAP_WINDOW_MS) this.calls.shift();

    let reading = this.shared.get(key);
    if (reading === undefined) {
      const cap = this.deps.callsPer30s;
      if (this.calls.length >= cap) {
        const wait = Math.max(1, Math.ceil((Math.min(...this.calls) + CAP_WINDOW_MS - t) / 1000));
        return {
          refused: refuse(`spread quotes are capped at ${cap} Provider calls in 30 seconds: the next is allowed in ${wait}s`, 429),
        };
      }
      const codes = [...new Set(structures.flatMap((s) => s.legs.map((l) => legCode(s.expiry, l))))].sort();
      this.calls.push(t);
      reading = { at: now, batch: this.deps.fetchQuotes(codes) };
      // a failure is shared like an answer, so a Provider that is down is asked once per window;
      // marked handled here, since a caller may never come back for it
      reading.batch.catch(() => { /* each caller sees it when it awaits */ });
      this.shared.set(key, reading);
    }
    let batch: QuoteBatch;
    try {
      batch = await reading.batch;
    } catch (err) {
      return { failed: err };
    }
    const codes = [...new Set(structures.flatMap((s) => s.legs.map((l) => legCode(s.expiry, l))))];
    const lastKnown = lastKnownCloses(this.deps.db, codes, this.deps.displayTz, reading.at);
    return { answer: priceStructures(structures, batch, reading.at, this.deps.displayTz, lastKnown) };
  }
}
