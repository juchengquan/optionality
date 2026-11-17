/** The burndown's arithmetic and words (#360), apart from its drawing (`BurndownChart.tsx`): how a Cost
 *  to close is said, which day a pointer or a key means, the value axis — and where it leaves a Stop
 *  it does not reach — where the crosshair's tooltip goes, and what it and the status line say.
 *
 *  Pure, so each is tested without a chart; the chart only draws what these decide. */
import { fixed, moneyPlain, tick } from "./shared/numbers";
import { scaleLinear } from "@visx/scale";

import type { Sample, Samples } from "./shared/api";
import { writtenDate } from "./shared/times";
import { paceOutcome, paceWords } from "./pace";

/** How a Cost to close is said: money across the contracts at the contract size the valuation
 *  served, and points per contract without one — or under privacy, which hides dollars and anything
 *  across the contracts held but keeps the per-contract points, as the table's value column, the
 *  inspector's Entry, Target and Stop and the payoff do (the owner's call, #395). */
export interface Unit {
  size: number;
  contracts: number;
  money: boolean;
  hidden: boolean;
  /** what the figure is called in the readouts: "to close" for a holding, "value" for a watched
   *  row's history (#402) */
  what?: string;
}


/** A day with a Cost to close. A day may have none (#380): out of hours a leg has no two-sided
 *  quote — moomoo quotes 0/0 — and the sweep keeps the day for its vol readings with the cost left
 *  empty. Such a day is a row (it is not a missed day), and is not a point on the burndown. */
export type PricedSample = Sample & { cost_to_close: number };
export const hasCost = (s: Sample): s is PricedSample => s.cost_to_close !== null;

/** Whether a figure is said as money across the contracts: never under privacy. */
const inMoney = (unit: Unit) => unit.money && !unit.hidden;

export function say(points: number, unit: Unit): string {
  if (inMoney(unit)) return moneyPlain(points * unit.contracts * unit.size);
  return `${fixed(points, 2)} pts`;
}

/** An axis label: as `say`, without the "pts" a tick has no room for, and to no more places than
 *  the tick needs. */
function tickWords(points: number, unit: Unit): string {
  if (inMoney(unit)) return moneyPlain(points * unit.contracts * unit.size);
  return tick(points);
}

/** What the chart's money is: across the contracts at the contract size, or per contract in points
 *  — said beside every figure, so it cannot read as the inspector's per-contract Cost to close in
 *  another unit. Per contract under privacy, which never says the count. */
export function scopeWords(unit: Unit): string {
  if (!inMoney(unit)) return "per contract";
  return `${unit.contracts} contract${unit.contracts === 1 ? "" : "s"}`;
}

/** "20261103": a market date as every date is written (`times.writtenDate`), by string, so no zone
 *  can move it — the way the service writes the days in its reasons. */
const dayWords = writtenDate;

const NEW_YORK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** "20:30": the instant the service served in DISPLAY_TZ, on New York's clock — the clock the
 *  rule about closes is written in, so the reason says the time that rule reads. */
function newYorkTime(served: string | null): string | null {
  if (served === null) return null;
  const when = new Date(served.replace(" ", "T"));
  return Number.isNaN(when.getTime()) ? null : NEW_YORK.format(when);
}

/** Why a row is or is not the day's close (`sampleTiming`, ADR 0011's amendment), in words. A row
 *  observed in the hours is said to be IN HOURS rather than the close: the hours are the rule, and
 *  a weekday row from 11:00 is in them too (decision 2 in #323). */
function whyWords(s: Sample): string {
  const at = newYorkTime(s.observed_at);
  if (s.timing === "unrecorded" || at === null) {
    return "written before observation times were kept: whether it was the close is not known";
  }
  switch (s.timing) {
    case "close": return `in hours (observed ${at} ET)`;
    case "after-close":
      return `not the close: observed ${at} ET, after the 16:15 ET close — recorded that evening, or a missed session filled later`;
    case "before-open":
      return `not the close: observed ${at} ET, before the 09:30 ET open — an overnight fill no later sweep replaced`;
  }
}

