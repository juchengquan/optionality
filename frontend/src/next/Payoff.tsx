/** The payoff at expiry, drawn (#291, ADR 0023): a held spread's at its Entry, and a watched
 *  spread's at its current value, in the desk's inspector and the phone's detail sheet.
 *
 *  AT EXPIRY ONLY. No T+0 curve, no "today" line and no probability: the service has no pricing
 *  model, and ADR 0023 says never to draw what the system does not know. So SPX's marker is a
 *  vertical line and NOT a dot on the curve — a dot would read as "what it is worth now", which an
 *  expiry curve does not say.
 *
 *  The figures are the service's (`payoffAtExpiry`, served by `/positions/{id}/payoff` and
 *  `POST /positions/payoff`); this only joins its corners. The curve bends only at the strikes, so
 *  the P&L at each strike and the slope beyond the outer two are all of it, and a straight line
 *  between them is the curve rather than an approximation of it.
 *
 *  Hand-written SVG rather than visx: the whole drawing is a polyline through at most six corners,
 *  two shaded areas, a few rules and labels, and one linear scale per axis. visx would add 15–30 KB
 *  of scales and shapes to the bundle for arithmetic that is one line each here, and a dependency
 *  for both arrangements to agree on; the prototype's three charts were hand-written for the same
 *  reason. Its width is MEASURED rather than scaled from a viewBox, so text stays its own size in a
 *  272px inspector and on a 390px phone alike.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { fetchDraftPayoff, fetchPayoff, type DraftPayoff, type Entry, type Holding, type Payoff } from "../api";
import "./payoff.css";

/** How a P&L is said: money for a holding whose contract size the valuation served, points
 *  otherwise; and nothing at all a stranger could read when privacy is on. */
interface Unit {
  /** points to the figure shown: the contract size, or 1 for points */
  size: number;
  money: boolean;
  hidden: boolean;
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero",
});

function say(points: number, unit: Unit): string {
  if (unit.hidden) return "$•••";
  if (unit.money) return MONEY.format(points * unit.size);
  return `${points > 0 ? "+" : ""}${points.toFixed(2)} pts`;
}

/** An SPX level: whole where it is whole, else to the cent. */
const level = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

/** The served payoff for `key`, asked for again only when the key changes: none of it moves with
 *  the market, so it is never polled. A null key asks for nothing. */
