/** A watched row's history, and the days a holding was watched before it was entered (#402), as the
 *  history's charts read them: the burndown, the IV chart and "SPX against the strikes" draw a
 *  `Samples` answer, so each is put in that shape here and the charts take no second kind of day.
 *
 *  - **A watched rule's days** (`/monitors/{id}/samples`) carry each day's PRICE under the rule's own
 *    signs. Drawn as the rule reads it: its size under compare "abs" — a credit spread summed short
 *    leg negative is a negative price, and its rule compares the size — the figure itself under
 *    "signed"; and with no price rule, its size, which for a credit spread is its Cost to close. The
 *    threshold is drawn against it only where a price rule exists (owner's decision, 2026-11-15).
 *  - **A holding's before-entry days** (`before_entry`, valued by the service as its Cost to close by
 *    side) are drawn before its own days, faint, as "before entry". A day the holding has a sample
 *    of its own is its own, never the watch's.
 *
 *  Pure, so each is tested without a chart. */
import type { Entry, Holding, Samples, WatchSamples } from "./shared/api";

/** The figure a watched day is drawn as: what the price rule compares, or the price's size. */
function plotted(price: number, rule: WatchSamples["price_rule"]): number {
  return rule !== null && rule.compare === "signed" ? price : Math.abs(price);
}

/** The threshold a watched row's value is drawn against: its price rule's, as that rule compares
 *  it, or null where none watches the price. */
export function thresholdOf(served: WatchSamples): number | null {
  const rule = served.price_rule;
  return rule === null ? null : rule.compare === "signed" ? rule.threshold : Math.abs(rule.threshold);
}

/** A watched rule's days in the shape the history's charts draw: each day's figure where a holding's
 *  Cost to close would be, with no plan, no Levels and no On-pace — there is no schedule before an
 *  entry. */
export function watchedSamples(served: WatchSamples): Samples {
  return {
    levels: null,
    plan: [],
    samples: served.samples.map(({ price, ...day }) => ({
      ...day,
      cost_to_close: price === null ? null : plotted(price, served.price_rule),
      on_pace: null,
      before_correction: false,
    })),
    qty_corrected_at: null,
    before_entry: [],
  };
}

/** A contract's type and strike, from its moomoo code: `US.SPXW261218C8100000` is the 8100 call. */
function contractOf(code: string): { option_type: "CALL" | "PUT"; strike: number } | null {
  const m = /^US\.SPXW?\d{6}([CP])(\d+)$/.exec(code);
  return m ? { option_type: m[1] === "C" ? "CALL" : "PUT", strike: Number(m[2]) / 1000 } : null;
}

/** What the charts draw a watched row from, as they draw a holding: its legs — minus is short, as the
 *  watchlist's own payoff and strike strip read them — one contract, and no valuation of "now". A
 *  single contract is drawn as the strike it watches: as a short leg is, which is what a strike's
 *  delta rule watches (ADR 0023 sits it under its spread). */
export type WatchedCharted = Pick<Holding, "id" | "contracts" | "legs" | "strike_date" | "closed_on">;

export function watchedCharted(entry: Entry): WatchedCharted {
  const legs: Holding["legs"] = entry.legs && entry.legs.length > 0
    ? entry.legs.map((l) => ({
      side: l.sign < 0 ? "short" as const : "long" as const,
      option_type: l.option_type as "CALL" | "PUT", strike: l.strike,
      ...(l.qty === undefined || l.qty === 1 ? {} : { qty: l.qty }),
    }))
    : (() => {
      const c = contractOf(entry.code);
      return c === null ? [] : [{ side: "short" as const, ...c }];
    })();
  return { id: entry.id, contracts: 1, legs, strike_date: entry.strike_date, closed_on: null };
}

/** A holding's samples with the days it was watched before it was entered drawn first (#402): the
 *  service's `before_entry`, less any day the holding has a sample of its own. */
export function withBeforeEntry(served: Samples): Samples {
  const own = new Set(served.samples.map((s) => s.observed_on));
  const before = (served.before_entry ?? []).filter((s) => !own.has(s.observed_on));
  if (before.length === 0) return { ...served, before_entry: [] };
  return { ...served, samples: [...before, ...served.samples], before_entry: before };
}

/** The days of an answer that are before entry, by their market day. */
export function beforeEntryDays(served: Samples): ReadonlySet<string> {
  return new Set((served.before_entry ?? []).map((s) => s.observed_on));
}

/** How a before-entry day is said, in the tooltips and the status lines. */
export const BEFORE_ENTRY_WORDS = "before entry: watched, not yet held";

/** What a watched spread's payoff is drawn at, with no Entry (#402): the price a curve takes as its
 *  credit — the negative of the spread's value, minus being short — and where it is from.
 *
 *  - **Out of the session, always its last close** (`last_close`), never the Provider's
 *    out-of-hours quote: the payoff is drawn at a close, as a holding is valued from one (#380).
 *  - **In the session, live**, where the rule watches the price and has one now; else its last close
 *    — a spread watched only on its delta has no price on its row at all.
 *  - **Nothing** where neither is there, and the reason why. */
export type PayoffAt =
  | { value: number; from: "live" }
  | { value: number; from: "close"; close: NonNullable<Entry["last_close"]> }
  | { value: null; blank: string };

export function payoffAt(entry: Entry, session: boolean, priced: boolean): PayoffAt {
  const live = priced && typeof entry.combo_value === "number" ? entry.combo_value : null;
  if (session && live !== null) return { value: live, from: "live" };
  const close = entry.last_close ?? null;
  if (close !== null) return { value: close.price, from: "close", close };
  if (!session) return { value: null, blank: "no close recorded to draw it at" };
  return { value: null, blank: priced ? "no current value to draw it at" : "no price to draw it at, and no close is recorded" };
}

/** What a close is called beside the figure drawn at it: the day's close only where it was one
 *  (`timing`), so an evening's or a Saturday's reading is never passed off as a close. */
export function closeWords(close: NonNullable<Entry["last_close"]>): string {
  switch (close.timing) {
    case "close": return "its close";
    case "after-close": return "its reading after the close";
    case "before-open": return "its reading before the open";
    case "weekend": return "its weekend reading";
    default: return "its last reading";
  }
}
