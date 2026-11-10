/** The building blocks scenario inputs are written with: a world with sensible defaults, rows with
 *  every column filled in, and a book of contracts that agree with each other.
 *
 *  Only the INPUTS use these. What a scenario file holds is the world written out in full — every
 *  column of every row, every setting — so a reader never needs this file to know what a scenario
 *  says, and a second backend never needs it to run one.
 */
import { buildSpxCode } from "optionality/domain/contract";
import type {
  EarlierSweep, HttpRequest, Provider, Row, Tables, Update, Vendor, World,
} from "../format.ts";

/** Monday 9 November 2026, 10:00 in New York: a trading morning, so the market day and the UTC
 *  day agree, and the Singapore display zone is already in the evening. */
export const CLOCK = "2026-11-09T15:00:00.000Z";

/** The clock moved by some seconds, for earlier sweeps and stamps. */
export function at(secondsFromClock: number, clock = CLOCK): string {
  return new Date(new Date(clock).getTime() + secondsFromClock * 1000).toISOString();
}

/** The same instant as the database stores it. */
export function stored(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000`;
}

/** The December monthly, 39 days out on the clock above. */
export const EXPIRY = "2026-12-18";
/** A November weekly, two days before the clock: expired. */
export const EXPIRED = "2026-11-07";

/** The book: an iron condor on the December expiry. */
export const C7300 = buildSpxCode(EXPIRY, "CALL", 7300);
export const C7350 = buildSpxCode(EXPIRY, "CALL", 7350);
export const P6400 = buildSpxCode(EXPIRY, "PUT", 6400);
export const P6350 = buildSpxCode(EXPIRY, "PUT", 6350);
/** A strike nothing holds or watches. */
export const C7500 = buildSpxCode(EXPIRY, "CALL", 7500);

/** What the API and the bot are configured with, as `.env` lines. Telegram is configured so the
 *  sweep speaks; the display zone is the owner's, so a UTC-only reading cannot pass by chance. */
export const SETTINGS: Readonly<Record<string, string>> = {
  API_TOKEN: "tok",
  DISPLAY_TZ: "Asia/Singapore",
  MONITOR_INTERVAL_SECONDS: "15",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_CHAT_ID: "42",
};

export const vendor = (over: Partial<Vendor> = {}): Vendor => ({
  quotes: {}, unknown: [], rejects: {}, down: null, ...over,
});

export const provider = (over: Partial<Provider> = {}): Provider => ({
  name: "moomoo", reachable: true, ...vendor(), ...over,
});

const EMPTY: Tables = {
  positions: [], monitors: [], monitor_positions: [], position_samples: [],
  reference_securities: [],
};

export interface WorldOver {
  clock?: string;
  settings?: Record<string, string>;
  provider?: Partial<Provider>;
  sources?: Record<string, Partial<Vendor>>;
  telegram?: "up" | "down";
  sweeps?: EarlierSweep[];
  tables?: Partial<Tables>;
}

export function world(over: WorldOver = {}): World {
  return {
    clock: over.clock ?? CLOCK,
    settings: { ...SETTINGS, ...over.settings },
    provider: provider(over.provider),
    sources: Object.fromEntries(
      Object.entries(over.sources ?? {}).map(([name, v]) => [name, vendor(v)]),
    ),
    telegram: over.telegram ?? "up",
    sweeps: over.sweeps ?? [],
    tables: { ...EMPTY, ...over.tables },
  };
}

/** A week before the clock, when the book was entered. */
const CREATED = "2026-11-02 14:30:00.000000";

/** A single-leg rule on C7300's delta, armed. */
export function monitor(over: Row & { id: string }): Row {
  const strikeDate = (over.strike_date as string | undefined) ?? EXPIRY;
  const optionType = (over.option_type as string | undefined) ?? "CALL";
  const strike = (over.strike as number | undefined) ?? 7300;
  return {
    // only when not given: a combo's code is its name, and its strike date may be one the domain
    // refuses, which is how a scenario states a row the engine cannot read
    code: over.code ?? buildSpxCode(strikeDate, optionType, strike),
    strike_date: strikeDate, option_type: optionType, strike,
    field: "option_delta", threshold: 0.3, direction: "above", compare: "abs",
    legs: null, scope: null, enabled: 1, disabled_reason: null, triggered: 0,
    last_value: null, last_checked_at: null, last_alarm_at: null, created_at: CREATED,
    ...over,
  };
}

/** The condor's call spread watched as one combo, on its mid. */
export function combo(over: Row & { id: string }): Row {
  return monitor({
    code: "dec-calls", option_type: "CMB", strike: 0, field: "mid_price", threshold: 4,
    direction: "above",
    legs: [
      { sign: -1, option_type: "CALL", strike: 7300 },
      { sign: 1, option_type: "CALL", strike: 7350 },
    ],
    ...over,
  });
}

/** The iron condor, held: short the inner strikes, long the wings, opened four weeks ago. */
export function position(over: Row & { id: string }): Row {
  return {
    name: "dec-condor", strategy: "iron condor", strike_date: EXPIRY, contracts: 1, entry: 6.4,
    legs: [
      { side: "short", option_type: "CALL", strike: 7300 },
      { side: "long", option_type: "CALL", strike: 7350 },
      { side: "short", option_type: "PUT", strike: 6400 },
      { side: "long", option_type: "PUT", strike: 6350 },
    ],
    created_at: CREATED, opened_at: "2026-10-12", manage_notified_at: null,
    closed_on: null, exit: null,
    ...over,
  };
}

export const link = (monitorId: string, positionId: string): Row =>
  ({ monitor_id: monitorId, position_id: positionId });

export function sample(over: Row & { position_id: string; observed_on: string }): Row {
  return { dte: 39, cost_to_close: 3.1, legs_iv: null, legs_vega: null, ...over };
}

export function reference(over: Row & { id: string; code: string }): Row {
  return { label: null, source: "moomoo", created_at: CREATED, ...over };
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** One option's figures as moomoo's mapping names them. */
export function quote(name: string, mid: number, delta: number, over: Row = {}): Row {
  return {
    // rounded, so a quote reads as a broker screen would show it rather than as float noise
    name, mid_price: mid, bid_price: cents(mid - 0.05), ask_price: cents(mid + 0.05), last_price: mid,
    option_delta: delta, option_gamma: 0.00012, option_theta: -0.85, option_vega: 4.25,
    option_implied_volatility: 14.5, option_contract_size: 100,
    ...over,
  };
}

/** The condor's four legs, priced: worth 3.25 to close, the short call at 0.21 delta.
 *
 *  Prices in quarters, which binary floating point holds exactly, so a cost to close reads 3.25
 *  rather than 3.1000000000000005. Both backends would agree on the noise — IEEE arithmetic in the
 *  same order is the same everywhere — but a person reading the file should not have to. */
export const BOOK: Record<string, Row> = {
  [C7300]: quote("SPXW 261218 7300C", 2.75, 0.21),
  [C7350]: quote("SPXW 261218 7350C", 1.75, 0.15),
  [P6400]: quote("SPXW 261218 6400P", 4.5, -0.18, { option_implied_volatility: 19.25 }),
  [P6350]: quote("SPXW 261218 6350P", 2.25, -0.12, { option_implied_volatility: 20 }),
};

/** A table of quotes without some of its codes: what a vendor answers when it prices the rest. */
export function except(quotes: Record<string, Row>, ...codes: string[]): Record<string, Row> {
  return Object.fromEntries(Object.entries(quotes).filter(([code]) => !codes.includes(code)));
}

/** A request as the dashboard sends it: with the bearer token, unless `anonymous`. */
export function request(
  method: string, path: string, body: unknown = null, { anonymous = false } = {},
): HttpRequest {
  return {
    method, path, headers: anonymous ? {} : { Authorization: "Bearer tok" }, body,
  };
}

/** A message typed into the owner's chat, unless another chat is named. */
export function message(text: string, chat: number = 42): Update {
  return { update_id: 1, message: { chat: { id: chat }, text } };
}
