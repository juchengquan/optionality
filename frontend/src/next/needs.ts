import type { Entry, Health, Holding, Monitor } from "../shared/api";
import { shortContract, shortDate } from "../shared/format";
import { overlapOf } from "./placement";

/** What needs you, for the redesigned page (ADR 0012, amended by ADR 0023).
 *
 *  The rule is ADR 0012's and unchanged: built only from what the page already polls, it appears
 *  when something needs you and says nothing otherwise, and that silence is not an all-clear. Two
 *  inputs are new. A QUARANTINED rule is a fault, because the service switched it off itself and
 *  nothing now watches what it watched. And a fired rule on the WATCHLIST is an entry signal —
 *  a spread worth selling — which is good news and must not be filed as an alarm.
 *
 *  It was a second `needs()` beside the old page's `TopLine.tsx`, while both pages existed; the
 *  swap (#301) deleted that one.
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

/** @param holdings the holdings whose Levels the line says, or null where it says none: in LIVE
 *  they are polled with the watchlist, so their Levels are already paid for; in REVIEW nothing is.
 *  @param placedBy the holdings the book is DRAWN with, which decide which combos are drawn apart
 *  from their holding (#346) — in REVIEW, the ones valued once on entering it, whose Levels the
 *  line still does not say. The same as `holdings` unless given.
 *  @param levels whether the line says any holding's Levels at all. False in REVIEW (#354, the
 *  owner's decision (b)): not from the holdings, and not from a rule linked to one either, whose
 *  `schedule` is the holding's, served on the `/quotes` that REVIEW still polls. The holding's own
 *  chip says them there, as of the valuation it was drawn from; a line saying them from the poll
 *  would contradict it, or say a Level the row does not show. A rule's own alarm and every fault
 *  are said in either mode. */
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
export type Tone = "bad" | "warn" | "good";

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
  const rule = cost ? `cost to close ≥ ${-entry.threshold}`
    : ruleWords(entry.field, Boolean(entry.legs), entry.compare, entry.direction, entry.threshold);
  if (entry.watched === null) return `${rule} — no figure`;
  const places = PLACES[entry.field] ?? 2;
  const now = `now ${(cost ? -entry.watched : entry.watched).toFixed(places)}`;
  const d = entry.distance;
  if (d === null) return `${rule} — ${now}`;
  const where = d > 0 ? `${d.toFixed(places)} away`
    : d === 0 ? "at the threshold" : `past it by ${(-d).toFixed(places)}`;
  return `${rule} — ${now}, ${where}`;
}
