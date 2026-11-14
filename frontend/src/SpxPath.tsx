/** "Where SPX was against my strikes" (#298, ADR 0023): a holding's Daily samples as SPX's price per
 *  day, against every strike it holds — in the desk's inspector and the phone's holding sheet,
 *  beneath the burndown and the IV chart, on the same DTE axis as both.
 *
 *  - **Every figure is the service's.** Each day's price is the sample's own `spx`, derived by the
 *    sweep that wrote it from its batch (ADR 0024); SPX now is the valuation's `spx`, from the book's
 *    latest batch. Nothing here is a Reference's figure. Each short strike's distance that day, in
 *    points and σ, is the service's too (`short_strikes`, #395): the browser measures none.
 *  - **A day without SPX's price is a gap**, never a point at zero: rows stored before SPX was
 *    recorded (migration 0010) are null, and so is a day whose batch could not give it. The line
 *    breaks there, the range ignores it, and the count of such days is said beneath. The crosshair
 *    still stops on it, and the readout says it has no price.
 *  - **The crosshair is the history's, shared** (`Crosshair.tsx`, #395): a day pointed at in any
 *    panel is crossed here, and the readout says SPX that day and its distance to each short strike.
 *  - **Read from the burndown's answer**: it asks for nothing of its own.
 *  - **Privacy** has nothing to hide here: prices and strikes, no $ figure and no count.
 *
 *  On visx (`@visx/scale`, `@visx/shape`) at its measured width, as the burndown and the IV chart are.
 */
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";

import type { Holding, Samples } from "./shared/api";
import { heldLeg, legText } from "./shared/format";
import { spxRange, spxRuns, unrecorded } from "./spxdays";
import { Leg, SvgLeg } from "./shared/Legs";
import { textWidth } from "./burndown";
import { useWidth } from "./BurndownChart";
import { CrossTip, dayScale, pointedStop, usePanel, type Cross, type Gutters } from "./Crosshair";
import { dayWords, MARK, spxLines, spxWords } from "./historyDays";

const H = 156, T = 10, B = 22;

/** What it reads of a holding: its legs, and — only while held and valued — SPX now and its short
 *  strikes' distances from it. A closed holding (#296) has neither a valuation nor a "now". */
type Charted = Pick<Holding, "legs" | "closed_on"> & Partial<Pick<Holding, "spx" | "dte" | "short_strikes">>;

const namesOf = (holding: Pick<Holding, "legs">) => holding.legs.map((l) => legText(heldLeg(l), "name"));

/** The left margin this chart's strike names need, for the margins all three charts share. */
export const spxGutter = (holding: Pick<Holding, "legs">) =>
  Math.ceil(Math.max(...namesOf(holding).map(textWidth), 16)) + 10;

/** A short strike as the readout names it. */
const shortLeg = (k: { option_type: string; strike: number }) => ({ short: true, option_type: k.option_type, strike: k.strike });

/** `span` is the burndown's DTE window and `gutters` the margins all three charts share, handed
 *  down so a day lands at the same x in each (#298); `cross` the crosshair they share (#395). */
