/** "Where SPX was against my strikes" (#298): a holding's Daily samples as SPX's price per day.
 *  Pure — the chart in `SpxPath.tsx` draws exactly this (named apart from it: on a case-blind disk `./SpxPath` would find `spxpath.ts`).
 *
 *  Each day's figure is the sample's own `spx`, as the sweep that wrote it derived it from its batch
 *  (ADR 0024). A row stored before SPX was recorded, or by a sweep whose batch could not give it,
 *  is null: that day is a GAP in the line, never a point at zero, and it is not part of the range
 *  either — a zero there would flatten every real day into one line at the top.
 */
import type { Sample } from "../api";

export interface SpxDay {
  on: string;
  dte: number;
  spx: number;
}

/** The days that carry SPX's price, in runs of consecutive days: a day without it, or a day with no
 *  row at all, ends a run, so the line is never drawn across what was not recorded. */
export function spxRuns(samples: Sample[]): SpxDay[][] {
  const runs: SpxDay[][] = [];
  let run: SpxDay[] = [];
  for (const s of samples) {
    const last = run.at(-1);
    if (typeof s.spx !== "number" || (last !== undefined && last.dte - s.dte > 1)) {
      if (run.length > 0) runs.push(run);
      run = [];
    }
    if (typeof s.spx === "number") run.push({ on: s.observed_on, dte: s.dte, spx: s.spx });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** How many days were stored without SPX's price. */
export const unrecorded = (samples: Sample[]) => samples.filter((s) => typeof s.spx !== "number").length;

/** The prices the chart spans: every strike, every day's SPX and SPX now, padded. */
export function spxRange(samples: Sample[], strikes: number[], now: number | null): [number, number] {
  const xs = [...strikes, ...spxRuns(samples).flat().map((d) => d.spx), ...(now === null ? [] : [now])];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.08, 10);
  return [lo - pad, hi + pad];
}
