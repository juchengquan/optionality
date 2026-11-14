/** The burndown's arithmetic and words (#360), apart from its drawing (`BurndownChart.tsx`): how a Cost
 *  to close is said, which day a pointer or a key means, the value axis — and where it leaves a Stop
 *  it does not reach — where the crosshair's tooltip goes, and what it and the status line say.
 *
 *  Pure, so each is tested without a chart; the chart only draws what these decide. */
import { scaleLinear } from "@visx/scale";

import type { Sample, Samples } from "./shared/api";
import { paceOutcome, paceWords } from "./pace";

/** How a Cost to close is said: money across the contracts at the contract size the valuation
 *  served, points per contract without one, and nothing a stranger could read under privacy. */
export interface Unit {
  size: number;
  contracts: number;
  money: boolean;
  hidden: boolean;
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A day with a Cost to close. A day may have none (#380): out of hours a leg has no two-sided
 *  quote — moomoo quotes 0/0 — and the sweep keeps the day for its vol readings with the cost left
 *  empty. Such a day is a row (it is not a missed day), and is not a point on the burndown. */
export type PricedSample = Sample & { cost_to_close: number };
export const hasCost = (s: Sample): s is PricedSample => s.cost_to_close !== null;

export function say(points: number, unit: Unit): string {
  if (unit.hidden) return "$•••";
  if (unit.money) return MONEY.format(points * unit.contracts * unit.size);
  return `${points.toFixed(2)} pts`;
}

/** An axis label: as `say`, without the "pts" a tick has no room for, and to no more places than
 *  the tick needs. */
function tickWords(points: number, unit: Unit): string {
  if (unit.money) return MONEY.format(points * unit.contracts * unit.size);
  return String(Number(points.toFixed(2)));
}

/** What the chart's money is: across the contracts at the contract size, or per contract in points
 *  — said beside every figure, so it cannot read as the inspector's per-contract Cost to close in
 *  another unit. Nothing under privacy, where the count would give the size away. */
export function scopeWords(unit: Unit): string | null {
  if (unit.hidden) return null;
  if (!unit.money) return "per contract";
  return `${unit.contracts} contract${unit.contracts === 1 ? "" : "s"}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
/** "3 Nov": a market date as a day to read, read in UTC so the device's zone cannot move it. */
const dayWords = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

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
    case "close": return `in hours (observed ${at} New York)`;
    case "after-close":
      return `not the close: observed ${at} New York, after the 16:15 close — recorded that evening, or a missed session filled later`;
    case "before-open":
      return `not the close: observed ${at} New York, before the 09:30 open — an overnight fill no later sweep replaced`;
  }
}

/** The same reason, short enough for the tooltip, and nothing for a day in the hours. */
function whyShort(s: Sample): string | null {
  const at = newYorkTime(s.observed_at);
  if (s.timing === "unrecorded" || at === null) return "not timed: whether it was the close is not known";
  if (s.timing === "after-close") return `not the close: ${at} New York, after the 16:15 close`;
  if (s.timing === "before-open") return `not the close: ${at} New York, before the 09:30 open`;
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
    cost: `to close${scope === null ? "" : `, ${scope}`}: ${say(s.cost_to_close, unit)}`,
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
  return { day: `valued now · ${now.dte} DTE`, cost: `to close${scope === null ? "" : `, ${scope}`}: ${say(now.cost, unit)}` };
}

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
 *  a few pixels apart cannot each have a finger's width of their own. Null with no days. */
export function nearestDay(xs: number[], at: number): number | null {
  if (xs.length === 0) return null;
  let best = 0;
  xs.forEach((x, i) => { if (Math.abs(x - at) < Math.abs(xs[best]! - at)) best = i; });
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
}

/** Today's valuation, from the book's latest one (polled in session, read once outside it): drawn
 *  apart from the closes, and only while held. */
function nowOf(holding: Valued) {
  return holding.closed_on === null && holding.cost_to_close != null && holding.dte !== undefined
    && holding.dte >= 0 ? { dte: holding.dte, cost: holding.cost_to_close } : null;
}

/** The burndown's value axis: fitted to the days, the plan, the Target and today — 0 always in it —
 *  at nice ticks. NOT to the Stop: at twice the Entry it set the top and squeezed every line into
 *  the bottom third (#360). A Stop above the scale is marked at its top edge (`off`)
 *  rather than drawn, and one inside it is drawn where it is. `L` is the left margin the labels
 *  need; under privacy there are none, and no gutter as wide as they would be, which would say how
 *  many digits they hid. */
export function valueAxis(served: Samples, holding: Valued, unit: Unit) {
  const { levels, plan, samples } = served;
  const now = nowOf(holding);
  const values = [
    0, ...samples.filter(hasCost).map((s) => s.cost_to_close), ...plan.map((p) => p.on_pace),
    ...(levels?.target == null ? [] : [levels.target]), ...(now ? [now.cost] : []),
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
  const labels = unit.hidden ? [] : ticks.map((v) => tickWords(v, unit));
  const L = unit.hidden ? 8 : Math.ceil(Math.max(...labels.map(textWidth), 16)) + 10;
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
