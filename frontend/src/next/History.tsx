/** A holding's recorded history, drawn (#295, ADR 0023): the burndown and the IV chart, in the desk's
 *  inspector in REVIEW and as the main chart of the phone's one-holding REVIEW page — and in LIVE,
 *  on demand, behind `HistoryOnDemand` (#353).
 *
 *  Everything drawn is the service's (`/positions/{id}/samples`): each day's Cost to close, the
 *  planned decay at every DTE from the open (`onPace`, ADR 0011), the Target, the Stop and
 *  Manage-by, each leg's IV, and whether each day's row is the close. This joins served points and
 *  computes no curve: the plan is a polyline through the served DTEs, so the √ shape is the
 *  service's and not a guess redrawn here.
 *
 *  - **Read once, when opened.** The samples are asked for when a holding is shown in REVIEW (or
 *    its history opened in LIVE), by its id, and never again while it stays shown: a row changes
 *    at most once a market day, and no poll reads it, in either mode (ADR 0023). A new valuation of
 *    the same holding asks nothing more.
 *  - **A point that is not a close is drawn hollow**, and says why when pointed at — hovered on the
 *    desk, tapped or scrubbed on the phone, or stepped to with the keys — in the crosshair's
 *    tooltip and in the status line beneath the chart (`BurndownChart.tsx`, #360). A row written before
 *    observation times were kept is drawn faint: nothing says whether it was the close, so it is
 *    claimed neither way.
 *  - **Privacy** keeps the shape and drops every $ figure: the value axis and the Levels' figures
 *    go, the lines stay. The IV chart is in %, which privacy keeps.
 *
 *  The burndown is drawn on visx (`BurndownChart.tsx`, #360). The IV chart here and SPX's path
 *  (`SpxPath.tsx`) stay hand-written SVG at their measured width, as `Payoff.tsx` is: they have no
 *  crosshair to want visx for, and what keeps a day at one x down all three is not the library but
 *  the margins they share (`Gutters`) and the one mapping they all use, DTE from `span` at the left
 *  margin to 0 at the right.
 */
import { useEffect, useState } from "react";

import { fetchSamples, type Holding, type Samples } from "../shared/api";
import { scopeWords, textWidth, valueAxis, type Unit } from "./burndown";
import { Burndown, runsOf, useWidth } from "./BurndownChart";
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
 *  nowhere. A 200 that carries no days — null, a string, an object without its list — is said as
 *  a failure: kept as an answer, it left the charts on "reading the samples…" for ever (#353). */
function useSamples(id: string): SamplesState | null {
  const [state, setState] = useState<SamplesState | null>(null);
  useEffect(() => {
    let live = true;
    fetchSamples(id).then(
      (samples: unknown) => {
        if (!live) return;
        setState(isSamples(samples) ? { id, samples }
          : { id, error: "the service answered without them" });
      },
      (err: unknown) => { if (live) setState({ id, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [id]);
  return state?.id === id ? state : null;
}

/** Whether an answer is the samples at all: an object carrying its list of days. */
function isSamples(body: unknown): body is Samples {
  return typeof body === "object" && body !== null && Array.isArray((body as { samples?: unknown }).samples);
}

/** What the charts draw a holding from: its legs and its count, and — only while it is held and
 *  valued — today's figures. A closed holding (#296) is drawn from `GET /positions`, which carries
 *  none of them: no contract size, so its money is points per contract, and no "now". */
export type Charted = Pick<Holding, "id" | "contracts" | "legs" | "strike_date" | "closed_on">
  & Partial<Pick<Holding, "contract_size" | "cost_to_close" | "dte" | "spx">>;

export function HoldingHistory({ holding, privacy }: { holding: Charted; privacy: boolean }) {
  const state = useSamples(holding.id);
  const size = holding.contract_size ?? null;
  const unit: Unit = {
    size: size ?? 1, contracts: holding.contracts, money: size !== null, hidden: privacy,
  };
  const served = state?.samples;
  const blank = state?.error !== undefined ? `the samples could not be read — ${state.error}`
    : !served ? "reading the samples…"
      : served.samples.length === 0 ? (holding.closed_on === null
        ? "no daily samples recorded yet: the sweep writes one a day while it is held"
        // nothing more is coming: it closed before its first sample, or the close was backdated
        // before every one of them, which the service hides (ADR 0022)
        : "no daily samples for this trade: it closed before its first sample, or its close was backdated before all of them")
        : null;
  // one pair of margins for all three charts, so a DTE is at the same x in each (#298)
  const axis = blank !== null || !served ? null : valueAxis(served, holding, unit);
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
      <section className="nx-hist" role="group" aria-label="burndown">
        <h4 className="nx-hist-h">
          Burndown
          {scopeWords(unit) === null ? null
            : <span className="nx-hist-unit">{`${unit.money ? "$" : "points"} to close, ${scopeWords(unit)}`}</span>}
        </h4>
        {blank !== null || !served ? <p className="nx-meta">{blank}</p>
          : (
            <>
              <Burndown served={served} unit={unit} axis={axis!} span={dteWindow(served)} gutters={gutters!}
                        closeDte={closeDte} />
              {served.levels === null
                ? <p className="nx-meta">no plan: Opened not recorded, so there is no schedule to draw</p> : null}
            </>
          )}
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

/** The DTE window both charts draw: from the open (or the first sample, if earlier) on the left to
 *  expiry on the right, as time runs. */
function dteWindow(served: Samples): number {
  return Math.max(1, served.levels?.dte_at_open ?? 0, ...served.samples.map((s) => s.dte));
}

/** The IV chart's top and bottom margins, and the right margin every chart has at least. */
const T = 10, B = 22, R = 10;

/** The plot's margins, the SAME for every chart of one holding (#298): the burndown, the IV chart
 *  and where SPX was all put a DTE at the same x, so a day reads straight down the three. Each is
 *  as wide as the widest chart needs. */
export interface Gutters {
  L: number;
  R: number;
}

/** A market date in its dashed spelling: an expiry is stored either way, 2026-12-18 or 20261218,
 *  as `daysToExpiry` and `dteAtOpen` read it (`normalizeStrikeDate`). */
const dashed = (iso: string) => iso.replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3");

/** Calendar days from a market date to the expiry: the samples' own DTE (`dte` on each row). */
const daysTo = (on: string, expiry: string) =>
  Math.round((Date.parse(`${dashed(expiry)}T00:00:00Z`) - Date.parse(`${dashed(on)}T00:00:00Z`)) / 86_400_000);

const IV_H = 132;

/** Each leg's IV per day, a line per leg named by its side and strike. A day with no IV is a gap,
 *  never a line drawn across it. In %, which privacy keeps (ADR 0023). */
/** The IV chart's legs, value axis and the margins its labels need; null with no reading at all. */
function ivAxis(served: Samples, holding: Charted) {
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

function IvChart({ served, holding, gutters }: { served: Samples; holding: Charted; gutters: Gutters }) {
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