export function SpxPath({ served, holding, span, gutters, cross }: {
  served: Samples; holding: Charted; span: number; gutters: Gutters; cross: Cross;
}) {
  const [box, W] = useWidth();
  const x = dayScale(span, W, gutters);
  const { svg: hands, onKeyDown } = usePanel(cross, box, cross.stops.map((s) => x(s.dte)), W);
  const runs = spxRuns(served.samples);
  const missing = unrecorded(served.samples);
  const gapWords = missing === 0 ? null
    : `${missing} day${missing === 1 ? "" : "s"} stored without SPX's price: a gap, never zero`;
  const strikes = holding.legs.map((l, i) => ({ i, strike: l.strike, side: l.side, type: l.option_type }));
  const now = holding.closed_on === null && typeof holding.spx === "number" && holding.dte !== undefined
    && holding.dte >= 0
    ? { dte: holding.dte, spx: holding.spx } : null;

  if (runs.length === 0) {
    return (
      <section className="nx-hist" role="group" aria-label="SPX against the strikes">
        <h4 className="nx-hist-h">SPX against the strikes</h4>
        <p className="nx-meta">
          no day carries SPX's price: these days were stored before it was recorded, or their batch could not give it
        </p>
      </section>
    );
  }

  const [lo, hi] = spxRange(served.samples, strikes.map((k) => k.strike), now?.spx ?? null);
  const { L, R } = gutters;
  const y = scaleLinear<number>({ domain: [lo, hi], range: [H - B, T] });
  // each strike's name at its line in the gutter; two strikes close together would print over each
  // other, so each is pushed below the one above it, then the column back up if it ran off
  const labels = strikes.map((k) => ({ ...k, at: y(k.strike) })).sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++) labels[i]!.at = Math.max(labels[i]!.at, labels[i - 1]!.at + 14);
  const over = (labels.at(-1)?.at ?? 0) - (H - B);
  if (over > 0) for (const l of labels) l.at = Math.max(T, l.at - over);
  // by the leg, never by its strike alone: an iron fly's short put and short call share one
  const labelAt = new Map(labels.map((l) => [l.i, l.at]));

  const first = runs[0]![0]!;
  const last = runs.at(-1)!.at(-1)!;
  const said = [
    `SPX ${first.spx.toFixed(2)} on ${dayWords(first.on)}`,
    ...(last === first ? [] : [`${last.spx.toFixed(2)} on ${dayWords(last.on)}`]),
  ].join(" → ");
  const timing = new Map(served.samples.map((s) => [s.observed_on, s.timing]));

  const pointed = pointedStop(cross);
  const read = pointed === null ? null : spxLines(pointed, holding);
  const name = (k: { option_type: string; strike: number }) => legText(shortLeg(k), "name");

  return (
    <section className="nx-hist" role="group" aria-label="SPX against the strikes">
      <h4 className="nx-hist-h">SPX against the strikes</h4>
      <div className="nx-hist-chart nx-cross nx-spxp" ref={box} role="group" tabIndex={0} onKeyDown={onKeyDown}
           aria-label={`SPX's price by day against the strikes: ${said}${gapWords ? `; ${gapWords}` : ""}: `
             + "arrow keys move from day to day"}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" {...hands}>
          <rect data-plot="" x={L} y={T} width={Math.max(0, W - L - R)} height={H - T - B} fill="none" />
          {/* the side each short strike loses on, faintly: below a put's, above a call's */}
          {strikes.filter((k) => k.side === "short").map((k) => {
            const edge = Math.min(Math.max(y(k.strike), T), H - B);
            const [top, bottom] = k.type === "PUT" ? [edge, H - B] : [T, edge];
            return <rect key={`loss${k.i}`} className="nx-spxp-loss" x={L} width={Math.max(0, W - L - R)}
                         y={top} height={Math.max(0, bottom - top)} />;
          })}
          {strikes.map((k) => (
            <g key={k.i} data-strike={k.strike} data-side={k.side} className="nx-spxp-k">
              <line x1={L} x2={W - R} y1={y(k.strike)} y2={y(k.strike)} />
              <SvgLeg leg={{ short: k.side === "short", option_type: k.type, strike: k.strike }} form="name"
                      x={L - 6} y={labelAt.get(k.i)! + 4} textAnchor="end" />
            </g>
          ))}
          {runs.map((run) => (
            <LinePath key={run[0]!.on} data-spx-run="" className="nx-spxp-line" data={run}
                      x={(d) => x(d.dte)} y={(d) => y(d.spx)} />
          ))}
          {runs.flat().map((d) => (
            <circle key={d.on} data-spx-day={d.on} className="nx-spxp-day" data-mark={MARK[timing.get(d.on)!]}
                    cx={x(d.dte)} cy={y(d.spx)} r={2.5} />
          ))}
          {now ? (
            <g data-spx-now="" className="nx-spxp-now">
              <rect x={x(now.dte) - 4} y={y(now.spx) - 4} width={8} height={8}
                    transform={`rotate(45 ${x(now.dte)} ${y(now.spx)})`} />
            </g>
          ) : null}
          {pointed === null || read === null ? null : (
            <g data-crosshair={pointed.on ?? "now"} className="nx-bd-cross" pointerEvents="none">
              <line x1={x(pointed.dte)} x2={x(pointed.dte)} y1={T} y2={H - B} />
              {read.value === null ? null : (
                <>
                  <line x1={L} x2={W - R} y1={y(read.value)} y2={y(read.value)} />
                  <circle className="nx-bd-cross-day" data-mark={pointed.sample ? MARK[pointed.sample.timing] : "close"}
                          cx={x(pointed.dte)} cy={y(read.value)} r={4.25} />
                </>
              )}
            </g>
          )}
          <text x={L} y={H - 6} textAnchor="start">{`${span} DTE`}</text>
          <text x={W - 4} y={H - 6} textAnchor="end">expiry</text>
        </svg>
        {read === null || pointed === null ? null : (
          <CrossTip x={x(pointed.dte)} ys={[read.value === null ? (T + H - B) / 2 : y(read.value)]} W={W} H={H}>
            <div className="nx-bd-tip-h">{read.day}</div>
            <div>{read.spx}</div>
            {read.strikes.map(({ k, words }) => (
              <div key={k.code} data-spx-strike=""><Leg leg={shortLeg(k)} form="name" />{` ${words}`}</div>
            ))}
            {read.why === null ? null : <div className="nx-bd-tip-why">{read.why}</div>}
          </CrossTip>
        )}
      </div>
      <p className="nx-hist-said" role="status">
        {pointed !== null ? spxWords(pointed, holding, name) : (
          <>
            {`${said}${now ? ` · now ${now.spx.toFixed(2)}` : ""}`}
            {gapWords ? <><br />{gapWords}</> : null}
          </>
        )}
      </p>
    </section>
  );
}
