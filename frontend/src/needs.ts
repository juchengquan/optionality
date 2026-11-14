import type { Entry, Health, Holding, Monitor } from "./shared/api";
import { shortContract, shortDate } from "./shared/format";
import { overlapOf } from "./placement";
import { newYorkWeekdayWhen, newYorkWhen } from "./session";

/** What needs you, for the page (ADR 0012, amended by ADR 0023).
 *
 *  The rule is ADR 0012's and unchanged: built only from what the page already polls, it appears
 *  when something needs you and says nothing otherwise, and that silence is not an all-clear. Two
 *  inputs are new. A QUARANTINED rule is a fault, because the service switched it off itself and
 *  nothing now watches what it watched. And a fired rule on the WATCHLIST is an entry signal —
 *  a spread worth selling — which is good news and must not be filed as an alarm.
 *
 *  It was built as a second `needs()` beside the old page's `TopLine.tsx`, which the swap (#301)
 *  deleted; this is the only one.
 */
export type NeedKind = "fault" | "stop" | "alarm" | "entry" | "target" | "manage";

export interface Need {
  kind: NeedKind;
  text: string;
  /** the row it is about — a watchlist entry's id or a holding's — so a banner can lead to it */
  ref?: string;
}

/** Faults lead because they qualify everything after them; then what is bad about something held;
 *  then the good news, an entry signal before a Target because it is the one that will not wait. */
const ORDER: NeedKind[] = ["fault", "stop", "alarm", "entry", "target", "manage"];

/** The three quarantines (CONTEXT.md: Quarantine), each said as the fact about the data it is.
 *  The other reasons a rule is off — muted by hand, expired, its holding closed — are somebody's
 *  choice or the calendar, and are not news. */
export const QUARANTINED: Record<string, string> = {
  "unknown-contract": "the provider does not know its contract",
  "no-figure": "its figure never arrives",
  unreadable: "its stored row cannot be read",
};

/** A rule on the watchlist, rather than one about something held: nothing it watches is held.
 *
 *  The service says so (`held`, `holdsAnyOf`), and this decides nothing about contracts itself.
 *  Not `positions`, the link to ONE holding, which is empty on a roll day — two holdings share a
 *  contract, so it names neither — and that read a held spread's stop as good news. A candidate
 *  sharing a strike with a holding is `held` too, so its signal reads as an alarm: the safe way to
 *  be wrong, and how the old page always read every rule. */
export function isEntrySignal(entry: Entry): boolean {
  return !entry.held;
}

export function entryName(entry: Entry): string {
  return entry.legs ? entry.code : shortContract(entry.quote?.name ?? entry.code);
}

/** A rule as `/monitors` gives it, which carries no quote: a combo by its name, a single leg as
 *  the contract names it everywhere else on the page (`261211 6800P`). */
export function monitorName(monitor: Monitor): string {
  if (monitor.legs) return monitor.code;
  return `${shortDate(monitor.strike_date)} ${monitor.strike}${monitor.option_type[0]}`;
}

/** @param holdings the holdings whose Levels the line says, or null where it says none: in
 *  session they are polled with the watchlist, so their Levels are already paid for; outside it
 *  nothing is.
 *  @param placedBy the holdings the book is DRAWN with, which decide which combos are drawn apart
 *  from their holding (#346) — outside the session, the ones valued once, whose Levels the line
 *  still does not say. The same as `holdings` unless given.
 *  @param levels whether the line says any holding's Levels at all. False outside the session
 *  (#354, the owner's decision (b), re-keyed to the session by #371): not from the holdings, and
 *  not from a rule linked to one either, whose `schedule` is the holding's, served on the
 *  `/quotes` that is still polled there. The holding's own chip says them, as of the valuation it
 *  was drawn from; a line saying them from the poll would contradict it, or say a Level the row
 *  does not show. A rule's own alarm and every fault are said at every hour. */
