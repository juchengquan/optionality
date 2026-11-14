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
 *  - **The crosshair** stops at every day and at today's valuation after them. It follows a mouse.
 *    A finger chooses by a tap — a second tap, a tap outside the chart or a scroll lets go — or by
 *    a drag that has gone sideways, which scrubs, while a vertical one still scrolls the page
 *    (`touch-action: pan-y`) and chooses nothing. The arrow keys move it a stop at a time, Home
 *    and End to the ends; Escape lets go of a day, and with none chosen is left to the page, whose
 *    inspector it closes. ONE tab stop, as the days inside an image would each be one otherwise.
 *    The tooltip is for the eye and is hidden from a screen reader; the status line beneath says
 *    the same stop in full, and is what is announced.
 *  - **A leg's quantity corrected** (#359): the days summed before it are another structure's Cost
 *    to close, kept as they were. Their points and their stretch of the line are drawn faint and
 *    dashed, no gap to the plan is shaded over them, a rule marks the New York day it was corrected,
 *    and the tooltip and the status line say "summed before a leg's quantity was corrected".
 *  - **Privacy** keeps the shape and drops every $ figure: no value axis and no gutter for one, the
 *    Levels named without their figures, the tooltip's money masked. The Pace gap is in points,
 *    which privacy keeps.
 *
 *  visx for the scales and the shapes only (`@visx/scale`, `shape`, `threshold`). The axes, the grid
 *  and the tooltip are drawn here: `@visx/axis` brings `@visx/text` and with it `reduce-css-calc`
 *  1.x, unmaintained since 2016, for labels this chart places by hand anyway; and the prototype's
 *  `TooltipWithBounds` ran off the 272px inspector (`tipPlace`).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { Threshold } from "@visx/threshold";

import type { Sample, Samples } from "./shared/api";
import {
  CORRECTED_WORDS, correctionDte, costRuns, nearestDay, nowLines, nowWords, sampleWords, say, stepDay,
  textWidth, tipLines, tipPlace, valueAxis, type Unit,
} from "./burndown";

const H = 196, T = 16, B = 22;
/** The tooltip's width, or the chart's where that is narrower. */
const TIP_W = 192;
/** How far a finger must move sideways, and more sideways than up or down, before it scrubs: until
 *  then the page may yet take it as a scroll, and a scroll is never a choice of day. */
const SCRUB = 10;

