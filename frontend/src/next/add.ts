/** The add form's draft (#293, ADR 0023): spreads on one expiry, each held or watched, each with
 *  the two Monitors it usually starts with — and the one request that saves all of it.
 *
 *  Pure, so what a save posts is decided here and tested here; `AddSpread.tsx` only draws it.
 *
 *  - The expiry is typed ONCE for the whole draft: a condor entered as two spreads shares it, and
 *    typing it again per spread and per rule was most of what the old form's 34 clicks were.
 *  - Held: the spread's value at 2x its Entry (the stop) and the short leg's delta at 0.30.
 *    Watched: the same two, at the thresholds typed — an entry signal, not a risk (ADR 0023).
 *    Either can be switched off, and a switched-off one is simply not sent.
 *  - Opened starts as the New York trading day, never the local one: through the Singapore morning
 *    the two differ, and a holding whose Opened is not its first sample's day loses its vol figure
 *    without a word (ADR 0011).
 */
import type { DraftPayoff } from "../api";

export type Side = "short" | "long";
export type OptionType = "CALL" | "PUT";

export interface LegDraft {
  side: Side;
  option_type: OptionType;
  /** as typed */
  strike: string;
}

export interface SpreadDraft {
  key: string;
  legs: LegDraft[];
  /** as typed; blank takes `derivedName` */
  name: string;
  /** a holding's, per contract, signed as a Position's: a credit received is positive */
  entry: string;
  contracts: string;
  valueOn: boolean;
  /** null follows the default: 2x the Entry when held, nothing when watched */
  valueAt: string | null;
  deltaOn: boolean;
  /** null follows the default: 0.30 when held, nothing when watched */
  deltaAt: string | null;
}

export interface AddDraft {
  held: boolean;
  /** YYYY-MM-DD, typed once */
  expiry: string;
  /** a held spread's Opened, the New York trading day unless changed */
  opened: string;
  spreads: SpreadDraft[];
}

/** One spread as `POST /spreads` takes it. */
export interface SpreadBody {
  name: string;
  legs: { side: Side; option_type: OptionType; strike: number }[];
  held: boolean;
  entry?: number | null;
  contracts?: number;
  opened_at?: string | null;
  monitors: { option_type?: OptionType; strike?: number; threshold: number }[];
}

export interface SpreadsBody {
  strike_date: string;
  spreads: SpreadBody[];
}

export type Preset = "put" | "call" | "condor";

/** A held spread's short-leg delta Monitor, unless another is typed (ADR 0023). */
export const HELD_DELTA = "0.30";

let keys = 0;
const nextKey = () => `s${++keys}`;

const leg = (side: Side, option_type: OptionType): LegDraft => ({ side, option_type, strike: "" });

const LEGS: Record<Preset, () => LegDraft[]> = {
  put: () => [leg("short", "PUT"), leg("long", "PUT")],
  call: () => [leg("short", "CALL"), leg("long", "CALL")],
  // a condor as ONE holding, the owner's other way of entering one (ADR 0022's consequences)
  condor: () => [leg("short", "PUT"), leg("long", "PUT"), leg("short", "CALL"), leg("long", "CALL")],
};

function spread(preset: Preset): SpreadDraft {
  return {
    key: nextKey(), legs: LEGS[preset](), name: "", entry: "", contracts: "1",
    valueOn: true, valueAt: null, deltaOn: true, deltaAt: null,
  };
}

/** A put spread, held, opened `today` — a New York trading day, which the caller supplies. */
export function newDraft(today: string): AddDraft {
  return { held: true, expiry: "", opened: today, spreads: [spread("put")] };
}

export function addSpread(d: AddDraft, preset: Preset): AddDraft {
  return { ...d, spreads: [...d.spreads, spread(preset)] };
}

export function removeSpread(d: AddDraft, key: string): AddDraft {
  return { ...d, spreads: d.spreads.filter((s) => s.key !== key) };
}

export function setSpread(d: AddDraft, key: string, change: Partial<SpreadDraft>): AddDraft {
  return { ...d, spreads: d.spreads.map((s) => (s.key === key ? { ...s, ...change } : s)) };
}

export function setLeg(d: AddDraft, key: string, index: number, change: Partial<LegDraft>): AddDraft {
  return {
    ...d,
    spreads: d.spreads.map((s) => (s.key !== key ? s : {
      ...s, legs: s.legs.map((l, i) => (i === index ? { ...l, ...change } : l)),
    })),
  };
}

/** Short becomes long and long short: the mistake the preview exists to show (ADR 0023). */
export function flipSide(d: AddDraft, key: string, index: number): AddDraft {
  const s = d.spreads.find((x) => x.key === key);
  const l = s?.legs[index];
  return l ? setLeg(d, key, index, { side: l.side === "short" ? "long" : "short" }) : d;
}

/** `1218_P7150_P7100`: the expiry's month and day, then each leg's type and strike in order. */
export function derivedName(expiry: string, legs: LegDraft[]): string {
  const day = expiry.length >= 10 ? `${expiry.slice(5, 7)}${expiry.slice(8, 10)}` : "spread";
  return [day, ...legs.map((l) => `${l.option_type[0]}${l.strike.trim()}`)].join("_");
}

