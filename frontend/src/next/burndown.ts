/** The burndown's arithmetic and words (#360), apart from its drawing (`BurndownChart.tsx`): how a Cost
 *  to close is said, which day a pointer or a key means, the value axis — and where it leaves a Stop
 *  it does not reach — where the crosshair's tooltip goes, and what it and the status line say.
 *
 *  Pure, so each is tested without a chart; the chart only draws what these decide. */
import { scaleLinear } from "@visx/scale";

import type { Sample, Samples } from "../shared/api";
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

/** A day's Pace gap, in points per contract as every Pace gap on the page is said (`pace.ts`) —
 *  which is no money, so privacy keeps it. */
function gapOf(s: Sample) {
  if (s.on_pace === null) return null;
  const gap = s.cost_to_close - s.on_pace;
  return { words: paceWords(gap), outcome: paceOutcome(gap) ?? null };
}

/** What the crosshair's tooltip says of a day, line by line. */
export function tipLines(s: Sample, unit: Unit) {
  const scope = scopeWords(unit);
  return {
    day: `${dayWords(s.observed_on)} · ${s.dte} DTE`,
    cost: `to close${scope === null ? "" : `, ${scope}`}: ${say(s.cost_to_close, unit)}`,
    pace: s.on_pace === null ? null : `on pace ${say(s.on_pace, unit)}`,
    gap: gapOf(s),
    why: whyShort(s),
  };
}

/** One day, said in full, by the status line: everything the tooltip says — which no screen reader
 *  hears — and the whole reason for whether it was the close. */
export function sampleWords(s: Sample, unit: Unit): string {
  const t = tipLines(s, unit);
  const gap = t.gap === null ? "" : ` · ${t.gap.words}`;
  return `${t.day} · ${t.cost}${t.pace === null ? "" : ` · ${t.pace}`}${gap} — ${whyWords(s)}`;
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
 *  to the ends, Escape lets go ("clear"); undefined for any other key, or with no days. */
export function stepDay(key: string, at: number | null, count: number): number | "clear" | undefined {
  const last = count - 1;
  if (last < 0) return undefined;
  switch (key) {
    case "ArrowRight": return at === null ? 0 : Math.min(last, at + 1);
    case "ArrowLeft": return at === null ? last : Math.max(0, at - 1);
    case "Home": return 0;
    case "End": return last;
    case "Escape": return "clear";
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

/** Today's valuation, from REVIEW's one batch: drawn apart from the closes, and only while held. */
export function nowOf(holding: Valued) {
  return holding.closed_on === null && holding.cost_to_close != null && holding.dte !== undefined
    && holding.dte >= 0 ? { dte: holding.dte, cost: holding.cost_to_close } : null;
}

/** The burndown's value axis: fitted to the days, the plan, the Target and today — 0 always in it —
 *  at nice ticks. NOT to the Stop: at twice the Entry it set the top and squeezed every line into
 *  the bottom third (#360). A Stop beyond the scale is marked at the edge it lies past (`off`)
 *  rather than drawn, and one inside it is drawn where it is. `L` is the left margin the labels
 *  need; under privacy there are none, and no gutter as wide as they would be, which would say how
 *  many digits they hid. */
export function valueAxis(served: Samples, holding: Valued, unit: Unit) {
  const { levels, plan, samples } = served;
  const now = nowOf(holding);
  const values = [
    0, ...samples.map((s) => s.cost_to_close), ...plan.map((p) => p.on_pace),
    ...(levels?.target == null ? [] : [levels.target]), ...(now ? [now.cost] : []),
  ];
  let hi = Math.max(...values), lo = Math.min(...values);
  // room for a point at either end, so none sits on the plot's edge
  const pad = (hi - lo || 1) * 0.04;
  if (hi > 0) hi += pad;
  if (lo < 0) lo -= pad;
  const scale = scaleLinear<number>({ domain: [lo, hi], nice: 4 });
  const ticks = scale.ticks(4);
  const [bottom, top] = scale.domain() as [number, number];
  const stop = levels?.stop == null ? null
    : { value: levels.stop, off: levels.stop > top ? "above" as const : levels.stop < bottom ? "below" as const : null };
  const labels = unit.hidden ? [] : ticks.map((v) => tickWords(v, unit));
  const L = unit.hidden ? 8 : Math.ceil(Math.max(...labels.map(textWidth), 16)) + 10;
  return { lo: bottom, hi: top, ticks, labels, stop, now, L };
}

/** Where the tooltip goes, placed by hand: centred on the day and kept inside the chart, and in the
 *  half of the plot the day's point is not in, so it never covers the point it describes. Visx's
 *  `TooltipWithBounds` flipped to the left at the 272px inspector and ran off it, since a tooltip
 *  that wide has room on NEITHER side of a day there (the prototype, #360). `top` is the plot's top
 *  edge or its bottom one; `below` says the tooltip hangs ABOVE that bottom edge. */
export function tipPlace({ x, y, W, tipW, top, bottom }: {
  x: number; y: number; W: number; tipW: number; top: number; bottom: number;
}) {
  const left = Math.min(Math.max(0, x - tipW / 2), Math.max(0, W - tipW));
  const low = y > (top + bottom) / 2;
  return { left, top: low ? top : bottom, below: !low };
}
