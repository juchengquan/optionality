/** The burndown (#295, rebuilt on visx in #360): a holding's Cost to close per day against the plan
 *  of ADR 0011, with a crosshair that snaps to the nearest day and a tooltip that says it.
 *
 *  - **What is drawn.** Light gridlines at the value axis' nice ticks; the plan dashed; the costs a
 *    heavier line, the gap between them and the plan shaded ahead or behind in the outcome colours
 *    (visx's `Threshold`); the Target and the Stop labelled in their attention colours, Manage-by
 *    too; today's valuation emphasised; a day that is not the close hollow; a missed day a break in
 *    the line over a hatched column.
 *  - **The value axis is the days', not the Stop's** (`valueAxis`): a Stop above it is marked at
 *    the top edge, with an arrow and its figure, rather than stretching the scale.
 *  - **The crosshair** is the history's, shared with the IV chart (`Crosshair.tsx`, #395): it stops
 *    at every recorded day and at today's valuation after them, and a day pointed at in either panel
 *    is crossed in both. How a mouse, a finger and the keys move it
 *    is `usePanel`'s, the same in each. On a day with no Cost to close (#380) it is a rule down the
 *    day and the readout says there is none. The tooltip is for the eye and is hidden from a screen
 *    reader; the status line beneath says the same stop in full, and is what is announced.
 *  - **A leg's quantity corrected** (#359): the days summed before it are another structure's Cost
 *    to close, kept as they were. Their points and their stretch of the line are drawn faint and
 *    dashed, no gap to the plan is shaded over them, a rule marks the New York day it was corrected,
 *    and the tooltip and the status line say "summed before a leg's quantity was corrected".
 *  - **Before entry** (#402): the days a holding's contracts were watched before it was entered are
 *    drawn first, faint — their points and their own stretch of line — a rule marks where it was
 *    entered, and the tooltip and the status line say "before entry". A watched row's own history
 *    is drawn by this chart too, with no plan and its price rule's threshold across it.
 *  - **Privacy** keeps the shape and drops every $ figure and everything across the contracts held:
 *    the axis, the Levels and the readout say points per contract instead (the owner's call, #395),
 *    as the table's value column, the inspector's Entry, Target and Stop and the payoff do.
 *
 *  visx for the scales and the shapes only (`@visx/scale`, `shape`, `threshold`). The axes, the grid
 *  and the tooltip are drawn here: `@visx/axis` brings `@visx/text` and with it `reduce-css-calc`
 *  1.x, unmaintained since 2016, for labels this chart places by hand anyway; and the prototype's
 *  `TooltipWithBounds` ran off the 272px inspector (`tipPlace`).
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { Threshold } from "@visx/threshold";

import type { Sample, Samples } from "./shared/api";
import {
  CORRECTED_WORDS, correctionDte, costRuns, hasCost, NO_COST_NOW, noCostLines, noCostWords, nowLines, nowWords,
  sampleWords, say, textWidth, tipLines, valueAxis, type Unit,
} from "./burndown";
import { CrossTip, dayScale, liveOf, pointedStop, stepped, usePanel, type Cross, type Gutters } from "./Crosshair";
import { MARK } from "./historyDays";
import { BEFORE_ENTRY_WORDS, ENTRY_CLOSE_WORDS } from "./watchhistory";

const H = 196, T = 16, B = 22;
const NONE: ReadonlySet<string> = new Set();

/** Points in runs of consecutive days: a day with no row at all — the service down for a whole New
 *  York day — breaks the line, as a day without a reading does, rather than being drawn across. */
export function runsOf<T extends { dte: number }>(points: (T | null)[]): T[][] {
  const runs: T[][] = [[]];
  for (const p of points) {
    const run = runs.at(-1)!;
    const last = run.at(-1);
    if (p === null || (last !== undefined && last.dte - p.dte > 1)) {
      if (run.length > 0) runs.push([]);
    }
    if (p !== null) runs.at(-1)!.push(p);
  }
  return runs.filter((r) => r.length > 0);
}

/** The DTEs inside the samples' span with no row: the missed days, each drawn as a hatched column. */
function missedDays(samples: Sample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    for (let d = samples[i - 1]!.dte - 1; d > samples[i]!.dte; d--) out.push(d);
  }
  return out;
}