/** A number as typed, or null for blank or not a number. */
function typed(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The value Monitor's default: 2x the Entry when held — the stop — and none when watched, where
 *  the threshold is the owner's entry signal and has no default. */
export function valueDefault(held: boolean, s: SpreadDraft): string {
  const entry = typed(s.entry);
  return held && entry !== null && entry !== 0 ? cents(Math.abs(entry) * 2).toFixed(2) : "";
}

export function deltaDefault(held: boolean): string {
  return held ? HELD_DELTA : "";
}

/** What the value and delta boxes show: what was typed, or the default. */
export const valueShown = (held: boolean, s: SpreadDraft) => s.valueAt ?? valueDefault(held, s);
export const deltaShown = (held: boolean, s: SpreadDraft) => s.deltaAt ?? deltaDefault(held);

const strikes = (s: SpreadDraft) => s.legs.map((l) => typed(l.strike));

/** The draft as the request that saves it, or the first thing wrong with it. */
export function spreadsBody(d: AddDraft): { body: SpreadsBody } | { error: string } {
  if (d.expiry.trim() === "") return { error: "type the expiry" };
  const spreads: SpreadBody[] = [];
  for (const [i, s] of d.spreads.entries()) {
    const which = `spread ${i + 1}`;
    const ks = strikes(s);
    if (ks.some((k) => k === null || k <= 0)) return { error: `${which}: type every strike` };
    const legs = s.legs.map((l, j) => ({ side: l.side, option_type: l.option_type, strike: ks[j]! }));

    const monitors: SpreadBody["monitors"] = [];
    if (s.valueOn) {
      const at = typed(valueShown(d.held, s));
      if (at === null || at <= 0) {
        return { error: d.held && typed(s.entry) === null
          ? `${which}: type the Entry, or the value its Monitor watches for`
          : `${which}: type the value its Monitor watches for` };
      }
      monitors.push({ threshold: at });
    }
    if (s.deltaOn) {
      const shorts = legs.filter((l) => l.side === "short");
      if (shorts.length === 0) return { error: `${which} has no short leg to watch the delta of: switch that Monitor off` };
      const at = typed(deltaShown(d.held, s));
      if (at === null || at <= 0) return { error: `${which}: type the delta its Monitor watches for` };
      for (const l of shorts) monitors.push({ option_type: l.option_type, strike: l.strike, threshold: at });
    }
    if (!d.held && monitors.length === 0) {
      return { error: `${which} is watched and has no Monitor: switch one on` };
    }

    const name = s.name.trim() || derivedName(d.expiry, s.legs);
    if (!d.held) {
      spreads.push({ name, legs, held: false, monitors });
      continue;
    }
    const entry = typed(s.entry);
    if (s.entry.trim() !== "" && entry === null) return { error: `${which}: the Entry is not a number` };
    const contracts = typed(s.contracts);
    if (contracts === null || !Number.isInteger(contracts) || contracts < 1) {
      return { error: `${which}: contracts is a whole number, 1 or more` };
    }
    spreads.push({
      name, legs, held: true, entry, contracts, opened_at: d.opened.trim() === "" ? null : d.opened, monitors,
    });
  }
  return { body: { strike_date: d.expiry, spreads } };
}

/** The payoff at expiry to preview for one spread, or null until its strikes are typed. PER
 *  CONTRACT, whatever the count: the curve's shape is the same, and a figure multiplied by the
 *  count would say the count, which privacy hides. A held spread is drawn at its Entry, a watched
 *  one at the value it watches for — what it would be sold at when the signal fires. */
export function previewOf(d: AddDraft, s: SpreadDraft): DraftPayoff | null {
  const ks = strikes(s);
  if (ks.some((k) => k === null || k <= 0)) return null;
  const credit = typed(d.held ? s.entry : valueShown(false, s)) ?? 0;
  return {
    legs: s.legs.map((l, j) => ({ side: l.side, option_type: l.option_type, strike: ks[j]! })),
    entry: cents(credit),
    contracts: 1,
  };
}

/** What a save will make, said on its button: holdings and Monitors, never contracts. */
export function saveWords(d: AddDraft): string {
  const out = spreadsBody(d);
  const monitors = "error" in out
    ? d.spreads.reduce((n, s) => n + (s.valueOn ? 1 : 0)
      + (s.deltaOn ? s.legs.filter((l) => l.side === "short").length : 0), 0)
    : out.body.spreads.reduce((n, s) => n + s.monitors.length, 0);
  const m = `${monitors} Monitor${monitors === 1 ? "" : "s"}`;
  if (!d.held) return `Watch ${d.spreads.length === 1 ? "it" : `${d.spreads.length} spreads`} + ${m}`;
  const h = d.spreads.length === 1 ? "holding" : `${d.spreads.length} holdings`;
  return `Record ${h} + ${m}`;
}
