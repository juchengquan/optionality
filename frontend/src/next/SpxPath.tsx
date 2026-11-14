/** "Where SPX was against my strikes" (#298, ADR 0023): a holding's Daily samples as SPX's price per
 *  day, against every strike it holds — in the desk's inspector and the phone's holding sheet,
 *  beneath the burndown and the IV chart, on the same DTE axis as both.
 *
 *  - **Every figure is the service's.** Each day's price is the sample's own `spx`, derived by the
 *    sweep that wrote it from its batch (ADR 0024); SPX now is the valuation's `spx`, from the book's
 *    latest batch. Nothing here is a Reference's figure.
 *  - **A day without SPX's price is a gap**, never a point at zero: rows stored before SPX was
 *    recorded (migration 0010) are null, and so is a day whose batch could not give it. The line
 *    breaks there, the range ignores it, and the count of such days is said beneath.
 *  - **Read from the burndown's answer**: it asks for nothing of its own.
 *  - **Privacy** has nothing to hide here: prices and strikes, no $ figure and no count.
 *
 *  Hand-written SVG at its measured width, as `History.tsx` and `Payoff.tsx` are.
 */
import { useLayoutEffect, useRef, useState } from "react";

import type { Holding, Samples } from "../shared/api";
import { spxRange, spxRuns, unrecorded } from "./spxdays";

const H = 156, T = 10, B = 22;

/** A label's width at the charts' 11px tabular figures, near enough to leave it room. */
const textWidth = (text: string) => text.length * 6.6;

/** The box's width, measured, as the burndown measures its own: the text is the size it says. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
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

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const dayWords = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/** Each leg's name as the chart writes it in its left margin. */
/** What it reads of a holding: its legs, and — only while held and valued — SPX now. A closed
 *  holding (#296) has neither a valuation nor a "now". */
type Charted = Pick<Holding, "legs" | "closed_on"> & Partial<Pick<Holding, "spx" | "dte">>;

const namesOf = (holding: Charted) => holding.legs.map((l) => `${l.option_type[0]}${l.strike}`);

/** The left margin this chart's strike names need, for the margins all three charts share. */
export const spxGutter = (holding: Charted) =>
  Math.ceil(Math.max(...namesOf(holding).map(textWidth), 16)) + 10;

/** `span` is the burndown's DTE window and `gutters` the margins all three charts share, handed
 *  down so a day lands at the same x in each (#298). */
export function SpxPath({ served, holding, span, gutters }: {
  served: Samples; holding: Charted; span: number; gutters: { L: number; R: number };
}) {
  const [box, W] = useWidth();
  const runs = spxRuns(served.samples);
  const missing = unrecorded(served.samples);
  const gapWords = missing === 0 ? null
    : `${missing} day${missing === 1 ? "" : "s"} stored without SPX's price: a gap, never zero`;
  const names = namesOf(holding);
  const strikes = holding.legs.map((l, i) => ({
    i, strike: l.strike, side: l.side, type: l.option_type, name: names[i]!,
  }));
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
  const x = (dte: number) => L + ((span - dte) / span) * (W - L - R);
  const y = (p: number) => T + ((hi - p) / (hi - lo)) * (H - T - B);
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

  return (
    <section className="nx-hist" role="group" aria-label="SPX against the strikes">
      <h4 className="nx-hist-h">SPX against the strikes</h4>
      <div className="nx-hist-chart nx-spxp" ref={box}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
             aria-label={`SPX's price by day against the strikes: ${said}${gapWords ? `; ${gapWords}` : ""}`}>
          {/* the side each short strike loses on, faintly: below a put's, above a call's */}
          {strikes.filter((k) => k.side === "short").map((k) => {
            const edge = Math.min(Math.max(y(k.strike), T), H - B);
            const [top, bottom] = k.type === "PUT" ? [edge, H - B] : [T, edge];
            return <rect key={`loss${k.i}`} className="nx-spxp-loss" x={L} width={W - L - R}
                         y={top} height={Math.max(0, bottom - top)} />;
          })}
          {strikes.map((k) => (
            <g key={k.i} data-strike={k.strike} data-side={k.side} className="nx-spxp-k">
              <line x1={L} x2={W - R} y1={y(k.strike)} y2={y(k.strike)} />
              <text x={L - 6} y={labelAt.get(k.i)! + 4} textAnchor="end">{k.name}</text>
            </g>
          ))}
          {runs.map((run) => (
            <polyline key={run[0]!.on} data-spx-run="" className="nx-spxp-line"
                      points={run.map((d) => `${x(d.dte).toFixed(1)},${y(d.spx).toFixed(1)}`).join(" ")} />
          ))}
          {runs.flat().map((d) => (
            <circle key={d.on} data-spx-day={d.on} className="nx-spxp-day" cx={x(d.dte)} cy={y(d.spx)} r={2.5}>
              <title>{`${dayWords(d.on)} · ${d.dte} DTE · SPX ${d.spx.toFixed(2)}`}</title>
            </circle>
          ))}
          {now ? (
            <g data-spx-now="" className="nx-spxp-now">
              <title>{`SPX now, ${now.dte} DTE: ${now.spx.toFixed(2)}`}</title>
              <rect x={x(now.dte) - 4} y={y(now.spx) - 4} width={8} height={8}
                    transform={`rotate(45 ${x(now.dte)} ${y(now.spx)})`} />
            </g>
          ) : null}
          <text x={L} y={H - 6} textAnchor="start">{`${span} DTE`}</text>
          <text x={W - 4} y={H - 6} textAnchor="end">expiry</text>
        </svg>
      </div>
      <p className="nx-hist-said">
        {`${said}${now ? ` · now ${now.spx.toFixed(2)}` : ""}`}
        {gapWords ? <><br />{gapWords}</> : null}
      </p>
    </section>
  );
}
