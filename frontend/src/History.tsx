/** A holding's recorded history, drawn (#295, ADR 0023): the burndown and the IV chart, in the desk's
 *  inspector and the phone's holding sheet behind `HistoryOnDemand` (#353), which both open from the
 *  start outside the session and leave shut in it (#372, #374); and in a closed trade's detail in
 *  the journal (`ClosedTrade`).
 *
 *  Everything drawn is the service's (`/positions/{id}/samples`): each day's Cost to close, the
 *  planned decay at every DTE from the open (`onPace`, ADR 0011), the Target, the Stop and
 *  Manage-by, each leg's IV, and whether each day's row is the close. This joins served points and
 *  computes no curve: the plan is a polyline through the served DTEs, so the √ shape is the
 *  service's and not a guess redrawn here.
 *
 *  - **Read once, when opened.** The samples are asked for when a holding's history is drawn —
 *    opened by hand, or open from the start outside the session — by its id, and never again while
 *    it stays shown: a row changes at most once a market day, and no poll reads it, in session or
 *    out (ADR 0023). A new valuation of
 *    the same holding asks nothing more.
 *  - **A point that is not a close is drawn hollow**, and says why when pointed at — hovered on the
 *    desk, tapped or scrubbed on the phone, or stepped to with the keys — in the crosshair's
 *    tooltip and in the status line beneath the chart (`BurndownChart.tsx`, #360). A row written before
 *    observation times were kept is drawn faint: nothing says whether it was the close, so it is
 *    claimed neither way.
 *  - **Privacy** keeps the shape and drops every $ figure and everything across the contracts held:
 *    the burndown says points per contract instead (#395). The IV chart is in % and SPX's path in
 *    index points, which privacy keeps.
 *
 *  All three are drawn on visx at their measured width — the burndown (`BurndownChart.tsx`, #360),
 *  the IV chart here and SPX's path (`SpxPath.tsx`, #395) — and share ONE crosshair
 *  (`Crosshair.tsx`): hovering, tapping or stepping a day in any of them puts it on that day in all
 *  three, each saying the day in its own readout. What keeps a day at one x down all three is the
 *  margins they share (`Gutters`) and the one mapping they all use (`dayScale`), DTE from `span` at
 *  the left margin to 0 at the right.
 */
import { tick } from "./shared/numbers";
import { useEffect, useRef, useState } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";

import { fetchSamples, fetchWatchSamples, type Entry, type Holding, type Samples } from "./shared/api";
import { heldLeg, legText } from "./shared/format";
import { Leg, SvgLeg } from "./shared/Legs";
import { hasCost, scopeWords, textWidth, valueAxis, type Unit } from "./burndown";
import { Burndown, runsOf, useWidth } from "./BurndownChart";
import { CrossTip, dayScale, liveOf, pointedStop, stepped, usePanel, type Cross, type Gutters, type Panel } from "./Crosshair";
import { ivLines, ivWords, MARK, nowDte, stopsOf, type IvLeg } from "./historyDays";
import { legCode } from "./legs";
import { SpxPath, spxGutter } from "./SpxPath";
import {
  BEFORE_ENTRY_WORDS, beforeEntryDays, entryCloseDay, thresholdOf, watchedCharted, watchedSamples, withBeforeEntry,
} from "./watchhistory";
import "./history.css";
import { plainError } from "./shared/errors";

interface Answer<T> {
  id: string;
  samples?: T;
  error?: string;
}

/** An answer for `id`, asked for once per id: a new Holding object for the same id (a poll, a
 *  refresh) asks nothing. What is kept is the last ANSWER, under the id it answered: it is shown
 *  only while that is still the id asked about, so another holding's days are never drawn under
 *  this one while its own are asked for, and an answer for a holding no longer shown lands
 *  nowhere. A 200 that carries no days — null, a string, an object without its list — is said as
 *  a failure: kept as an answer, it left the charts on "reading the samples…" for ever (#353). */