function usePayoff(key: string | null, load: () => Promise<Payoff>) {
  const [state, setState] = useState<{ key: string; payoff?: Payoff; error?: string } | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState({ key });
    loader.current().then(
      (payoff) => { if (live) setState({ key, payoff }); },
      (err: unknown) => { if (live) setState({ key, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [key]);
  return state?.key === key ? state : null;
}

/** A holding's payoff, at the Entry it was taken for, over the contracts held. */
export function HoldingPayoff({ holding, privacy }: { holding: Holding; privacy: boolean }) {
  const { id, entry, contracts } = holding;
  const state = usePayoff(entry === null ? null : `${id}|${entry}|${contracts}`, () => fetchPayoff(id));
  const unit: Unit = {
    size: holding.contract_size ?? 1, money: holding.contract_size !== null, hidden: privacy,
  };
  return (
    <PayoffFigure state={state} unit={unit} spx={holding.spx} spxReason={holding.spx_reason}
                  blank={entry === null ? "no Entry recorded, so there is no credit to draw it at" : null} />
  );
}

/** A watched spread's payoff. It has no Entry, so it is drawn at its CURRENT value as the credit,
 *  and says so. Minus is short (ADR 0013) and a combo's value is the signed sum under its signs, so
 *  what it would be sold for now is the negative of its value. One spread, in points: nobody holds
 *  it, so there is no count and no size to make money of. */
export function WatchedPayoff({ entry }: { entry: Entry }) {
  const value = entry.combo_value ?? null;
  const draft: DraftPayoff | null = value === null || !entry.legs ? null : {
    legs: entry.legs.map((l) => ({
      side: l.sign < 0 ? "short" : "long", option_type: l.option_type as "CALL" | "PUT", strike: l.strike,
    })),
    // to the cent, so a value that moved by float noise alone is not asked for again
    entry: Number((-value).toFixed(2)) || 0,
    contracts: 1,
  };
  const key = draft === null ? null : JSON.stringify(draft);
  const state = usePayoff(key, () => fetchDraftPayoff(draft!));
  const credit = draft?.entry ?? 0;
  return (
    <PayoffFigure state={state} unit={{ size: 1, money: false, hidden: false }}
                  spx={entry.spx} spxReason={entry.spx_reason}
                  blank={draft === null ? "no current value to draw it at" : null}
                  note={`no Entry: drawn at its current value, ${Math.abs(credit).toFixed(2)}, as the ${credit < 0 ? "debit" : "credit"}`} />
  );
}

function PayoffFigure({ state, unit, spx, spxReason, blank, note }: {
  state: ReturnType<typeof usePayoff>; unit: Unit; spx: number | null; spxReason: string | null;
  /** why nothing is drawn, when nothing can be */
  blank: string | null;
  note?: string;
}) {
  const body = blank !== null ? <p className="nx-meta">{blank}</p>
    : state?.error !== undefined ? <p className="nx-meta">{`the payoff could not be drawn — ${state.error}`}</p>
      : !state?.payoff ? <p className="nx-meta">drawing…</p>
        : (
          <>
            {note ? <p className="nx-meta nx-payoff-note">{note}</p> : null}
            <Chart payoff={state.payoff} unit={unit} spx={spx} />
            {spx === null ? <p className="nx-meta nx-payoff-spx">{`SPX — ${spxReason ?? "no price"}`}</p> : null}
            <dl className="nx-payoff-kv">
              <div><dt>max profit</dt><dd>{state.payoff.max_profit === null ? "no ceiling" : say(state.payoff.max_profit, unit)}</dd></div>
              <div><dt>max loss</dt><dd>{state.payoff.max_loss === null ? "no floor" : say(state.payoff.max_loss, unit)}</dd></div>
              <div><dt>breakevens</dt><dd>{state.payoff.breakevens.length === 0 ? "none" : state.payoff.breakevens.map(level).join(" · ")}</dd></div>
            </dl>
          </>
        );
  return (
    <section className="nx-payoff" role="group" aria-label="payoff at expiry">
      <h4 className="nx-payoff-h">Payoff at expiry</h4>
      {body}
    </section>
  );
}

/** The P&L at expiry with SPX at `s`, joining the served corners: straight between strikes, and
 *  on at the served slope beyond the outer two. */
export function pnlAt(p: Payoff, s: number): number {
  const at = p.at_strikes;
  if (at.length === 0) return p.max_profit ?? 0;
  const first = at[0]!, last = at[at.length - 1]!;
  if (s <= first.spx) return first.pnl + p.slope_below * (s - first.spx);
  if (s >= last.spx) return last.pnl + p.slope_above * (s - last.spx);
  const i = at.findIndex((a) => a.spx >= s);
  const [a, b] = [at[i - 1]!, at[i]!];
  return a.pnl + ((b.pnl - a.pnl) * (s - a.spx)) / (b.spx - a.spx);
}

const H = 168, R = 10, T = 18, B = 20;
/** A label's width at the chart's 11px tabular figures, near enough to leave it room. */
const textWidth = (text: string) => text.length * 6.6;

function Chart({ payoff, unit, spx }: { payoff: Payoff; unit: Unit; spx: number | null }) {
  // drawn at its measured width, so its text is the size it says wherever it sits
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setW(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clip = useId().replace(/[^\w-]/g, "");

  // the window: every strike, every breakeven and SPX, with room either side to show the slopes
  const strikes = payoff.at_strikes.map((a) => a.spx);
  const xs = [...strikes, ...payoff.breakevens, ...(spx === null ? [] : [spx])];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.15, 10);
  const [d0, d1] = [lo - pad, hi + pad];
  const corners = [d0, ...strikes.filter((k) => k > d0 && k < d1), d1].map((s) => [s, pnlAt(payoff, s)] as const);
  const ys = corners.map(([, v]) => v);
  const top = Math.max(...ys, 0), bottom = Math.min(...ys, 0);
  const span = top - bottom || 1;
  const [topLabel, bottomLabel] = [say(top, unit), say(bottom, unit)];
  // the axis's gutter is as wide as its widest label, which is a money figure or a points one
  const L = Math.ceil(Math.max(textWidth(topLabel), textWidth(bottomLabel), 24)) + 10;
  const x = (s: number) => L + ((s - d0) / (d1 - d0)) * (W - L - R);
  const y = (v: number) => T + ((top + span * 0.08 - v) / (span * 1.16)) * (H - T - B);

  const curve = corners.map(([s, v], i) => `${i ? "L" : "M"}${x(s).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${curve}L${x(d1).toFixed(1)},${y(0).toFixed(1)}L${x(d0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const spxX = spx === null ? null : x(spx);

  return (
    <div className="nx-payoff-chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label={`payoff at expiry, SPX ${level(Math.round(d0))} to ${level(Math.round(d1))}`}>
        <defs>
          <clipPath id={`${clip}-up`}><rect x={0} y={0} width={W} height={y(0)} /></clipPath>
          <clipPath id={`${clip}-down`}><rect x={0} y={y(0)} width={W} height={H} /></clipPath>
        </defs>
        <path d={area} className="nx-payoff-gain" clipPath={`url(#${clip}-up)`} />
        <path d={area} className="nx-payoff-loss" clipPath={`url(#${clip}-down)`} />
        <line className="nx-payoff-zero" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
        {strikes.map((k) => (
          <line key={k} className="nx-payoff-strike" x1={x(k)} x2={x(k)} y1={T} y2={H - B} />
        ))}
        <path d={curve} className="nx-payoff-curve" data-curve="" />
        {payoff.breakevens.map((b) => (
          <g key={b} data-breakeven={b}>
            <circle cx={x(b)} cy={y(0)} r={2.75} className="nx-payoff-be" />
            <text x={Math.min(Math.max(x(b), L + 16), W - R - 16)} y={H - 6} textAnchor="middle">
              {level(Math.round(b))}
            </text>
          </g>
        ))}
        {spxX === null ? null : (
          <g data-marker="spx" className="nx-payoff-marker">
            <line x1={spxX} x2={spxX} y1={T - 4} y2={H - B} />
            <text x={spxX > W * 0.6 ? spxX - 4 : spxX + 4} y={T - 6}
                  textAnchor={spxX > W * 0.6 ? "end" : "start"}>{`SPX ${spx!.toFixed(2)}`}</text>
          </g>
        )}
        <text x={L - 6} y={y(top) + 4} textAnchor="end">{topLabel}</text>
        <text x={L - 6} y={y(bottom) + 4} textAnchor="end">{bottomLabel}</text>
      </svg>
    </div>
  );
}