/** The same reason, short enough for the tooltip, and nothing for a day in the hours. Said by the
 *  IV and SPX panels' readouts too (`historyDays.ts`, #395). */
export function whyShort(s: Sample): string | null {
  const at = newYorkTime(s.observed_at);
  if (s.timing === "unrecorded" || at === null) return "not timed: whether it was the close is not known";
  if (s.timing === "after-close") return `not the close: ${at} ET, after the 16:15 ET close`;
  if (s.timing === "before-open") return `not the close: ${at} ET, before the 09:30 ET open`;
  return null;
}

/** What a day summed before a leg's quantity was corrected is said to be (#359): its Cost to close
 *  is the structure as it was then recorded, kept as it was because nothing stored can re-sum it. */
export const CORRECTED_WORDS = "summed before a leg's quantity was corrected";

/** A day's Pace gap, in points per contract as every Pace gap on the page is said (`pace.ts`) —
 *  which is no money, so privacy keeps it. None for a day summed before a correction: its Cost to
 *  close is another structure's, and the service measures no gap from one either (`/vol`). */
function gapOf(s: PricedSample) {
  if (s.on_pace === null || s.before_correction) return null;
  const gap = s.cost_to_close - s.on_pace;
  return { words: paceWords(gap), outcome: paceOutcome(gap) ?? null };
}

/** What the crosshair's tooltip says of a day, line by line. */
export function tipLines(s: PricedSample, unit: Unit) {
  const scope = scopeWords(unit);
  return {
    day: `${dayWords(s.observed_on)} · ${s.dte} DTE`,
    cost: `${unit.what ?? "to close"}${scope === null ? "" : `, ${scope}`}: ${say(s.cost_to_close, unit)}`,
    pace: s.on_pace === null ? null : `on pace ${say(s.on_pace, unit)}`,
    gap: gapOf(s),
    why: whyShort(s),
    corrected: s.before_correction ? CORRECTED_WORDS : null,
  };
}

/** One day, said in full, by the status line: everything the tooltip says — which no screen reader
 *  hears — and the whole reason for whether it was the close. */
/** What the tooltip says of today's valuation: a stop of the crosshair's of its own, after the last
 *  day, since it is drawn apart from the closes and has no plan or reason of its own. */
export function nowLines(now: { dte: number; cost: number }, unit: Unit) {
  const scope = scopeWords(unit);
  return { day: `valued now · ${now.dte} DTE`, cost: `${unit.what ?? "to close"}${scope === null ? "" : `, ${scope}`}: ${say(now.cost, unit)}` };
}

/** What the burndown says of a day the shared crosshair stops on with no Cost to close (#380,
 *  #395): a row kept for its vol readings out of hours, which is a stop in every panel because the
 *  IV and SPX panels have its figures. */
export const NO_COST_WORDS = "no Cost to close: no two-sided quote to price it";

/** Such a day, line by line, as `tipLines` says a priced one — and no word about its timing: a
 *  weekend row at 11:00 New York is "in hours" by the sweep's every-day rule (ADR 0011) while no leg
 *  had a quote to price, and said together the two contradicted each other (#399's review). */
export function noCostLines(s: Sample) {
  return { day: `${dayWords(s.observed_on)} · ${s.dte} DTE`, cost: NO_COST_WORDS, why: null };
}

/** Such a day said in full, by the status line. */
export const noCostWords = (s: Sample) => `${dayWords(s.observed_on)} · ${s.dte} DTE · ${NO_COST_WORDS}`;

/** Today's valuation with no Cost to close — a stop for SPX's price alone. */
export const NO_COST_NOW = "no Cost to close now";

/** Today's valuation said in full, by the status line. */
export function nowWords(now: { dte: number; cost: number }, unit: Unit): string {
  const t = nowLines(now, unit);
  return `valued now, ${now.dte} DTE: ${t.cost}`;
}