function useAnswer<T>(id: string, fetch: (id: string) => Promise<T>): Answer<T> | null {
  const [state, setState] = useState<Answer<T> | null>(null);
  useEffect(() => {
    let live = true;
    fetch(id).then(
      (samples: unknown) => {
        if (!live) return;
        setState(isSamples(samples) ? { id, samples: samples as T }
          : { id, error: "the service answered without them" });
      },
      (err: unknown) => { if (live) setState({ id, error: plainError(err, "open it again to retry") }); },
    );
    return () => { live = false; };
    // the fetch is a module function, the same on every render: the id is what is asked about
  }, [id, fetch]);
  return state?.id === id ? state : null;
}

/** Whether an answer is the samples at all: an object carrying its list of days. */
function isSamples(body: unknown): boolean {
  return typeof body === "object" && body !== null && Array.isArray((body as { samples?: unknown }).samples);
}

/** What the charts draw a holding from: its legs and its count, and — only while it is held and
 *  valued — today's figures. A closed holding (#296) is drawn from `GET /positions`, which carries
 *  none of them: no contract size, so its money is points per contract, and no "now". A watched row
 *  (#402) is drawn as a holding of one, with no valuation (`watchedCharted`). */
export type Charted = Pick<Holding, "id" | "contracts" | "legs" | "strike_date" | "closed_on">
  & Partial<Pick<Holding, "contract_size" | "cost_to_close" | "dte" | "spx" | "short_strikes" | "valued_from">>;

/** The crosshair the three panels share (#395): the stop pointed at, kept under the holding it was
 *  pointed at in, so another holding drawn in the same place starts with none; and a tap outside
 *  every panel lets go of it. */
