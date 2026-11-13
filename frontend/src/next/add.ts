/** The add form's draft (#293, ADR 0023): spreads on one expiry, each held or watched, each with
 *  the two Monitors it usually starts with — and the one request that saves all of it.
 *
 *  Pure, so what a save posts is decided here and tested here; `AddSpread.tsx` only draws it.
 *
 *  - The expiry is typed ONCE for the whole draft: a condor entered as two spreads shares it, and
 *    typing it again per spread and per rule was most of what the old form's 34 clicks were.
 *  - Held: the spread's cost to close at 2x its Entry (the stop) and the short leg's delta at 0.30.
 *    The stop is posted SIGNED — the value at or below minus 2x the Entry, the value being minus
 *    the cost to close — because compared by size it also rang at max profit, where the value of a
 *    condor past its far wing is positive and large (review of #343).
 *    Watched: the same two, at the thresholds typed — an entry signal, not a risk (ADR 0023).
 *    Either can be switched off, and a switched-off one is simply not sent. A structure with no
 *    short leg starts with no delta Monitor: there is no sold leg to watch (#334).
 *  - A spread has two legs to six, each its own side, type and strike (#334): the old dashboard's
 *    combo builder took six, and `POST /spreads` takes six.
 *  - Opened starts as the New York trading day, never the local one: through the Singapore morning
 *    the two differ, and a holding whose Opened is not its first sample's day loses its vol figure
 *    without a word (ADR 0011).
 */
import type { DraftPayoff, Monitor, Payoff } from "../shared/api";
import { isCostToClose } from "./needs";

export type Side = "short" | "long";
export type OptionType = "CALL" | "PUT";

export interface LegDraft {
  /** the leg's own, kept while legs around it come and go: what the form keys its row by, so a
   *  box the owner is typing in stays theirs when a leg above it is removed */
  key: string;
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
  /** null follows the default: on, except for a HELD DEBIT spread, whose stop is a fall in value
   *  that a "2x the Entry, above" rule would get backwards (`valueEnabled`) */
  valueOn: boolean | null;
  /** null follows the default: 2x the Entry when held, nothing when watched */
  valueAt: string | null;
  /** null follows the default: on when the spread has a short leg to watch, off when it has none */
  deltaOn: boolean | null;
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
  /** a leg named watches that contract — on `field`, `option_delta` when not given (the one-contract
   *  form names all three, #331); none named watches the spread's value */
  monitors: {
    option_type?: OptionType; strike?: number; field?: string; threshold: number;
    direction?: "above" | "below"; compare?: "abs" | "signed";
  }[];
}

export interface SpreadsBody {
  strike_date: string;
  spreads: SpreadBody[];
}

export type Preset = "put" | "call" | "condor";

/** A spread's legs, fewest and most: a single contract is the "one contract" form's (#331), and six
 *  is what `POST /spreads` takes (#334). */
export const MIN_LEGS = 2;
export const MAX_LEGS = 6;

/** A held spread's short-leg delta Monitor, unless another is typed (ADR 0023). */
export const HELD_DELTA = "0.30";

let keys = 0;
const nextKey = () => `s${++keys}`;

const leg = (side: Side, option_type: OptionType): LegDraft => ({ key: `l${++keys}`, side, option_type, strike: "" });

const LEGS: Record<Preset, () => LegDraft[]> = {
  put: () => [leg("short", "PUT"), leg("long", "PUT")],
  call: () => [leg("short", "CALL"), leg("long", "CALL")],
  // a condor as ONE holding, the owner's other way of entering one (ADR 0022's consequences)
  condor: () => [leg("short", "PUT"), leg("long", "PUT"), leg("short", "CALL"), leg("long", "CALL")],
};