const MARK: Record<Sample["timing"], "close" | "off-close" | "unrecorded"> = {
  close: "close", "after-close": "off-close", "before-open": "off-close", unrecorded: "unrecorded",
};

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
 *  chart of the holding shares (#298), so a day is at the same x here as in the IV chart and SPX's
 *  path beneath. `closeDte` is a closed holding's last day (#296). */
export function Burndown({ served, unit, axis, span, gutters: { L, R }, closeDte }: {
  served: Samples; unit: Unit; axis: ReturnType<typeof valueAxis>; span: number;
  gutters: { L: number; R: number }; closeDte: number | null;
}) {
  const [box, W] = useWidth();
  const id = useId().replace(/:/g, "");
  const [pointed, setPointed] = useState<number | null>(null);
  // the tooltip's height, measured once drawn: how much room it needs above or below its day. No
  // guess to start from — a layout effect measures it before it is ever painted, and a guess would
  // only hide a measurement that stopped happening (#360's review)
  const tipBox = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(0);
  useLayoutEffect(() => {
    const h = tipBox.current?.offsetHeight;
    if (h && h !== tipH) setTipH(h);
  });
  const { levels, plan, samples } = served;
  const { now } = axis;
  const x = scaleLinear<number>({ domain: [span, 0], range: [L, W - R] });
  const y = scaleLinear<number>({ domain: [axis.lo, axis.hi], range: [H - B, T] });
  // the crosshair's stops: every day, then today's valuation, which is drawn apart from them
  const xs = [...samples.map((s) => x(s.dte)), ...(now ? [x(now.dte)] : [])];

  const level = (kind: "target" | "stop", v: number) => (unit.hidden ? kind : `${kind} ${say(v, unit)}`);
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
  const missed = missedDays(samples);
  const dayW = (W - L - R) / span;
  // the gap to the plan is shaded only where a day has its own On-pace, and a Cost to close summed
  // under the quantities as they now are (#359)
  const paced = runsOf(samples.map((s) => (s.on_pace === null || s.before_correction
    ? null : { dte: s.dte, cost: s.cost_to_close, pace: s.on_pace })));
  const corrected = correctionDte(served);

  const at = pointed === null ? null : samples[pointed] ?? null;
  const atNow = pointed !== null && pointed === samples.length && now !== null ? now : null;
  /** The stop nearest a pointer, from where it is across the drawing. */
  const nearest = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    // the drawing is its measured width, but should the box ever be scaled the pointer is not
    return nearestDay(xs, (e.clientX - box.left) * (box.width > 0 ? W / box.width : 1));
  };
  const pick = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const stop = nearest(e);
    if (stop !== null) setPointed(stop);
  };
  // A mouse points by moving. A finger chooses a day only by a TAP, or by a drag that has gone
  // sideways (`SCRUB`): never on touching down, because a vertical scroll that starts on the chart
  // touches down too, and then left a day chosen for the life of the page (#360's review)
  const kind = useRef("mouse");
  const touch = useRef<{ x0: number; y0: number; scrubbing: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    kind.current = e.pointerType;
    if (e.pointerType === "mouse") pick(e);
    else touch.current = { x0: e.clientX, y0: e.clientY, scrubbing: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse") { pick(e); return; }
    const t = touch.current;
    if (!t) return;
    const [dx, dy] = [Math.abs(e.clientX - t.x0), Math.abs(e.clientY - t.y0)];
    if (!t.scrubbing && (dx < SCRUB || dx <= dy)) return;
    t.scrubbing = true;
    pick(e);
  };
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const t = touch.current;
    touch.current = null;
    if (kind.current === "mouse") { pick(e); return; }
    // a scrub ends on the day it reached; a tap chooses a day, or lets go of the one chosen
    if (t?.scrubbing) return;
    const stop = nearest(e);
    setPointed(stop === pointed ? null : stop);
  };
  // the page took the touch — a scroll — so nothing the finger did chooses a day
  const onPointerCancel = () => { touch.current = null; setPointed(null); };
  // a tap or a click anywhere outside the chart lets go of the day it was showing
  useEffect(() => {
    if (pointed === null) return;
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setPointed(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [pointed, box]);
  const onKey = (e: React.KeyboardEvent) => {
    const next = stepDay(e.key, pointed, xs.length);
    if (next === undefined) return;
    e.preventDefault();
    setPointed(next === "clear" ? null : next);
  };
  const tip = at === null && atNow === null ? null : (() => {
    const tipW = Math.min(TIP_W, W);
    const [px, py] = at ? [x(at.dte), y(at.cost_to_close)] : [x(atNow!.dte), y(atNow!.cost)];
    const lines = at ? tipLines(at, unit) : { ...nowLines(atNow!, unit), pace: null, gap: null, why: null, corrected: null };
    return { tipW, lines, ...tipPlace({ x: px, y: py, W, H, tipW, tipH }) };
  })();
  const offClose = samples.some((s) => s.timing !== "close");
  const anyBefore = samples.some((s) => s.before_correction);

  return (
    <>
      {/* ONE stop for the keyboard: the days are reached with the arrows and said by the status
          line, since inside an image they would be presentational and each a tab stop besides */}
      <div className="nx-hist-chart nx-bd" ref={box} role="group" tabIndex={0} onKeyDown={onKey}
           aria-label={`cost to close by day, ${samples.length} days, against the plan: `
             + "arrow keys move from day to day"}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"
             onPointerMove={onPointerMove} onPointerDown={onPointerDown} onClick={onClick}
             onPointerCancel={onPointerCancel}
             onPointerLeave={(e) => { if (e.pointerType === "mouse") setPointed(null); }}>
          <defs>
            <pattern id={`${id}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(45)">
              <line className="nx-bd-hatch" x1="0" y1="0" x2="0" y2="4" />
            </pattern>
          </defs>
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
          {costRuns(samples).map(({ before, run }) => (
            <LinePath key={`${run[0]!.dte}${before}`} data-costs={before ? "before-correction" : ""}
                      className="nx-hist-costs" data={run}
                      x={(s) => x(s.dte)} y={(s) => y(s.cost_to_close)} />
          ))}
          {samples.map((s, i) => (
            <g key={s.observed_on} data-sample={s.observed_on} data-timing={s.timing}
               data-before-correction={s.before_correction ? "" : undefined}
               data-pointed={pointed === i ? "" : undefined} className="nx-hist-point">
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
          <div className="nx-bd-tip" ref={tipBox} data-tip="" aria-hidden="true"
               style={{ left: tip.left, top: tip.top, width: tip.tipW }}>
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
          </div>
        )}
      </div>
      <p className="nx-hist-said" role="status">
        {at ? sampleWords(at, unit) : atNow ? nowWords(atNow, unit)
          : (offClose ? "● in hours · ○ not the close · point at a day to see why"
            : "● each day in hours · point at a day for its figures")
            + (anyBefore ? ` · faint: ${CORRECTED_WORDS}` : "")}
      </p>
    </>
  );
}
