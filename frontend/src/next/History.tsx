/** A holding's recorded history, drawn (#295, ADR 0023): the burndown and the IV chart, in the desk's
 *  inspector in REVIEW and as the main chart of the phone's one-holding REVIEW page.
 *
 *  Everything drawn is the service's (`/positions/{id}/samples`): each day's Cost to close, the
 *  planned decay at every DTE from the open (`onPace`, ADR 0011), the Target, the Stop and
 *  Manage-by, each leg's IV, and whether each day's row is the close. This joins served points and
 *  computes no curve: the plan is a polyline through the served DTEs, so the √ shape is the
 *  service's and not a guess redrawn here.
 *
 *  - **Read once, when opened.** The samples are asked for when a holding is shown in REVIEW, by
 *    its id, and never again while it stays shown: a row changes at most once a market day, and
 *    REVIEW does not poll (ADR 0023). A new valuation of the same holding asks nothing more.
 *  - **A point that is not a close is drawn hollow**, and says why when pointed at — hovered on the
 *    desk, tapped on the phone, or focused — in the line beneath the chart, and in a native tooltip
 *    too. The whole chart is the target: a pointer anywhere on it picks the nearest day, because
 *    days a few pixels apart cannot each have a finger's width of their own. A row written before
 *    observation times were kept is drawn faint: nothing says whether it was the close, so it is
 *    claimed neither way.
 *  - **Privacy** keeps the shape and drops every $ figure: the value axis and the Levels' figures
 *    go, the lines stay. The IV chart is in %, which privacy keeps.
 *
 *  Hand-written SVG at its measured width, as `Payoff.tsx` is, for the reasons that file gives.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { fetchSamples, type Holding, type Sample, type Samples } from "../api";
import { legCode } from "./legs";
import { SpxPath, spxGutter } from "./SpxPath";
import "./history.css";

interface SamplesState {
  id: string;
  samples?: Samples;
  error?: string;
}

/** The samples for `id`, asked for once per id: a new Holding object for the same id (a poll, a
 *  refresh) asks nothing. What is kept is the last ANSWER, under the id it answered: it is shown
 *  only while that is still the id asked about, so another holding's days are never drawn under
 *  this one while its own are asked for, and an answer for a holding no longer shown lands
 *  nowhere. */