function spread(preset: Preset): SpreadDraft {
  return {
    key: nextKey(), legs: LEGS[preset](), name: "", entry: "", contracts: "1",
    valueOn: null, valueAt: null, deltaOn: null, deltaAt: null,
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

/** One more leg, long and of the last leg's type until changed — a wing bought further out is the
 *  commonest leg added — or the draft as it was at six. */
export function addLeg(d: AddDraft, key: string): AddDraft {
  const s = d.spreads.find((x) => x.key === key);
  if (!s || s.legs.length >= MAX_LEGS) return d;
  return setSpread(d, key, { legs: [...s.legs, leg("long", s.legs.at(-1)?.option_type ?? "PUT")] });
}

/** The leg at `index` taken out, the others kept in their order — or the draft as it was at two. */
export function removeLeg(d: AddDraft, key: string, index: number): AddDraft {
  const s = d.spreads.find((x) => x.key === key);
  if (!s || s.legs.length <= MIN_LEGS) return d;
  return setSpread(d, key, { legs: s.legs.filter((_, i) => i !== index) });
}

/** Short becomes long and long short: the mistake the preview exists to show (ADR 0023). */
export function flipSide(d: AddDraft, key: string, index: number): AddDraft {
  const s = d.spreads.find((x) => x.key === key);
  const l = s?.legs[index];
  return l ? setLeg(d, key, index, { side: l.side === "short" ? "long" : "short" }) : d;
}

/** `1218_P7150_P7100`: the expiry's month and day, then each leg's type and strike in order — for
 *  one leg or two. From three legs, each type once with its lowest and highest strike,
 *  `1218_P7050-7150_C7700-7800`: every leg spelled out made a six-leg name 40 characters, and the
 *  name is the bot's "contract" cell, which its ~40-column tables cannot carry (review of #343).
 *  26 characters at most for four-digit strikes, whatever the count; the legs themselves are on the
 *  holding and in the rule. */
export function derivedName(expiry: string, legs: Pick<LegDraft, "option_type" | "strike">[]): string {
  const day = expiry.length >= 10 ? `${expiry.slice(5, 7)}${expiry.slice(8, 10)}` : "spread";
  if (legs.length <= 2) return [day, ...legs.map((l) => `${l.option_type[0]}${l.strike.trim()}`)].join("_");
  const types = [...new Set(legs.map((l) => l.option_type))];
  return [day, ...types.map((t) => {
    const ks = [...new Set(legs.filter((l) => l.option_type === t).map((l) => l.strike.trim()).filter((k) => k !== ""))]
      .sort((a, b) => Number(a) - Number(b));
    return `${t[0]}${ks.length <= 1 ? (ks[0] ?? "") : `${ks[0]}-${ks.at(-1)}`}`;
  })].join("_");
}

/** A number as typed, or null for blank or not a number. */
function typed(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** A held spread whose Entry was a DEBIT: paid, typed negative as a Position's Entry is. */
const isDebit = (held: boolean, s: SpreadDraft) => held && (typed(s.entry) ?? 0) < 0;

/** Whether the value Monitor is a held credit spread's stop — its cost to close at or above the
 *  figure, posted signed — rather than a watched spread's value, or a debit's set by hand. */
export const isCreditStop = (held: boolean, s: SpreadDraft) => held && !isDebit(held, s);

/** The value Monitor's default: 2x a credit's Entry when held — the stop — and none when watched,
 *  where the threshold is the owner's entry signal. None for a debit either: its value FALLS as it
 *  loses, and "value ≥ 2x" would ring on a gain. */
export function valueDefault(held: boolean, s: SpreadDraft): string {
  const entry = typed(s.entry);
  return held && entry !== null && entry > 0 ? cents(entry * 2).toFixed(2) : "";
}

/** Whether the value Monitor is on: as switched, or by default on — except for a held debit
 *  spread, where it starts OFF rather than as a rule that rings on a gain (review of #322). The
 *  stop of a debit is a fall in value, and this form does not invent a "below" rule for it. */
export function valueEnabled(held: boolean, s: SpreadDraft): boolean {
  return s.valueOn ?? !isDebit(held, s);
}

/** The words beside the value Monitor. */
export function valueHint(held: boolean, s: SpreadDraft): string {
  if (!held) return "an entry signal";
  return isDebit(held, s) ? "a debit spread's stop is a fall in its value: set one by hand" : "2× the Entry: the stop";
}

/** What closing the legs would cost at expiry with SPX at `x`: the short legs' worth less the
 *  long ones', per contract. Used only to SIGN a watched spread's preview, which must be decided
 *  before the payoff can be asked for; the warning below reads the served payoff instead. */
function costAt(legs: { side: Side; option_type: OptionType; strike: number }[], x: number): number {
  return legs.reduce((sum, l) => {
    const worth = l.option_type === "CALL" ? Math.max(0, x - l.strike) : Math.max(0, l.strike - x);
    return sum + (l.side === "short" ? worth : -worth);
  }, 0);
}

/** The most the legs can cost to close at expiry, and the least; null where it has no ceiling. The
 *  cost bends only at the strikes, so those, zero and one point past the top are all of it. */
function costRange(legs: { side: Side; option_type: OptionType; strike: number }[]): { most: number | null; least: number } {
  const ks = legs.map((l) => l.strike);
  const top = Math.max(...ks);
  const xs = [0, ...ks, top + 1];
  const costs = xs.map((x) => costAt(legs, x));
  const rising = costAt(legs, top + 1) > costAt(legs, top);
  return { most: rising ? null : Math.max(...costs), least: Math.min(...costs) };
}

const legsOf = (s: SpreadDraft) => {
  const ks = strikes(s);
  return ks.some((k) => k === null || k <= 0)
    ? null : s.legs.map((l, j) => ({ side: l.side, option_type: l.option_type, strike: ks[j]! }));
};

/** A held credit spread's stop that can never fire: 2x a rich credit is past what the spread can
 *  ever cost to close. Said, and left on — the owner may mean it.
 *
 *  What it can cost to close is read from the payoff the preview was SERVED (`drawn`, from
 *  `POST /positions/payoff`, `payoffAtExpiry`): its Entry less its max loss, for any number of legs,
 *  rather than worked out again here. Nothing is said until that payoff is this draft's own — a
 *  curve still drawn for the legs before a change warns of nothing — and nothing where it has no
 *  floor (#334). */
export function stopWarning(
  d: AddDraft, s: SpreadDraft, drawn: { key: string; payoff: Payoff } | null,
): string | null {
  if (!d.held || !valueEnabled(d.held, s) || isDebit(d.held, s)) return null;
  const preview = previewOf(d, s);
  const at = typed(valueShown(d.held, s));
  if (preview === null || at === null || drawn === null || drawn.key !== JSON.stringify(preview)) return null;
  if (drawn.payoff.max_loss === null) return null;
  const most = cents(preview.entry - drawn.payoff.max_loss);
  if (at < most) return null;
  return `the stop at ${at.toFixed(2)} can never fire: this spread costs at most ${most.toFixed(2)} to close`;
}

/** Whether a structure is put on for a credit, by its legs alone: one that can only cost to close
 *  was sold, one that can only pay was bought. A structure that can do either (a ratio) is taken
 *  as a credit, the book's usual case (review of #322). */
function soldForCredit(legs: { side: Side; option_type: OptionType; strike: number }[]): boolean {
  const { most, least } = costRange(legs);
  return !(least < 0 && most !== null && most <= 0);
}

/** Whether the delta Monitor is on: as switched, or by default on when there is a short leg to
 *  watch. A structure with no short leg starts with it off rather than refused (#334). */
export function deltaEnabled(s: SpreadDraft): boolean {
  return s.deltaOn ?? s.legs.some((l) => l.side === "short");
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
    if (valueEnabled(d.held, s)) {
      const at = typed(valueShown(d.held, s));
      if (at === null || at <= 0) {
        return { error: d.held && typed(s.entry) === null
          ? `${which}: type the Entry, or the value its Monitor watches for`
          : `${which}: type the value its Monitor watches for` };
      }
      // a held credit's stop is its cost to close at `at` or more: the signed value at or below
      // minus `at`. A watched spread's is the size typed, and a debit's, set by hand, as typed
      monitors.push(isCreditStop(d.held, s)
        ? { threshold: -at, direction: "below", compare: "signed" } : { threshold: at });
    }
    if (deltaEnabled(s)) {
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
  const legs = s.legs.map((l, j) => ({ side: l.side, option_type: l.option_type, strike: ks[j]! }));
  // a held spread's Entry is typed signed; a watched one's threshold is a size (compared `abs`),
  // signed here by what the legs are: a debit spread is bought, at the value it watches for
  const typedAt = typed(d.held ? s.entry : valueShown(false, s)) ?? 0;
  const credit = d.held || soldForCredit(legs) ? typedAt : -typedAt;
  return { legs, entry: cents(credit) || 0, contracts: 1 };
}

/** What a save will make, said on its button: holdings and Monitors, never contracts. */
export function saveWords(d: AddDraft): string {
  const out = spreadsBody(d);
  const monitors = "error" in out
    ? d.spreads.reduce((n, s) => n + (valueEnabled(d.held, s) ? 1 : 0)
      + (deltaEnabled(s) ? s.legs.filter((l) => l.side === "short").length : 0), 0)
    : out.body.spreads.reduce((n, s) => n + s.monitors.length, 0);
  const m = `${monitors} Monitor${monitors === 1 ? "" : "s"}`;
  if (!d.held) return `Watch ${d.spreads.length === 1 ? "it" : `${d.spreads.length} spreads`} + ${m}`;
  const h = d.spreads.length === 1 ? "holding" : `${d.spreads.length} holdings`;
  return `Record ${h} + ${m}`;
}

/** A Contract's code, as the service builds it (`buildSpxCode`): what a delta Monitor is keyed by. */
export function contractCode(expiry: string, type: OptionType, strike: number): string {
  return `US.SPXW${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${type[0]}${Math.trunc(strike)}000`;
}

/** The (code, field) of each Monitor a spread will make, as `POST /spreads` keys them. */
function planned(d: AddDraft, s: SpreadDraft): { code: string; field: string }[] {
  const legs = legsOf(s);
  if (legs === null || d.expiry.length < 10) return [];
  const out: { code: string; field: string }[] = [];
  if (valueEnabled(d.held, s)) out.push({ code: s.name.trim() || derivedName(d.expiry, s.legs), field: "mid_price" });
  if (deltaEnabled(s)) {
    for (const l of legs.filter((x) => x.side === "short")) {
      out.push({ code: contractCode(d.expiry, l.option_type, l.strike), field: "option_delta" });
    }
  }
  return out;
}

/** A rule in words, the way the form names one it will replace. */
export function ruleWords(m: Monitor): string {
  const op = m.direction === "below" ? "≤" : "≥";
  const at = m.threshold.toFixed(2);
  if (m.legs && isCostToClose(m.field, true, m.compare, m.direction, m.threshold)) {
    return `${m.code} cost to close ≥ ${(-m.threshold).toFixed(2)}`;
  }
  if (m.legs) return `${m.code} ${m.field === "mid_price" ? "value" : m.field} ${op} ${at}`;
  const what = m.field === "option_delta" ? (m.compare === "abs" ? "|Δ|" : "Δ") : m.field;
  return `${m.strike} ${m.option_type.toLowerCase()} ${what} ${op} ${at}`;
}

/** Per spread, the WATCH rules saving it will replace (owner's decision on #322): a Monitor already
 *  on a (code, field) a HELD spread makes, owned by no holding, is deleted and the holding's own made
 *  in its place. One another holding owns is refused instead, and a watched spread, or a default
 *  switched off, replaces nothing. Read from the `/monitors` the page already has. */
export function replaces(d: AddDraft, monitors: Monitor[]): string[][] {
  return d.spreads.map((s) => {
    if (!d.held) return [];
    return planned(d, s).flatMap(({ code, field }) => monitors
      .filter((m) => m.code === code && m.field === field && m.positions.length === 0)
      .map(ruleWords));
  });
}