function useCross(id: string, served: Samples | undefined, holding: Charted): Cross {
  const [at, setAt] = useState<{ id: string; i: number } | null>(null);
  const [driver, drive] = useState<Panel>("burndown");
  const plots = useRef(new Set<HTMLElement>());
  const stops = stopsOf(served?.samples ?? [], nowDte(holding));
  const pointed = at !== null && at.id === id && at.i < stops.length ? at.i : null;
  useEffect(() => {
    if (pointed === null) return;
    const away = (e: PointerEvent) => {
      const inside = e.target instanceof Node && [...plots.current].some((p) => p.contains(e.target as Node));
      if (!inside) setAt(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [pointed]);
  return {
    stops, pointed, plots, driver, drive,
    point: (i, by) => { drive(by); setAt(i === null ? null : { id, i }); },
  };
}

export function HoldingHistory({ holding, privacy }: { holding: Charted; privacy: boolean }) {
  const state = useAnswer(holding.id, fetchSamples);
  const size = holding.contract_size ?? null;
  const unit: Unit = {
    size: size ?? 1, contracts: holding.contracts, money: size !== null, hidden: privacy,
  };
  // the days its contracts were watched before it was entered, drawn first and faint (#402)
  const served = state?.samples ? withBeforeEntry(state.samples) : undefined;
  const blank = state?.error !== undefined ? `the samples could not be read — ${state.error}`
    : !served ? "reading the samples…"
      : served.samples.length === 0 ? (holding.closed_on === null
        ? "no daily samples recorded yet: the sweep writes one a day while it is held"
        // nothing more is coming: it closed before its first sample, or the close was backdated
        // before every one of them, which the service hides (ADR 0022)
        : "no daily samples for this trade: it closed before its first sample, or its close was backdated before all of them")
        : null;
  return (
    <HistoryPanels id={holding.id} holding={holding} served={served} blank={blank} unit={unit} privacy={privacy}
                   title="Burndown" noCost="no day with a Cost to close yet: each was recorded out of hours, with no two-sided quote to price it" />
  );
}

/** A watched row's history (#402): its value each day against its price rule's threshold, its legs'
 *  IV and SPX against its strikes — the holding's three panels and their crosshair, from the watch
 *  history of the contracts it watches (`/monitors/{id}/samples`). In points per contract: a watched
 *  row has no count and no money of its own. */
export function WatchedHistory({ entry, privacy }: { entry: Entry; privacy: boolean }) {
  const state = useAnswer(entry.id, fetchWatchSamples);
  const holding = watchedCharted(entry);
  const unit: Unit = { size: 1, contracts: 1, money: false, hidden: privacy, what: "value" };
  const served = state?.samples ? watchedSamples(state.samples) : undefined;
  const threshold = state?.samples ? thresholdOf(state.samples) : null;
  const blank = state?.error !== undefined ? `the closes could not be read — ${state.error}`
    : !served ? "reading the closes…"
      : served.samples.length === 0
        ? "no daily closes recorded yet: the sweep writes one a day while it is watched"
        : null;
  return (
    <HistoryPanels id={entry.id} holding={holding} served={served} blank={blank} unit={unit} privacy={privacy}
                   threshold={threshold}
                   title={threshold === null ? "Value" : "Value against the threshold"}
                   noCost="no day with a price yet: each was recorded out of hours, with no two-sided quote to price it" />
  );
}

/** The three panels of a history — the value by day, each leg's IV, SPX against the strikes — on
 *  one DTE axis with one crosshair, for a holding or a watched row. */
function HistoryPanels({ id, holding, served, blank, unit, privacy, title, noCost, threshold = null }: {
  id: string; holding: Charted; served: Samples | undefined; blank: string | null; unit: Unit; privacy: boolean;
  title: string; noCost: string; threshold?: number | null;
}) {
  const cross = useCross(id, served, holding);
  const before = served ? beforeEntryDays(served) : new Set<string>();
  // one pair of margins for all three charts, so a DTE is at the same x in each (#298)
  const axis = blank !== null || !served ? null : valueAxis(served, holding, unit, threshold === null ? [] : [threshold]);
  const gutters: Gutters | null = axis === null || !served ? null : (() => {
    const iv = ivAxis(served, holding);
    return {
      L: Math.max(axis.L, iv?.L ?? 0, spxGutter(holding)),
      R: Math.max(R, iv?.RL ?? 0),
    };
  })();
  // a closed holding's last day: the service serves no sample after it (ADR 0022), and this says where
  const closeDte = holding.closed_on === null ? null : daysTo(holding.closed_on, holding.strike_date);
  return (
    <>
      <section className="nx-hist" role="group" aria-label={title === "Burndown" ? "burndown" : title.toLowerCase()}>
        <h4 className="nx-hist-h">
          {title}
          <span className="nx-hist-unit">{`${unit.money && !privacy ? "$" : "points"} ${unit.what ?? "to close"}, ${scopeWords(unit)}`}</span>
        </h4>
        {blank !== null || !served ? <p className="nx-meta">{blank}</p>
          : (
            <>
              <Burndown served={served} unit={unit} axis={axis!} span={dteWindow(served)} gutters={gutters!}
                        closeDte={closeDte} cross={cross} before={before} threshold={threshold}
                        entryDay={entryCloseDay(served)} />
              {served.samples.some(hasCost) ? null
                // every day kept only for its vol (#380): the IV chart below has them, the burndown none
                : <p className="nx-meta">{noCost}</p>}
              {served.levels === null && title === "Burndown"
                ? <p className="nx-meta">no plan: Opened not recorded, so there is no schedule to draw</p> : null}
            </>
          )}
      </section>
      {blank === null && served ? (
        <section className="nx-hist" role="group" aria-label="IV by leg">
          <h4 className="nx-hist-h">IV by leg</h4>
          <IvChart served={served} holding={holding} gutters={gutters!} cross={cross} before={before} />
        </section>
      ) : null}
      {/* where SPX was against the strikes (#298), from the same answer — nothing more is asked —
          and on the burndown's DTE window, so the days line up */}
      {blank === null && served ? <SpxPath served={served} holding={holding} span={dteWindow(served)} gutters={gutters!}
                                                    cross={cross} before={before} /> : null}
    </>
  );
}

/** The DTE window both charts draw: from the open (or the first sample, if earlier) on the left to
 *  expiry on the right, as time runs. */
function dteWindow(served: Samples): number {
  return Math.max(1, served.levels?.dte_at_open ?? 0, ...served.samples.map((s) => s.dte));
}

/** The IV chart's top and bottom margins, and the right margin every chart has at least. */
const T = 10, B = 22, R = 10;

/** A market date in its dashed spelling: an expiry is stored either way, 2026-12-18 or 20261218,
 *  as `daysToExpiry` and `dteAtOpen` read it (`normalizeStrikeDate`). */
const dashed = (iso: string) => iso.replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3");

/** Calendar days from a market date to the expiry: the samples' own DTE (`dte` on each row). */
const daysTo = (on: string, expiry: string) =>
  Math.round((Date.parse(`${dashed(expiry)}T00:00:00Z`) - Date.parse(`${dashed(on)}T00:00:00Z`)) / 86_400_000);

const IV_H = 132;

/** Each leg's IV per day, a line per leg named by its side and strike. A day with no IV is a gap,
 *  never a line drawn across it. In %, which privacy keeps (ADR 0023). */
/** The IV chart's legs, value axis and the margins its labels need; null with no reading at all.
 *  Its ticks are the scale's nice ones, gridded as the burndown's are. */
function ivAxis(served: Samples, holding: Charted) {
  const legs = holding.legs.map((l) => ({
    code: legCode(holding.strike_date, l),
    leg: heldLeg(l),
    name: legText(heldLeg(l), "signs"),
    short: l.side === "short",
  }));
  const readings = served.samples.flatMap((s) => Object.values(s.legs_iv ?? {}));
  if (readings.length === 0) return null;
  const hi = Math.max(...readings), lo = Math.min(...readings);
  const pad = Math.max((hi - lo) * 0.12, 0.5);
  const scale = scaleLinear<number>({ domain: [lo - pad, hi + pad], nice: 3 });
  const [bottom, top] = scale.domain() as [number, number];
  const ticks = scale.ticks(3);
  // an axis tick, to the places it needs, as the burndown's are (`shared/numbers.ts`: `tick`); the
  // readouts say each IV to two places
  const label = (v: number) => `${tick(v)}%`;
  const L = Math.ceil(Math.max(...ticks.map((v) => textWidth(label(v))))) + 10;
  // the leg names sit at the right end of each line, so the plot stops short of them
  const RL = Math.ceil(Math.max(...legs.map((l) => textWidth(l.name)))) + 8;
  return { legs, top, bottom, ticks, label, L, RL };
}

function IvChart({ served, holding, gutters, cross, before }: {
  served: Samples; holding: Charted; gutters: Gutters; cross: Cross;
  /** the days, by market day, that are before entry (#402): drawn faint, a line of their own */
  before: ReadonlySet<string>;
}) {
  const [box, W] = useWidth();
  const span = dteWindow(served);
  const scale = ivAxis(served, holding);
  const x = dayScale(span, W, gutters);
  const { svg: hands, onKeyDown, onFocus } = usePanel(cross, "iv", box, cross.stops.map((s) => x(s.dte)), W);
  if (scale === null) return <p className="nx-meta">no IV recorded on any day</p>;
  const { legs, top, bottom, ticks, label } = scale;
  const { L, R } = gutters;
  const y = scaleLinear<number>({ domain: [bottom, top], range: [IV_H - B, T] });
  const ivLegs: IvLeg[] = legs.map(({ code, leg }) => ({ code, leg }));

  // each leg's runs of consecutive days with a reading: a day without one breaks the line, and a
  // leg never read is not drawn at all
  const lines = legs.flatMap((leg) => {
    const point = (s: Samples["samples"][number]) => {
      const v = s.legs_iv?.[leg.code];
      return typeof v === "number" ? { dte: s.dte, v, timing: s.timing, watched: before.has(s.observed_on) } : null;
    };
    const drawn = runsOf(served.samples.map(point));
    // the days watched before entry and the days held, each a line of their own (#402)
    const split = [false, true].flatMap((watched) => runsOf(served.samples.map((s) => {
      const p = point(s);
      return p !== null && p.watched === watched ? p : null;
    })));
    const last = drawn.at(-1)?.at(-1);
    return last ? [{ leg, drawn, split, last, labelY: y(last.v) }] : [];
  });
  // two legs ending at nearly the same IV would print their names over each other: each is pushed
  // down below the one above it, then the whole column back up if it ran off the bottom
  const byY = [...lines].sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < byY.length; i++) byY[i]!.labelY = Math.max(byY[i]!.labelY, byY[i - 1]!.labelY + 12);
  const over = (byY.at(-1)?.labelY ?? 0) - (IV_H - B);
  if (over > 0) for (const l of byY) l.labelY = Math.max(T, l.labelY - over);

  const pointed = pointedStop(cross);
  const read = pointed === null ? null : ivLines(pointed, ivLegs);
  // where the crosshair meets each leg read that day
  const met = pointed?.sample == null ? [] : legs.flatMap((leg) => {
    const v = pointed.sample!.legs_iv?.[leg.code];
    return typeof v === "number" ? [{ code: leg.code, y: y(v) }] : [];
  });
  const name = (leg: IvLeg["leg"]) => legText(leg, "signs");

  return (
    <>
      <div className="nx-hist-chart nx-cross nx-iv" ref={box} role="group" tabIndex={0} onKeyDown={onKeyDown}
           onFocus={onFocus}
           aria-label={`each leg's implied volatility by day, ${stepped(cross)}: arrow keys move from day to day`}>
        <svg width={W} height={IV_H} viewBox={`0 0 ${W} ${IV_H}`} aria-hidden="true" {...hands}>
          <rect data-plot="" x={L} y={T} width={Math.max(0, W - L - R)} height={IV_H - T - B} fill="none" />
          <g data-grid="">
            {ticks.map((v) => <line key={v} className="nx-bd-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />)}
          </g>
          <g data-axis="y">
            {ticks.map((v) => <text key={v} x={L - 6} y={y(v) + 4} textAnchor="end">{label(v)}</text>)}
          </g>
          {lines.map(({ leg, drawn, split, labelY, last }) => (
            <g key={leg.code} data-leg={leg.code} className="nx-hist-leg" data-side={leg.short ? "short" : "long"}>
              {split.map((run) => (
                <LinePath key={run[0]!.dte} data-iv-run={run[0]!.watched ? "before-entry" : ""} data={run}
                          x={(p) => x(p.dte)} y={(p) => y(p.v)} />
              ))}
              {drawn.flat().map((p) => (
                <circle key={p.dte} data-dte={p.dte} data-mark={MARK[p.timing]}
                        data-before-entry={p.watched ? "" : undefined} cx={x(p.dte)} cy={y(p.v)} r={2.25} />
              ))}
              <SvgLeg leg={leg.leg} form="signs" x={x(last.dte) + 6} y={labelY + 4} />
            </g>
          ))}
          {pointed === null ? null : (
            <g data-crosshair={pointed.on ?? "now"} className="nx-bd-cross" pointerEvents="none">
              <line x1={x(pointed.dte)} x2={x(pointed.dte)} y1={T} y2={IV_H - B} />
              {met.map((m) => (
                <circle key={m.code} className="nx-bd-cross-day" data-mark={MARK[pointed.sample!.timing]}
                        cx={x(pointed.dte)} cy={m.y} r={3.5} />
              ))}
            </g>
          )}
          <text x={L} y={IV_H - 6} textAnchor="start">{`${span} DTE`}</text>
          <text x={W - 4} y={IV_H - 6} textAnchor="end">expiry</text>
        </svg>
        {read === null || pointed === null ? null : (
          <CrossTip x={x(pointed.dte)} ys={met.length ? met.map((m) => m.y) : [(T + IV_H - B) / 2]}
                    W={W} H={IV_H}>
            <div className="nx-bd-tip-h">{read.day}</div>
            {read.none !== null ? <div>{read.none}</div> : read.legs.map((l, i) => (
              <div key={i} data-iv-leg=""><Leg leg={l.leg} form="signs" />{` ${l.words}`}</div>
            ))}
            {read.why === null ? null : <div className="nx-bd-tip-why">{read.why}</div>}
            {pointed.on !== null && before.has(pointed.on)
              ? <div className="nx-bd-tip-why" data-before-entry="">{BEFORE_ENTRY_WORDS}</div> : null}
          </CrossTip>
        )}
      </div>
      <p className="nx-hist-said" role="status" aria-live={liveOf(cross, "iv")}>
        {pointed === null ? "each leg's IV by day · point at a day for each leg's figure"
          : ivWords(pointed, ivLegs, name) + (pointed.on !== null && before.has(pointed.on) ? ` — ${BEFORE_ENTRY_WORDS}` : "")}
      </p>
    </>
  );
}