export function sampleWords(s: PricedSample, unit: Unit): string {
  const t = tipLines(s, unit);
  const gap = t.gap === null ? "" : ` · ${t.gap.words}`;
  const corrected = t.corrected === null ? "" : ` — ${t.corrected}`;
  return `${t.day} · ${t.cost}${t.pace === null ? "" : ` · ${t.pace}`}${gap} — ${whyWords(s)}${corrected}`;
}

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** The DTE of the New York market day a leg's quantity was corrected on (#359), on the days' own
 *  reckoning — a day's DTE less the calendar days from it — so the marker sits where that day's
 *  row would. Null where it never was, or with no day to reckon from. */
export function correctionDte(served: Pick<Samples, "samples" | "qty_corrected_at">): number | null {
  const first = served.samples[0];
  if (served.qty_corrected_at === null || first === undefined) return null;
  const when = new Date(served.qty_corrected_at.replace(" ", "T"));
  if (Number.isNaN(when.getTime())) return null;
  return first.dte - (dayNumber(NEW_YORK_DAY.format(when)) - dayNumber(first.observed_on));
}

/** The Cost-to-close line in runs: broken by a missed day, as `runsOf` breaks it, and split where
 *  the days summed before a correction give way to the days after (#359). The step between the two
 *  joins different structures, so it belongs to the run before, drawn as that run is. */
export function costRuns<T extends { dte: number; before_correction: boolean }>(days: T[]) {
  const runs: { before: boolean; run: T[] }[] = [];
  let prev: T | undefined;
  for (const d of days) {
    const last = runs.at(-1);
    const joined = prev !== undefined && prev.dte - d.dte === 1;
    if (last && joined && last.before === d.before_correction) last.run.push(d);
    else {
      if (last && joined && last.before) last.run.push(d);
      runs.push({ before: d.before_correction, run: [d] });
    }
    prev = d;
  }
  return runs;
}

/** The day whose x is nearest the pointer's: what a pointer anywhere on the chart means, since days
 *  a few pixels apart cannot each have a finger's width of their own. Of two at one x the LATER:
 *  in session today's valuation shares today's sample's x, and the earlier would hide it from every
 *  pointer for good (the keys reach both). Null with no days. */
export function nearestDay(xs: number[], at: number): number | null {
  if (xs.length === 0) return null;
  let best = 0;
  xs.forEach((x, i) => { if (Math.abs(x - at) <= Math.abs(xs[best]! - at)) best = i; });
  return best;
}

/** The day a key moves the crosshair to: the arrows a day at a time from either end, Home and End
 *  to the ends, Escape lets go ("clear") of a day pointed at; undefined for any other key, with no
 *  days, or for Escape with none pointed at — which is then the page's: the desk's inspector closes
 *  on an Escape nobody took, and a chart that swallowed every one could never be closed from. */
export function stepDay(key: string, at: number | null, count: number): number | "clear" | undefined {
  const last = count - 1;
  if (last < 0) return undefined;
  switch (key) {
    case "ArrowRight": return at === null ? 0 : Math.min(last, at + 1);
    case "ArrowLeft": return at === null ? last : Math.max(0, at - 1);
    case "Home": return 0;
    case "End": return last;
    case "Escape": return at === null ? undefined : "clear";
    default: return undefined;
  }
}

/** A label's width at the charts' 11px tabular figures, near enough to leave it room. */
export const textWidth = (text: string) => text.length * 6.6;

/** What the charts draw a holding from, as far as the value axis reads it: today's valuation, only
 *  while it is held and valued. */
interface Valued {
  closed_on: string | null;
  cost_to_close?: number | null;
  dte?: number;
  valued_from?: "live" | "close";
}

/** Today's valuation, from the book's latest one (polled in session): drawn apart from the closes,
 *  and only while held. None outside the session, where the valuation IS the latest close (#380) —
 *  already a day of the chart, and drawn again as "now" it was said twice (#399's review). */