export function needsYou(
  quotes: Entry[], monitors: Monitor[], health: Health | null, holdings: Holding[] | null,
  placedBy: Holding[] | null = holdings, levels = true,
): Need[] {
  const out: Need[] = [];
  if (health && !health.provider.ok) {
    out.push({ kind: "fault", text: `${health.provider.name} down — the figures are stale` });
  }
  if (health?.monitor.alarms.bad) {
    out.push({ kind: "fault", text: `alarms ${health.monitor.alarms.label}` });
  }
  // A combo the book draws in the watchlist because it only partly overlaps a holding (#346) does
  // not speak for that holding's Levels: the holding is drawn on its own, and says them itself.
  // Without the holdings nothing is compared, and the rule speaks as before.
  const apart = new Set(placedBy === null ? []
    : quotes.filter((e) => overlapOf(e, placedBy) !== null).map((e) => e.id));
  for (const e of quotes) {
    const name = entryName(e);
    if (e.error) out.push({ kind: "fault", text: `${name} — ${e.error}`, ref: e.id });
    // the Levels are the holding's to say when this rule is drawn apart from it
    const schedule = !levels || apart.has(e.id) ? null : e.schedule;
    if (schedule?.reached === "stop") out.push({ kind: "stop", text: `${name} at stop`, ref: e.id });
    if (e.triggered) {
      out.push(isEntrySignal(e)
        ? { kind: "entry", text: `${name} entry signal`, ref: e.id }
        : { kind: "alarm", text: `${name} ringing`, ref: e.id });
    }
    if (schedule?.reached === "target") out.push({ kind: "target", text: `${name} at target`, ref: e.id });
    if (schedule?.manage_by_due) {
      out.push({ kind: "manage", text: `${name} at its manage-by`, ref: e.id });
    }
  }
  for (const m of monitors) {
    const why = !m.enabled && m.disabled_reason ? QUARANTINED[m.disabled_reason] : undefined;
    // named with what it watches: a contract can carry a delta rule and a price rule, and two
    // identical lines would say one thing twice while hiding which rule it was
    const what = fieldWords(m.field, Boolean(m.legs));
    if (why) out.push({ kind: "fault", text: `${monitorName(m)} ${what} quarantined — ${why}` });
  }
  const spokenFor = new Set(
    quotes.filter((e) => !apart.has(e.id)).map((e) => e.schedule?.position_id)
      .filter((id): id is string => Boolean(id)),
  );
  for (const h of levels ? holdings ?? [] : []) {
    if (spokenFor.has(h.id)) continue;
    if (h.schedule?.reached === "stop") out.push({ kind: "stop", text: `${h.name} at stop`, ref: h.id });
    if (h.schedule?.reached === "target") out.push({ kind: "target", text: `${h.name} at target`, ref: h.id });
    if (h.schedule?.manage_by_due) {
      out.push({ kind: "manage", text: `${h.name} at its manage-by`, ref: h.id });
    }
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** The line's tone is its worst item's. Bad: a fault, a stop, an alarm — and an entry signal
 *  when the viewer asked for entries to look like risk. A warning: a manage-by, which is a
 *  deadline rather than good news. Good: an entry signal or a Target reached. */
type Tone = "bad" | "warn" | "good";

export function toneOf(items: Need[], entryLooksLikeRisk: boolean): Tone {
  const bad = items.some((n) => n.kind === "fault" || n.kind === "stop" || n.kind === "alarm"
    || (entryLooksLikeRisk && n.kind === "entry"));
  if (bad) return "bad";
  return items.some((n) => n.kind === "manage") ? "warn" : "good";
}

/** What a rule watches, in words: a combo's figure is the spread's, a leg's is the contract's. */
export function fieldWords(field: string, combo: boolean): string {
  switch (field) {
    case "mid_price": return combo ? "spread value" : "mid";
    case "option_delta": return combo ? "spread delta" : "delta";
    case "option_gamma": return combo ? "spread gamma" : "gamma";
    case "option_theta": return combo ? "spread theta" : "theta";
    case "option_vega": return combo ? "spread vega" : "vega";
    case "option_implied_volatility": return "IV";
    default: return field;
  }
}

/** Fixed places per field (ADR 0023): a price to the cent, a delta to three places so a rule 0.004
 *  away does not read "0.00 away", and gamma to four rather than the six a table once showed. */
const PLACES: Record<string, number> = { option_delta: 3, option_gamma: 4 };

/** Whether a rule is a spread's cost to close at or above a figure: its signed mid at or below a
 *  negative one, since a combo's value is minus what closing it costs (ADR 0013). That is how the
 *  add form posts a held credit's stop (review of #343), and it is said that way rather than as a
 *  negative value. */
export function isCostToClose(
  field: string, combo: boolean, compare: string, direction: string, threshold: number,
): boolean {
  return combo && field === "mid_price" && compare === "signed" && direction === "below" && threshold < 0;
}

/** "|spread value| ≥ 6.01": a rule in words, with no figure — the sentence's first half, and the
 *  whole of what the editor's draft says as it is typed (#292), so the two cannot word it apart.
 *  The threshold is printed as given: typed text in a draft, the stored number in a sentence. */
export function ruleWords(
  field: string, combo: boolean, compare: string, direction: string, threshold: number | string,
): string {
  const sign = direction === "below" ? "≤" : "≥";
  const words = fieldWords(field, combo);
  return `${compare === "abs" ? `|${words}|` : words} ${sign} ${threshold}`;
}

/** A stored rule in words, as `sentence` begins it: a held credit's signed stop said as the cost to
 *  close it watches (`isCostToClose`), anything else as `ruleWords` says it. What the page says to a
 *  pointer and a reader wherever it DRAWS the rule short, so the two never word a stop apart: the
 *  short form draws "close ≥ 4.05", and this says "cost to close ≥ 4.05", never "spread value ≤ -4.05". */
export function storedRuleWords(
  field: string, combo: boolean, compare: string, direction: string, threshold: number,
): string {
  return isCostToClose(field, combo, compare, direction, threshold) ? `cost to close ≥ ${-threshold}`
    : ruleWords(field, combo, compare, direction, threshold);
}

/** "|spread value| ≥ 6.01 — now -2.00, 4.01 away"; "cost to close ≥ 11 — now 2.00, 9.00 away" for a
 *  held credit's signed stop (`isCostToClose`).
 *
 *  Every figure in it is the service's: `watched` is the very figure the bell and the fill bar were
 *  drawn from, and `distance` is the domain's `thresholdDistance` (ADR 0005 — nothing is assembled
 *  here). The threshold is printed as the owner typed it.
 *
 *  Under compare `abs` the rule compares the figure's SIZE, and the bars say so: a credit spread
 *  summed with its short leg negative is a negative figure, and a short put's delta is negative,
 *  so "now -2.00, 4.01 away" reads true beside `|spread value| ≥ 6.01` where it would not beside a
 *  bare "spread value ≥ 6.01". The figure itself is shown as served, never made absolute here. */
export function sentence(entry: Entry): string {
  // a signed stop is said as the cost to close it watches, and its figure as that cost: the
  // distance is the same either way round
  const cost = isCostToClose(entry.field, Boolean(entry.legs), entry.compare, entry.direction, entry.threshold);
  const rule = storedRuleWords(entry.field, Boolean(entry.legs), entry.compare, entry.direction, entry.threshold);
  const places = PLACES[entry.field] ?? 2;
  if (entry.watched === null) {
    // out of the session, the sweep's last reading in it, with its time, beside the dash (#380) — on
    // New York's clock, as the market-closed line names the close, so the page states one clock
    const last = entry.last_reading;
    if (!last) return `${rule} — no figure`;
    const when = newYorkWhen(last.at);
    return `${rule} — no figure out of session; last ${(cost ? -last.value : last.value).toFixed(places)}${when ? ` at ${when}` : ""}`;
  }
  const now = `now ${(cost ? -entry.watched : entry.watched).toFixed(places)}`;
  const d = entry.distance;
  if (d === null) return `${rule} — ${now}`;
  const where = d > 0 ? `${d.toFixed(places)} away`
    : d === 0 ? "at the threshold" : `past it by ${(-d).toFixed(places)}`;
  return `${rule} — ${now}, ${where}`;
}

/** A rule as its short form needs it (#388) — the domain's `RuleShape` (`typescript/src/domain/
 *  alarm.ts`), which the page cannot import: the frontend reaches only the backend. The words below
 *  are the domain's, held to its golden cases (`testdata/golden/alarm.json`) case for case by
 *  `NextRuleShort.test.ts`, so the dashboard and Telegram cannot word a rule apart. */
export interface RuleShape {
  field: string;
  combo: boolean;
  compare: string;
  direction: string;
  threshold: number;
}

/** A served rule's shape: a combo is one that carries legs, as the rest of the page reads it. */
export function shapeOf(r: { field: string; legs?: unknown[] | null; compare: string; direction: string; threshold: number }): RuleShape {
  return {
    field: r.field, combo: Boolean(r.legs), compare: r.compare, direction: r.direction, threshold: r.threshold,
  };
}

/** What a rule watches, as a symbol: `val` a spread's price, `mid` a contract's, and the Greeks'
 *  letters. Vega is `ν`, not `V`, which beside `val` would read as a value. */
export function fieldSymbol(field: string, combo: boolean): string {
  switch (field) {
    case "mid_price": return combo ? "val" : "mid";
    case "option_delta": return "Δ";
    case "option_gamma": return "Γ";
    case "option_theta": return "Θ";
    case "option_vega": return "ν";
    case "option_implied_volatility": return "IV";
    default: return field;
  }
}

const shapeIsCost = (r: RuleShape) => isCostToClose(r.field, r.combo, r.compare, r.direction, r.threshold);
/** whether the rule as SAID is at-or-above, which the arrows follow: a cost to close is said `≥` */
const saysAbove = (r: RuleShape) => shapeIsCost(r) || r.direction !== "below";
/** the real minus, U+2212, as the pace gap writes it */
const minus = (text: string) => (text.startsWith("-") ? `\u2212${text.slice(1)}` : text);

/** "|Δ| ≥ 0.20", "close ≥ 9.44": a rule in symbols (#388). A threshold given as a number is written
 *  to two places at least and to every place it carries; one given as TEXT — a draft being typed —
 *  is written as typed, so the editor's draft is this with the owner's own keystrokes. */
export function shortRule(r: Omit<RuleShape, "threshold"> & { threshold: number | string }): string {
  const typed = typeof r.threshold === "string";
  const cost = !typed && shapeIsCost(r as RuleShape);
  const symbol = fieldSymbol(r.field, r.combo);
  const subject = cost ? "close" : r.compare === "abs" ? `|${symbol}|` : symbol;
  const sign = cost || r.direction !== "below" ? "≥" : "≤";
  if (typeof r.threshold === "string") return `${subject} ${sign} ${r.threshold}`;
  const t = cost ? -r.threshold : r.threshold;
  return `${subject} ${sign} ${minus(t.toFixed(typedPlaces(t)))}`;
}

/** The places a threshold was typed with: two at least, and as many more as it carries. */
function typedPlaces(threshold: number): number {
  let places = 2;
  while (places < 10 && Number(threshold.toFixed(places)) !== threshold) places++;
  return places;
}

/** A figure's and its distance's places: the field's, or the threshold's where it was typed finer. */
const shownPlaces = (r: RuleShape) => Math.max(PLACES[r.field] ?? 2, typedPlaces(r.threshold));

/** A distance never written as zero when it is not: "<0.001" where it rounds away at these places. */
const sizeText = (size: number, places: number) =>
  Number(size.toFixed(places)) === 0 ? `<${(10 ** -places).toFixed(places)}` : size.toFixed(places);

/** The figure as served, to its field's places, with a real minus; for a cost to close, that cost. */
export function shortFigure(r: RuleShape, value: number): string {
  return minus((shapeIsCost(r) ? -value : value).toFixed(shownPlaces(r)));
}

/** "↑0.113", "▲ at", "▲ past 0.050" (`↓`/`▼` for a rule said `≤`): the service's distance
 *  (`thresholdDistance`, ADR 0005), said with an arrow the way the figure — its size, under abs —
 *  must move to reach the threshold. */
export function shortDistance(r: RuleShape, distance: number): string {
  const up = saysAbove(r);
  const places = shownPlaces(r);
  if (distance > 0) return `${up ? "↑" : "↓"}${sizeText(distance, places)}`;
  if (distance === 0) return `${up ? "▲" : "▼"} at`;
  return `${up ? "▲" : "▼"} past ${sizeText(-distance, places)}`;
}

/** The rule's line in the short form (#388), what the page DRAWS — `sentence` stays its title and
 *  its accessible name:
 *
 *    |val| ≥ 4.51   2.10  ↑2.41
 *    |Δ| ≥ 0.20   −0.087  ▲ past 0.050
 *    |val| ≥ 5.51   —  last 3.05 Fri 16:14
 *
 *  Three spaces after the rule and two before the distance, drawn as they are (`white-space:
 *  pre-wrap` on the line). Every figure is the service's, as in `sentence`. */
export function shortSentence(entry: Entry): string {
  const r = shapeOf(entry);
  const rule = shortRule(r);
  if (entry.watched === null) {
    const last = entry.last_reading;
    if (!last) return `${rule}   —`;
    const when = newYorkWeekdayWhen(last.at);
    return `${rule}   —  last ${shortFigure(r, last.value)}${when ? ` ${when}` : ""}`;
  }
  const now = shortFigure(r, entry.watched);
  return entry.distance === null ? `${rule}   ${now}` : `${rule}   ${now}  ${shortDistance(r, entry.distance)}`;
}