function useSamples(id: string): SamplesState | null {
  const [state, setState] = useState<SamplesState | null>(null);
  useEffect(() => {
    let live = true;
    fetchSamples(id).then(
      (samples) => { if (live) setState({ id, samples }); },
      (err: unknown) => { if (live) setState({ id, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [id]);
  return state?.id === id ? state : null;
}

/** The width of the box, measured, so the drawing's text is the size it says wherever it sits. */
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

/** How a Cost to close is said: money across the contracts at the contract size the valuation
 *  served, points per contract without one, and nothing a stranger could read under privacy. */
interface Unit {
  size: number;
  contracts: number;
  money: boolean;
  hidden: boolean;
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function say(points: number, unit: Unit): string {
  if (unit.hidden) return "$•••";
  if (unit.money) return MONEY.format(points * unit.contracts * unit.size);
  return `${points.toFixed(2)} pts`;
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

/** What the chart's money is: across the contracts at the contract size, or per contract in points
 *  — said beside every figure, so it cannot read as the inspector's per-contract Cost to close in
 *  another unit. Nothing under privacy, where the count would give the size away. */
function scopeWords(unit: Unit): string | null {
  if (unit.hidden) return null;
  if (!unit.money) return "per contract";
  return `${unit.contracts} contract${unit.contracts === 1 ? "" : "s"}`;
}

const MARK: Record<Sample["timing"], "close" | "off-close" | "unrecorded"> = {
  close: "close", "after-close": "off-close", "before-open": "off-close", unrecorded: "unrecorded",
};

/** A label's width at the charts' 11px tabular figures, near enough to leave it room. */
const textWidth = (text: string) => text.length * 6.6;

export function HoldingHistory({ holding, privacy }: { holding: Holding; privacy: boolean }) {
  const state = useSamples(holding.id);
  const unit: Unit = {
    size: holding.contract_size ?? 1, contracts: holding.contracts,
    money: holding.contract_size !== null, hidden: privacy,
  };
  const served = state?.samples;
  const blank = state?.error !== undefined ? `the samples could not be read — ${state.error}`
    : !served ? "reading the samples…"
      : served.samples.length === 0 ? "no daily samples recorded yet: the sweep writes one a day while it is held"
        : null;
  // one pair of margins for all three charts, so a DTE is at the same x in each (#298)
  const gutters: Gutters | null = blank !== null || !served ? null : (() => {
    const iv = ivAxis(served, holding);
    return {
      L: Math.max(burndownAxis(served, holding, unit).L, iv?.L ?? 0, spxGutter(holding)),
      R: Math.max(R, iv?.RL ?? 0),
    };
  })();
  return (
    <>
      <section className="nx-hist" role="group" aria-label="burndown">
        <h4 className="nx-hist-h">
          Burndown
          {scopeWords(unit) === null ? null
            : <span className="nx-hist-unit">{`${unit.money ? "$" : "points"} to close, ${scopeWords(unit)}`}</span>}
        </h4>
        {blank !== null || !served ? <p className="nx-meta">{blank}</p>
          : <Burndown served={served} holding={holding} unit={unit} gutters={gutters!} />}
      </section>
      {blank === null && served ? (
        <section className="nx-hist" role="group" aria-label="IV by leg">
          <h4 className="nx-hist-h">IV by leg</h4>
          <IvChart served={served} holding={holding} gutters={gutters!} />
        </section>
      ) : null}
      {/* where SPX was against the strikes (#298), from the same answer — nothing more is asked —
          and on the burndown's DTE window, so the days line up */}
      {blank === null && served ? <SpxPath served={served} holding={holding} span={dteWindow(served)} gutters={gutters!} /> : null}
    </>
  );
}

/** Points in runs of consecutive days: a day with no row at all — the service down for a whole New
 *  York day — breaks the line, as a day without a reading does, rather than being drawn across. */
function runsOf<T extends { dte: number }>(points: (T | null)[]): T[][] {
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

/** The DTE window both charts draw: from the open (or the first sample, if earlier) on the left to
 *  expiry on the right, as time runs. */
function dteWindow(served: Samples): number {
  return Math.max(1, served.levels?.dte_at_open ?? 0, ...served.samples.map((s) => s.dte));
}

const H = 188, T = 10, B = 22, R = 10;

/** The plot's margins, the SAME for every chart of one holding (#298): the burndown, the IV chart
 *  and where SPX was all put a DTE at the same x, so a day reads straight down the three. Each is
 *  as wide as the widest chart needs. */
export interface Gutters {
  L: number;
  R: number;
}

/** The burndown's value axis, and the left margin its labels need. */
function burndownAxis(served: Samples, holding: Holding, unit: Unit) {
  const { levels, plan, samples } = served;
  // today's valuation, from REVIEW's one batch: drawn apart from the closes, and only while held
  const now = holding.closed_on === null && holding.cost_to_close !== null && holding.dte >= 0
    ? { dte: holding.dte, cost: holding.cost_to_close } : null;

  const values = [
    0, ...samples.map((s) => s.cost_to_close), ...plan.map((p) => p.on_pace),
    ...(levels?.target === null || levels?.target === undefined ? [] : [levels.target]),
    ...(levels?.stop === null || levels?.stop === undefined ? [] : [levels.stop]),
    ...(now ? [now.cost] : []),
  ];
  const hi = Math.max(...values), lo = Math.min(...values);
  const pad = (hi - lo || 1) * 0.08;
  const [top, bottom] = [hi + pad, lo - pad];
  // each value once: with every figure at or below zero the top IS zero, and named twice it was
  // two "$0" drawn over each other
  const axis = unit.hidden ? null : [...new Set([hi, ...(lo < 0 ? [lo] : []), 0])];
  // no gutter under privacy: one as wide as the labels would be would say how many digits they hid
  const L = axis === null ? 8 : Math.ceil(Math.max(...axis.map((v) => textWidth(say(v, unit))), 16)) + 10;
  return { now, top, bottom, axis, L };
}

function Burndown({ served, holding, unit, gutters }: {
  served: Samples; holding: Holding; unit: Unit; gutters: Gutters;
}) {
  const [box, W] = useWidth();
  const [pointed, setPointed] = useState<number | null>(null);
  const { levels, plan, samples } = served;
  const span = dteWindow(served);
  const { now, top, bottom, axis } = burndownAxis(served, holding, unit);
  // shared with the other charts; under privacy no wider than they need, so it says nothing
  const { L, R } = gutters;
  const x = (dte: number) => L + ((span - dte) / span) * (W - L - R);
  const y = (v: number) => T + ((top - v) / (top - bottom)) * (H - T - B);
  const pts = (rows: { dte: number; v: number }[]) =>
    rows.map(({ dte, v }) => `${x(dte).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const level = (kind: "target" | "stop", v: number | null | undefined) => v === null || v === undefined ? null : (
    <g data-level={kind} className={`nx-hist-${kind}`}>
      <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
      <text x={W - R} y={y(v) - 4} textAnchor="end">{unit.hidden ? kind : `${kind} ${say(v, unit)}`}</text>
    </g>
  );
  const manageX = levels ? x(levels.manage_by_dte) : null;
  // Manage-by is named on the bottom line between the window's two ends, and never over either:
  // at the top it sat on the Stop's label, which is the highest line drawn
  const [startWords, endWords] = [`${span} DTE`, "expiry"];
  const manageWords = levels ? `manage-by ${levels.manage_by_dte}` : "";
  const half = textWidth(manageWords) / 2;
  const manageLabelX = manageX === null ? null : Math.min(
    Math.max(manageX, L + textWidth(startWords) + 6 + half), W - R - textWidth(endWords) - 6 - half);
  const point = pointed === null ? null : samples[pointed] ?? null;
  /** The day nearest the pointer, across the width: what a hover or a tap anywhere on the chart
   *  means. A day's own mark answers for itself, so its events are not taken twice. */
  const nearest = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const at = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    samples.forEach((s, i) => {
      if (Math.abs(x(s.dte) - at) < Math.abs(x(samples[best]!.dte) - at)) best = i;
    });
    setPointed(best);
  };
  /** The arrows move a day at a time, Home and End to either end; the line beneath says each. */
  const onKey = (e: React.KeyboardEvent) => {
    const last = samples.length - 1;
    const next = e.key === "ArrowRight" ? (pointed === null ? 0 : Math.min(last, pointed + 1))
      : e.key === "ArrowLeft" ? (pointed === null ? last : Math.max(0, pointed - 1))
        : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null || last < 0) return;
    e.preventDefault();
    setPointed(next);
  };
  const own = (e: React.SyntheticEvent) => e.target instanceof Element && e.target.closest("[data-sample]") !== null;
  const offClose = samples.some((s) => s.timing !== "close");

  return (
    <>
      {/* ONE stop for the keyboard: the days are reached with the arrows and said by the status
          line, since inside an image they would be presentational and each a tab stop besides */}
      <div className="nx-hist-chart" ref={box} role="group" tabIndex={0} onKeyDown={onKey}
           aria-label={`cost to close by day, ${samples.length} days, against the plan: arrow keys move from day to day`}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"
             onPointerMove={(e) => { if (e.pointerType === "mouse" && !own(e)) nearest(e); }}
             onClick={(e) => { if (!own(e)) nearest(e); }}>
          {level("stop", levels?.stop)}
          {level("target", levels?.target)}
          {manageX === null || levels!.manage_by_dte > span ? null : (
            <g data-level="manage-by" className="nx-hist-manage">
              <line x1={manageX} x2={manageX} y1={T} y2={H - B} />
              <text x={manageLabelX!} y={H - 6} textAnchor="middle">{manageWords}</text>
            </g>
          )}
          {axis === null ? null : (
            <g data-axis="y">
              {axis.map((v) => <text key={v} x={L - 6} y={y(v) + 4} textAnchor="end">{say(v, unit)}</text>)}
            </g>
          )}
          <line className="nx-hist-zero" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
          {plan.length > 1 ? (
            <polyline data-plan="" className="nx-hist-plan"
                      points={pts(plan.map((p) => ({ dte: p.dte, v: p.on_pace })))} />
          ) : null}
          {runsOf(samples.map((s) => ({ dte: s.dte, v: s.cost_to_close }))).map((run) => (
            <polyline key={run[0]!.dte} data-costs="" className="nx-hist-costs" points={pts(run)} />
          ))}
          {samples.map((s, i) => {
            const why = sampleWords(s, unit);
            return (
              <g key={s.observed_on} data-sample={s.observed_on} data-timing={s.timing}
                 data-pointed={pointed === i ? "" : undefined} className="nx-hist-point"
                 onMouseEnter={() => setPointed(i)} onClick={() => setPointed(i)}>
                <title>{why}</title>
                <circle data-mark={MARK[s.timing]} cx={x(s.dte)} cy={y(s.cost_to_close)} r={3.25} />
              </g>
            );
          })}
          {now ? (
            <g data-now="" className="nx-hist-now">
              <title>{`valued now, ${now.dte} DTE: ${say(now.cost, unit)}`}</title>
              <rect x={x(now.dte) - 4} y={y(now.cost) - 4} width={8} height={8}
                    transform={`rotate(45 ${x(now.dte)} ${y(now.cost)})`} />
            </g>
          ) : null}
          <text x={L} y={H - 6} textAnchor="start">{startWords}</text>
          <text x={W - R} y={H - 6} textAnchor="end">{endWords}</text>
        </svg>
      </div>
      <p className="nx-hist-said" role="status">
        {point ? sampleWords(point, unit)
          : offClose ? "● in hours · ○ not the close · point at a day to see why"
            : "● each day in hours · point at a day for its figures"}
      </p>
      {levels === null ? <p className="nx-meta">no plan: Opened not recorded, so there is no schedule to draw</p> : null}
    </>
  );
}

/** One day, said in full: its date and DTE, its figures, and whether it was the close. */
function sampleWords(s: Sample, unit: Unit): string {
  const pace = s.on_pace === null ? "" : ` · on pace ${say(s.on_pace, unit)}`;
  const scope = scopeWords(unit);
  const cost = `to close${scope === null ? "" : `, ${scope}`}: ${say(s.cost_to_close, unit)}`;
  return `${dayWords(s.observed_on)} · ${s.dte} DTE · ${cost}${pace} — ${whyWords(s)}`;
}

const IV_H = 132;

/** Each leg's IV per day, a line per leg named by its side and strike. A day with no IV is a gap,
 *  never a line drawn across it. In %, which privacy keeps (ADR 0023). */
/** The IV chart's legs, value axis and the margins its labels need; null with no reading at all. */
function ivAxis(served: Samples, holding: Holding) {
  const legs = holding.legs.map((l) => ({
    code: legCode(holding.strike_date, l),
    name: `${l.side === "short" ? "−" : "+"}${l.option_type[0]}${l.strike}`,
    short: l.side === "short",
  }));
  const readings = served.samples.flatMap((s) => Object.values(s.legs_iv ?? {}));
  if (readings.length === 0) return null;
  const hi = Math.max(...readings), lo = Math.min(...readings);
  const pad = Math.max((hi - lo) * 0.12, 0.5);
  const [top, bottom] = [hi + pad, lo - pad];
  const ticks = [hi, lo];
  const label = (v: number) => `${v.toFixed(1)}%`;
  const L = Math.ceil(Math.max(...ticks.map((v) => textWidth(label(v))))) + 10;
  // the leg names sit at the right end of each line, so the plot stops short of them
  const RL = Math.ceil(Math.max(...legs.map((l) => textWidth(l.name)))) + 8;
  return { legs, top, bottom, ticks, label, L, RL };
}

function IvChart({ served, holding, gutters }: { served: Samples; holding: Holding; gutters: Gutters }) {
  const [box, W] = useWidth();
  const span = dteWindow(served);
  const scale = ivAxis(served, holding);
  if (scale === null) return <p className="nx-meta">no IV recorded on any day</p>;
  const { legs, top, bottom, ticks, label } = scale;
  const { L, R: RL } = gutters;
  const x = (dte: number) => L + ((span - dte) / span) * (W - L - RL);
  const y = (v: number) => T + ((top - v) / (top - bottom)) * (IV_H - T - B);

  // each leg's runs of consecutive days with a reading: a day without one breaks the line, and a
  // leg never read is not drawn at all
  const lines = legs.flatMap((leg) => {
    const drawn = runsOf(served.samples.map((s) => {
      const v = s.legs_iv?.[leg.code];
      return typeof v === "number" ? { dte: s.dte, v } : null;
    }));
    const last = drawn.at(-1)?.at(-1);
    return last ? [{ leg, drawn, last, labelY: y(last.v) }] : [];
  });
  // two legs ending at nearly the same IV would print their names over each other: each is pushed
  // down below the one above it, then the whole column back up if it ran off the bottom
  const byY = [...lines].sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < byY.length; i++) byY[i]!.labelY = Math.max(byY[i]!.labelY, byY[i - 1]!.labelY + 12);
  const over = (byY.at(-1)?.labelY ?? 0) - (IV_H - B);
  if (over > 0) for (const l of byY) l.labelY = Math.max(T, l.labelY - over);

  return (
    <div className="nx-hist-chart" ref={box}>
      <svg width={W} height={IV_H} viewBox={`0 0 ${W} ${IV_H}`} role="img" aria-label="each leg's implied volatility by day">
        <g data-axis="y">
          {ticks.map((v, i) => <text key={i} x={L - 6} y={y(v) + 4} textAnchor="end">{label(v)}</text>)}
        </g>
        {lines.map(({ leg, drawn, labelY, last }) => (
          <g key={leg.code} data-leg={leg.code} className="nx-hist-leg" data-side={leg.short ? "short" : "long"}>
            {drawn.map((run, i) => (
              <polyline key={i} points={run.map((p) => `${x(p.dte).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} />
            ))}
            {drawn.flat().map((p) => <circle key={p.dte} data-dte={p.dte} cx={x(p.dte)} cy={y(p.v)} r={2} />)}
            <text x={x(last.dte) + 6} y={labelY + 4}>{leg.name}</text>
          </g>
        ))}
        <text x={L} y={IV_H - 6} textAnchor="start">{`${span} DTE`}</text>
        <text x={W - 4} y={IV_H - 6} textAnchor="end">expiry</text>
      </svg>
    </div>
  );
}