function nowOf(holding: Valued) {
  return holding.closed_on === null && holding.valued_from !== "close" && holding.cost_to_close != null
    && holding.dte !== undefined && holding.dte >= 0 ? { dte: holding.dte, cost: holding.cost_to_close } : null;
}

/** The burndown's value axis: fitted to the days, the plan, the Target and today — 0 always in it —
 *  at nice ticks. NOT to the Stop: at twice the Entry it set the top and squeezed every line into
 *  the bottom third (#360). A Stop above the scale is marked at its top edge (`off`)
 *  rather than drawn, and one inside it is drawn where it is. `L` is the left margin the labels
 *  need. Under privacy they are points per contract (#395): the dollar labels, and a gutter as wide
 *  as they would be, are never drawn. */
export function valueAxis(served: Samples, holding: Valued, unit: Unit, also: number[] = []) {
  const { levels, plan, samples } = served;
  const now = nowOf(holding);
  // `also`: a watched row's threshold, drawn against its value (#402), and a holding's Entry, drawn
  // across its burndown (2026-11-17) — the Entry is where the plan starts, so it is usually in already
  const values = [
    0, ...samples.filter(hasCost).map((s) => s.cost_to_close), ...plan.map((p) => p.on_pace),
    ...(levels?.target == null ? [] : [levels.target]), ...(now ? [now.cost] : []), ...also,
  ];
  let hi = Math.max(...values), lo = Math.min(...values);
  // every figure at zero: a scale of one value has no height to draw in
  if (hi === lo) hi = lo + 1;
  // room for a point at either end, so none sits on the plot's edge
  const pad = (hi - lo || 1) * 0.04;
  if (hi > 0) hi += pad;
  if (lo < 0) lo -= pad;
  const scale = scaleLinear<number>({ domain: [lo, hi], nice: 4 });
  const ticks = scale.ticks(4);
  const [bottom, top] = scale.domain() as [number, number];
  const stop = levels?.stop == null ? null
    // never below: a Stop is a credit's, above its Entry, and the scale always holds 0
    : { value: levels.stop, off: levels.stop > top ? "above" as const : null };
  const labels = ticks.map((v) => tickWords(v, unit));
  const L = Math.ceil(Math.max(...labels.map(textWidth), 16)) + 10;
  return { lo: bottom, hi: top, ticks, labels, stop, now, L };
}

/** Where the tooltip goes, placed by hand, as `left` and `top` inside the chart's W × H box (#360).
 *  Visx's `TooltipWithBounds` flipped to the left at the 272px inspector and ran off it, since a
 *  tooltip that wide has room on NEITHER side of a day there (the prototype). So: centred on the
 *  day, kept inside the box, at its top edge or its bottom one — whichever is further from the
 *  day's point, so it does not cover the point it describes. Only where that side is still too
 *  short for it (`tipH`, measured) is it put beside the day instead, if either side has the room;
 *  and where neither has, it stays at the edge, inside the chart, which the status line beneath
 *  says in full anyway. `r` is the point's radius. */
export function tipPlace({ x, y, W, H, tipW, tipH, r = 6 }: {
  x: number; y: number; W: number; H: number; tipW: number; tipH: number; r?: number;
}): { left: number; top: number } {
  const centred = Math.min(Math.max(0, x - tipW / 2), Math.max(0, W - tipW));
  const [above, below] = [y - r, H - y - r];
  const top = above >= below ? 0 : H - tipH;
  if (Math.max(above, below) >= tipH) return { left: centred, top };
  const level = Math.min(Math.max(0, y - tipH / 2), Math.max(0, H - tipH));
  if (x + r + 4 + tipW <= W) return { left: x + r + 4, top: level };
  if (x - r - 4 - tipW >= 0) return { left: x - r - 4 - tipW, top: level };
  return { left: centred, top };
}