/** The width of the box, measured, so the drawing's text is the size it says wherever it sits. */
export function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, width];
}

/** `axis` is `valueAxis`'s for this holding, `span` the DTE window and `gutters` the margins every
 *  panel of the holding shares (#298), so a day is at the same x here as in the IV chart and SPX's
 *  path beneath. `cross` is the crosshair the three share (#395), and `closeDte` a closed
 *  holding's last day (#296). */
export function Burndown({ served, unit, axis, span, gutters, closeDte, cross, before = NONE, threshold = null, entryDay = null, entry = null }: {
  served: Samples; unit: Unit; axis: ReturnType<typeof valueAxis>; span: number;
  gutters: Gutters; closeDte: number | null; cross: Cross;
  /** the days, by market day, that are before entry: watched, not yet held (#402) */
  before?: ReadonlySet<string>;
  /** a watched row's price rule's threshold, drawn across its value (#402) */
  threshold?: number | null;
  /** the day whose point is the entry day's WATCHED close (#402, `entry_close`), or null */
  entryDay?: string | null;
  /** a holding's Entry, per contract: the cost to close it started from, drawn across the chart
   *  (the owner, 2026-11-17). Null for a watched row, which has none */
  entry?: number | null;
}) {
  const [box, W] = useWidth();
  const { L, R } = gutters;
  const id = useId().replace(/:/g, "");
  // the days that have a Cost to close are the points; a day kept only for its vol readings
  // (#380: no two-sided quote, out of hours) is a row, so it is not a missed day, but no point —
  // and still a stop of the shared crosshair, where this panel says it has no figure
  const { levels, plan, samples: rows } = served;
  const samples = rows.filter(hasCost);
  const watched = samples.filter((s) => before.has(s.observed_on));
  const held = samples.filter((s) => !before.has(s.observed_on));
  // where the holding was entered, after the days it was watched: Opened, or its first own day
  const enteredDte = watched.length === 0 ? null : levels?.dte_at_open ?? held[0]?.dte ?? null;
  const { now } = axis;
  const x = dayScale(span, W, gutters);
  const y = scaleLinear<number>({ domain: [axis.lo, axis.hi], range: [H - B, T] });
  const xs = cross.stops.map((s) => x(s.dte));
  const { svg: hands, onKeyDown, onFocus } = usePanel(cross, "burndown", box, xs, W);

  const level = (kind: "target" | "stop" | "entry", v: number) => `${kind} ${say(v)}`;
  const stop = axis.stop;
  const target = levels?.target ?? null;
  // Manage-by is named on the bottom line between the window's two ends, and never over either:
  // at the top it sat on the Stop's label, which is the highest line drawn
  const [startWords, endWords] = [`${span} DTE`, "expiry"];
  const manage = levels && levels.manage_by_dte <= span ? levels.manage_by_dte : null;
  const manageWords = manage === null ? "" : `manage-by ${manage}`;
  const half = textWidth(manageWords) / 2;
  const manageLabelX = manage === null ? null : Math.min(
    Math.max(x(manage), L + textWidth(startWords) + 6 + half), W - 4 - textWidth(endWords) - 6 - half);
  const missed = missedDays(rows);
  const dayW = (W - L - R) / span;
  // the gap to the plan is shaded only where a day has its own On-pace, and a Cost to close summed
  // under the quantities as they now are (#359)
  const paced = runsOf(samples.map((s) => (s.on_pace === null || s.before_correction
    ? null : { dte: s.dte, cost: s.cost_to_close, pace: s.on_pace })));
  const corrected = correctionDte(served);

  // the stop both panels share: a priced day, a day with no Cost to close, or today's valuation
  const pointed = pointedStop(cross);
  const at = pointed?.sample && hasCost(pointed.sample) ? pointed.sample : null;
  const bare = pointed?.sample && !hasCost(pointed.sample) ? pointed.sample : null;
  const onNow = pointed !== null && pointed.on === null;
  const atNow = onNow ? now : null;
  const tip = pointed === null ? null : (() => {
    const px = x(pointed.dte);
    if (at) {
      return { px, py: y(at.cost_to_close), lines: tipLines(at, unit), entry: before.has(at.observed_on),
        entryClose: at.observed_on === entryDay };
    }
    if (atNow) return { px, py: y(atNow.cost), lines: { ...nowLines(atNow, unit), pace: null, gap: null, why: null, corrected: null }, entry: false };
    const lines = bare ? noCostLines(bare) : { day: `valued now · ${pointed.dte} DTE`, cost: NO_COST_NOW, why: null };
    return { px, py: (T + H - B) / 2, lines: { ...lines, pace: null, gap: null, corrected: null },
      entry: bare !== null && before.has(bare.observed_on) };
  })();
  const offClose = samples.some((s) => s.timing !== "close");
  const anyBefore = samples.some((s) => s.before_correction);
  const entryWords = (s: Sample) => (before.has(s.observed_on) ? ` — ${BEFORE_ENTRY_WORDS}`
    : s.observed_on === entryDay ? ` — ${ENTRY_CLOSE_WORDS}` : "");

  return (
    <>
      {/* ONE stop for the keyboard: the days are reached with the arrows and said by the status
          line, since inside an image they would be presentational and each a tab stop besides */}
      <div className="nx-hist-chart nx-bd" ref={box} role="group" tabIndex={0} onKeyDown={onKeyDown} onFocus={onFocus}
           aria-label={`cost to close by day, ${stepped(cross)}, against the plan: `
             + "arrow keys move from day to day"}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" {...hands}>
          <defs>
            <pattern id={`${id}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(45)">
              <line className="nx-bd-hatch" x1="0" y1="0" x2="0" y2="4" />
            </pattern>
          </defs>
          <rect data-plot="" x={L} y={T} width={Math.max(0, W - L - R)} height={H - T - B} fill="none" />
          <g data-grid="">
            {axis.ticks.map((v) => (
              <line key={v} className={v === 0 ? "nx-hist-zero" : "nx-bd-grid"}
                    x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            ))}
          </g>
          {axis.labels.length === 0 ? null : (
            <g data-axis="y">
              {axis.ticks.map((v, i) => (
                <text key={v} x={L - 6} y={y(v) + 4} textAnchor="end">{axis.labels[i]}</text>
              ))}
            </g>
          )}
          {missed.map((d) => (
            <rect key={d} data-missed={d} fill={`url(#${id}-hatch)`}
                  x={x(d) - dayW / 2} y={T} width={dayW} height={H - T - B} />
          ))}
          {paced.map((run, i) => (
            <Threshold key={run[0]!.dte} id={`${id}-pace${i}`} data={run} className="nx-bd-gap"
                       x={(d) => x(d.dte)} y0={(d) => y(d.cost)} y1={(d) => y(d.pace)}
                       clipAboveTo={T} clipBelowTo={H - B}
                       // below the plan costs less to close than planned: ahead
                       belowAreaProps={{ className: "nx-bd-ahead" }}
                       aboveAreaProps={{ className: "nx-bd-behind" }} />
          ))}
          {/* the Entry: where the cost to close started, the credit the target and stop are fractions
              and multiples of. Labelled at the right, as they are, but UNDER its line: the days start
              at the left near the Entry, where a label would sit on them, and the Stop — twice the
              Entry, often off the scale and marked at its top edge — is labelled above its own */}
          {entry === null ? null : (
            <g data-level="entry" className="nx-hist-entry">
              <line x1={L} x2={W - R} y1={y(entry)} y2={y(entry)} />
              <text x={W - R} y={y(entry) + 12} textAnchor="end">{level("entry", entry)}</text>
            </g>
          )}
          {target === null ? null : (
            <g data-level="target" className="nx-hist-target">
              <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} />
              <text x={W - R} y={y(target) - 4} textAnchor="end">{level("target", target)}</text>
            </g>
          )}
          {stop === null ? null : stop.off === null ? (
            <g data-level="stop" className="nx-hist-stop">
              <line x1={L} x2={W - R} y1={y(stop.value)} y2={y(stop.value)} />
              <text x={W - R} y={y(stop.value) - 4} textAnchor="end">{level("stop", stop.value)}</text>
            </g>
          ) : (
            // above the scale: marked at its top edge, an arrow and its figure, in the margin
            // over the plot, so it is on top of nothing drawn
            <g data-level="stop" data-off={stop.off} className="nx-hist-stop">
              <line x1={L} x2={W - R} y1={T} y2={T} />
              <text x={W - R} y={T - 4} textAnchor="end">{`▲ ${level("stop", stop.value)}`}</text>
            </g>
          )}
          {threshold === null ? null : (
            <g data-level="threshold" className="nx-hist-threshold">
              <line x1={L} x2={W - R} y1={y(threshold)} y2={y(threshold)} />
              <text x={W - R} y={y(threshold) - 4} textAnchor="end">{`threshold ${say(threshold)}`}</text>
            </g>
          )}
          {enteredDte === null || enteredDte < 0 || enteredDte > span ? null : (
            <g data-entered="" className="nx-hist-entered">
              <line x1={x(enteredDte)} x2={x(enteredDte)} y1={T} y2={H - B} />
              {x(enteredDte) + 4 + textWidth("entered") > W - R
                ? <text x={x(enteredDte) - 4} y={T + 10} textAnchor="end">entered</text>
                : <text x={x(enteredDte) + 4} y={T + 10} textAnchor="start">entered</text>}
            </g>
          )}
          {manage === null ? null : (
            <g data-level="manage-by" className="nx-hist-manage">
              <line x1={x(manage)} x2={x(manage)} y1={T} y2={H - B} />
              <text x={manageLabelX!} y={H - 6} textAnchor="middle">{manageWords}</text>
            </g>
          )}
          {closeDte === null || !Number.isFinite(closeDte) || closeDte < 0 || closeDte > span ? null : (
            <g data-close="" className="nx-hist-close">
              <line x1={x(closeDte)} x2={x(closeDte)} y1={T} y2={H - B} />
              {/* to the left of its line, where the days it ends are; to the right if that would
                  run into the value axis */}
              {x(closeDte) - textWidth("closed") - 4 < L
                ? <text x={x(closeDte) + 4} y={T + 10} textAnchor="start">closed</text>
                : <text x={x(closeDte) - 4} y={T + 10} textAnchor="end">closed</text>}
            </g>
          )}
          {corrected === null || corrected < 0 || corrected > span ? null : (
            <g data-corrected-on="" className="nx-hist-corrected">
              <line x1={x(corrected)} x2={x(corrected)} y1={T} y2={H - B} />
              {/* at the foot of the plot, clear of the Levels' labels along its top and the "closed"
                  label's line: to the right of its rule — the days after it are the ones summed as
                  recorded now — or to the left where the right has no room */}
              {x(corrected) + 4 + textWidth("qty corrected") > W - R
                ? <text x={x(corrected) - 4} y={H - B - 4} textAnchor="end">qty corrected</text>
                : <text x={x(corrected) + 4} y={H - B - 4} textAnchor="start">qty corrected</text>}
            </g>
          )}
          {plan.length > 1 ? (
            <LinePath data-plan="" className="nx-hist-plan" data={plan}
                      x={(p) => x(p.dte)} y={(p) => y(p.on_pace)} />
          ) : null}
          {/* the days watched before entry: a line of their own, faint, never joined to the holding's */}
          {runsOf(watched).map((run) => (
            <LinePath key={`w${run[0]!.dte}`} data-costs="before-entry" className="nx-hist-costs" data={run}
                      x={(s) => x(s.dte)} y={(s) => y(s.cost_to_close)} />
          ))}
          {costRuns(held).map(({ before: corrected, run }) => (
            <LinePath key={`${run[0]!.dte}${corrected}`} data-costs={corrected ? "before-correction" : ""}
                      className="nx-hist-costs" data={run}
                      x={(s) => x(s.dte)} y={(s) => y(s.cost_to_close)} />
          ))}
          {samples.map((s) => (
            <g key={s.observed_on} data-sample={s.observed_on} data-timing={s.timing}
               data-before-correction={s.before_correction ? "" : undefined}
               data-before-entry={before.has(s.observed_on) ? "" : undefined}
               data-entry-close={s.observed_on === entryDay ? "" : undefined}
               data-pointed={pointed?.on === s.observed_on ? "" : undefined} className="nx-hist-point">
              <circle data-mark={MARK[s.timing]} cx={x(s.dte)} cy={y(s.cost_to_close)} r={3.25} />
            </g>
          ))}
          {now ? (
            <g data-now="" className="nx-hist-now" data-pointed={atNow ? "" : undefined}>
              <rect className="nx-bd-halo" x={x(now.dte) - 7} y={y(now.cost) - 7} width={14} height={14}
                    transform={`rotate(45 ${x(now.dte)} ${y(now.cost)})`} />
              <rect x={x(now.dte) - 4.5} y={y(now.cost) - 4.5} width={9} height={9}
                    transform={`rotate(45 ${x(now.dte)} ${y(now.cost)})`} />
            </g>
          ) : null}
          {/* a stop with no Cost to close here — a day kept for its vol (#380), or today's valuation
              with SPX's price alone — is crossed by its rule down the day and nothing across */}
          {pointed === null || at !== null || atNow !== null ? null : (
            <g data-crosshair={pointed.on ?? "now"} data-bare="" className="nx-bd-cross" pointerEvents="none">
              <line x1={x(pointed.dte)} x2={x(pointed.dte)} y1={T} y2={H - B} />
            </g>
          )}
          {atNow === null ? null : (
            <g data-crosshair="now" className="nx-bd-cross" pointerEvents="none">
              <line x1={x(atNow.dte)} x2={x(atNow.dte)} y1={T} y2={H - B} />
              <line x1={L} x2={W - R} y1={y(atNow.cost)} y2={y(atNow.cost)} />
            </g>
          )}
          {/* the crosshair: a rule down the day, a rule across at its cost, the plan's mark on it */}
          {at === null ? null : (
            <g data-crosshair={at.observed_on} className="nx-bd-cross" pointerEvents="none">
              <line x1={x(at.dte)} x2={x(at.dte)} y1={T} y2={H - B} />
              <line x1={L} x2={W - R} y1={y(at.cost_to_close)} y2={y(at.cost_to_close)} />
              {at.on_pace === null ? null
                : <circle className="nx-bd-cross-plan" cx={x(at.dte)} cy={y(at.on_pace)} r={3} />}
              <circle className="nx-bd-cross-day" data-mark={MARK[at.timing]}
                      cx={x(at.dte)} cy={y(at.cost_to_close)} r={4.75} />
            </g>
          )}
          <text x={L} y={H - 6} textAnchor="start">{startWords}</text>
          {/* in the margin, as the IV chart writes it: the shared right margin is the leg names' room */}
          <text x={W - 4} y={H - 6} textAnchor="end">{endWords}</text>
        </svg>
        {tip === null ? null : (
          <CrossTip x={tip.px} ys={[tip.py]} W={W} H={H}>
            <div className="nx-bd-tip-h">{tip.lines.day}</div>
            <div>{tip.lines.cost}</div>
            {tip.lines.pace === null ? null : (
              <div>
                {tip.lines.pace}
                {tip.lines.gap === null ? null : (
                  <>
                    {" · "}
                    <span className="nx-bd-tip-gap" data-outcome={tip.lines.gap.outcome ?? undefined}>
                      {tip.lines.gap.words}
                    </span>
                  </>
                )}
              </div>
            )}
            {tip.lines.why === null ? null : <div className="nx-bd-tip-why">{tip.lines.why}</div>}
            {tip.lines.corrected !== null
              ? <div className="nx-bd-tip-why" data-corrected="">{tip.lines.corrected}</div> : null}
            {tip.entry ? <div className="nx-bd-tip-why" data-before-entry="">{BEFORE_ENTRY_WORDS}</div> : null}
            {"entryClose" in tip && tip.entryClose
              ? <div className="nx-bd-tip-why" data-entry-close="">{ENTRY_CLOSE_WORDS}</div> : null}
          </CrossTip>
        )}
      </div>
      <p className="nx-hist-said" role="status" aria-live={liveOf(cross, "burndown")}>
        {at ? sampleWords(at, unit) + entryWords(at) : atNow ? nowWords(atNow, unit)
          : bare ? noCostWords(bare) + entryWords(bare)
          : onNow ? `valued now, ${pointed!.dte} DTE: ${NO_COST_NOW}`
          : (offClose ? "● in hours · ○ not the close · point at a day to see why"
            : "● each day in hours · point at a day for its figures")
            + (anyBefore ? ` · faint: ${CORRECTED_WORDS}` : "")
            + (watched.length > 0 ? " · faint: before entry, while watched" : "")}
      </p>
    </>
  );
}
