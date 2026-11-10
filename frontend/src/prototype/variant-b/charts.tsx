/** PROTOTYPE — throwaway. Variant B's hand-written SVG: the strike strip, the payoff at expiry,
 *  the burndown, the IV small multiple and the progress ring. Sized by measuring their box. */
import { useLayoutEffect, useRef, useState } from "react";

import type { AlertState, Prefs, Sample, Side } from "../data";
import { breakeven, day, dteBetween, MULT, payoffAt, plannedOn, price, sigma, strike } from "./util";

export function useWidth<T extends HTMLElement>(fallback = 320, min = 160): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}

// ---------------------------------------------------------------------------------------------
// strike strip: spot as a dot on a strike axis, three shades of one hue, short Δ on its strike

export interface StripSpread { side: Side; short: number; long: number | null; shortDelta: number | null; hot?: boolean }

export function StrikeStrip({ spreads, spot, ivPct, dte, upToday }: {
  spreads: StripSpread[]; spot: number; ivPct: number | null; dte: number; upToday: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = 78, axisY = 40, padX = 14;
  const strikes = spreads.flatMap((s) => (s.long === null ? [s.short] : [s.short, s.long]));
  const sd = ivPct ? sigma(spot, ivPct, dte) : 0;
  let lo = Math.min(...strikes, spot - sd), hi = Math.max(...strikes, spot + sd);
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const x = (v: number) => padX + ((v - lo) / (hi - lo)) * (w - 2 * padX);

  const puts = spreads.filter((s) => s.side === "put");
  const calls = spreads.filter((s) => s.side === "call");
  // the profit zone runs between the innermost shorts; a lone spread's runs to the far edge
  const zoneFrom = puts.length ? Math.max(...puts.map((s) => s.short)) : lo;
  const zoneTo = calls.length ? Math.min(...calls.map((s) => s.short)) : hi;

  return (
    <div ref={ref} className="vb-strip" aria-label="strike strip">
      <svg width={w} height={H} role="img">
        {/* beyond the wings: max loss, darkest */}
        <rect x={padX} y={axisY - 7} width={w - 2 * padX} height={14} rx={7} className="vb-z3" />
        {/* the wings themselves */}
        {spreads.filter((s) => s.long !== null).map((s, i) => {
          const a = x(Math.min(s.short, s.long!)), b = x(Math.max(s.short, s.long!));
          return <rect key={i} x={a} y={axisY - 7} width={Math.max(2, b - a)} height={14} className={s.hot ? "vb-zhot" : "vb-z2"} />;
        })}
        {/* the profit zone between the shorts */}
        <rect x={x(zoneFrom)} y={axisY - 7} width={Math.max(2, x(zoneTo) - x(zoneFrom))} height={14} rx={zoneFrom === lo || zoneTo === hi ? 7 : 0} className="vb-z1" />
        {/* ±1σ to expiry, from the short leg's own IV */}
        {sd > 0 && (
          <g className="vb-sigma">
            <line x1={x(spot - sd)} x2={x(spot + sd)} y1={axisY + 15} y2={axisY + 15} />
            <line x1={x(spot - sd)} x2={x(spot - sd)} y1={axisY + 12} y2={axisY + 18} />
            <line x1={x(spot + sd)} x2={x(spot + sd)} y1={axisY + 12} y2={axisY + 18} />
            <text x={x(spot + sd) + 4} y={axisY + 19}>1σ</text>
          </g>
        )}
        {spreads.map((s, i) => (
          <g key={i}>
            <line x1={x(s.short)} x2={x(s.short)} y1={axisY - 11} y2={axisY + 9} className="vb-short" />
            <text x={x(s.short)} y={axisY - 15} textAnchor="middle" className={`vb-strike ${s.hot ? "vb-hot-t" : ""}`}>
              {strike(s.short)}{s.shortDelta !== null ? ` · Δ${s.shortDelta.toFixed(2)}` : ""}
            </text>
            {s.long !== null && (
              <text x={x(s.long)} y={axisY + 34} textAnchor="middle" className="vb-strike-l">{strike(s.long)}</text>
            )}
          </g>
        ))}
        <circle cx={x(spot)} cy={axisY} r={6.5} className={upToday ? "vb-spot-up" : "vb-spot-down"} />
        <circle cx={x(spot)} cy={axisY} r={2.2} className="vb-spot-core" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// payoff at expiry — and nothing else: no T+0 curve until the service has a pricing model

export interface PayoffSpread { side: Side; short: number; long: number; entry: number; contracts: number; value?: number | null }

export function Payoff({ spreads, spot, prefs, height = 170 }: {
  spreads: PayoffSpread[]; spot: number; prefs: Prefs; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = height, top = 38, bottom = 26, left = 8, right = 8;
  const strikes = spreads.flatMap((s) => [s.short, s.long]);
  const span = Math.max(...strikes, spot) - Math.min(...strikes, spot);
  const lo = Math.min(...strikes, spot) - span * 0.18, hi = Math.max(...strikes, spot) + span * 0.18;
  // privacy keeps the shape and drops the dollars: points × contracts instead
  const unit = prefs.privacy ? 1 : MULT;
  const pnl = (S: number) => spreads.reduce((t, s) => t + payoffAt(S, s.side, s.short, s.long, s.entry) * s.contracts * unit, 0);
  const N = 160;
  const pts = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N).map((S) => [S, pnl(S)] as const);
  const ys = pts.map((p) => p[1]);
  const yMax = Math.max(...ys, 0), yMin = Math.min(...ys, 0);
  const x = (v: number) => left + ((v - lo) / (hi - lo)) * (w - left - right);
  const y = (v: number) => top + ((yMax - v) / (yMax - yMin || 1)) * (H - top - bottom);
  const line = pts.map(([S, v], i) => `${i ? "L" : "M"}${x(S).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(hi)},${y(0)}L${x(lo)},${y(0)}Z`;
  const nowPnl = spreads.every((s) => s.value !== null && s.value !== undefined)
    ? spreads.reduce((t, s) => t + (s.entry - (s.value ?? 0)) * s.contracts * unit, 0) : null;
  const bes = spreads.map((s) => breakeven(s.side, s.short, s.entry));
  const fmt = (v: number) => (prefs.privacy ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} pt` : `${v >= 0 ? "+" : "−"}$${Math.abs(Math.round(v)).toLocaleString()}`);
  const id = `pc${Math.round(lo)}${spreads.length}`;

  return (
    <div ref={ref} className="vb-payoff">
      <svg width={w} height={H} role="img" aria-label="payoff at expiry">
        <defs>
          <clipPath id={`${id}-up`}><rect x={0} y={0} width={w} height={y(0)} /></clipPath>
          <clipPath id={`${id}-dn`}><rect x={0} y={y(0)} width={w} height={H} /></clipPath>
        </defs>
        <path d={area} className="vb-pay-gain" clipPath={`url(#${id}-up)`} />
        <path d={area} className="vb-pay-loss" clipPath={`url(#${id}-dn)`} />
        <line x1={left} x2={w - right} y1={y(0)} y2={y(0)} className="vb-zero" />
        <path d={line} className="vb-pay-line" />
        {bes.map((b, i) => (
          <g key={`be${i}`}>
            <line x1={x(b)} x2={x(b)} y1={top} y2={H - bottom} className="vb-be" />
            <text x={x(b)} y={H - 8} textAnchor="middle" className="vb-axis-t">BE {strike(b)}</text>
          </g>
        ))}
        <line x1={x(spot)} x2={x(spot)} y1={17} y2={H - bottom} className="vb-spotline" />
        <text x={x(spot)} y={12} textAnchor={x(spot) > w * 0.6 ? "end" : x(spot) < w * 0.25 ? "start" : "middle"} className="vb-axis-t vb-spot-t">SPX {price(spot)}</text>
        {(() => {
          // the plateau of maximum profit: label it at its middle, or across from the spot line
          const plateau = pts.filter(([, v]) => v >= yMax - 1e-9).map(([S]) => x(S));
          let mx = plateau.length ? (plateau[0]! + plateau.at(-1)!) / 2 : w / 2;
          if (Math.abs(mx - x(spot)) < 70) mx = x(spot) > w / 2 ? Math.max(left + 50, x(spot) - 90) : Math.min(w - 50, x(spot) + 90);
          return <text x={mx} y={y(yMax) - 5} textAnchor="middle" className="vb-axis-t">max {fmt(yMax)}</text>;
        })()}
        {nowPnl !== null && (
          <g>
            <circle cx={x(spot)} cy={y(nowPnl)} r={5} className="vb-now" />
            <text x={x(spot) + (x(spot) > w * 0.6 ? -8 : 8)} y={y(nowPnl) + 17} textAnchor={x(spot) > w * 0.6 ? "end" : "start"} className="vb-now-t">now {fmt(nowPnl)}</text>
          </g>
        )}
        <text x={w - right} y={y(yMin) - 5} textAnchor="end" className="vb-axis-t">max loss {fmt(yMin)}</text>
      </svg>
      <div className="vb-caption">At expiry only — no “today” curve until the service can price one.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// burndown: actual cost to close against the plan

export interface BurnInput {
  entry: number; target: number; stop: number; opened: string; expiry: string; manageByDte: number;
  manageBy: string; samples: Sample[]; live?: number | null; closedOn?: string;
}

export function Burndown({ h, height = 220 }: { h: BurnInput; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = height, top = 16, bottom = 26, left = 36, right = 12;
  const end = h.closedOn ?? h.expiry;
  const total = Math.max(1, dteBetween(h.opened, end));
  const yMax = Math.max(h.stop, ...h.samples.map((s) => s.cost), h.entry) * 1.08;
  const x = (date: string) => left + (dteBetween(h.opened, date) / total) * (w - left - right);
  const y = (v: number) => top + ((yMax - v) / yMax) * (H - top - bottom);
  const plan: string[] = [];
  for (let i = 0; i <= total; i++) {
    const d = new Date(Date.parse(`${h.opened}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    plan.push(`${i ? "L" : "M"}${x(d).toFixed(1)},${y(plannedOn(h, d)).toFixed(1)}`);
  }
  const actual = h.samples.map((s, i) => `${i ? "L" : "M"}${x(s.date).toFixed(1)},${y(s.cost).toFixed(1)}`).join("");
  const last = h.samples[h.samples.length - 1];
  const showManage = !h.closedOn && dteBetween(h.manageBy, end) >= 0;

  return (
    <div ref={ref} className="vb-burn">
      <svg width={w} height={H} role="img" aria-label="cost to close against the plan">
        {[0, h.target, h.entry, h.stop].map((v) => (
          <text key={`yl${v}`} x={left - 6} y={y(v) + 4} textAnchor="end" className="vb-axis-t">{v.toFixed(2)}</text>
        ))}
        <line x1={left} x2={w - right} y1={y(h.stop)} y2={y(h.stop)} className="vb-rule-stop" />
        <text x={w - right} y={y(h.stop) - 5} textAnchor="end" className="vb-rule-t vb-t-alarm">stop</text>
        <line x1={left} x2={w - right} y1={y(h.target)} y2={y(h.target)} className="vb-rule-target" />
        <text x={w - right} y={y(h.target) - 5} textAnchor="end" className="vb-rule-t vb-t-gain">target</text>
        <line x1={left} x2={w - right} y1={y(h.entry)} y2={y(h.entry)} className="vb-rule-entry" />
        <text x={w - right} y={y(h.entry) - 5} textAnchor="end" className="vb-rule-t">entry</text>
        {showManage && (
          <g>
            <line x1={x(h.manageBy)} x2={x(h.manageBy)} y1={top} y2={H - bottom} className="vb-rule-manage" />
            <text x={x(h.manageBy) - 4} y={top + 10} textAnchor="end" className="vb-rule-t vb-t-warn">manage by {day(h.manageBy)}</text>
          </g>
        )}
        <path d={plan.join("")} className="vb-plan" />
        <path d={actual} className="vb-actual" />
        {h.samples.map((s) => (
          <circle key={s.date} cx={x(s.date)} cy={y(s.cost)} r={s.atClose ? 3.6 : 4.2}
                  className={s.atClose ? "vb-dot" : "vb-dot-off"}>
            <title>{`${day(s.date)}: ${s.cost.toFixed(2)}${s.atClose ? " at the close" : " — not a close (filled after hours)"}`}</title>
          </circle>
        ))}
        {h.live !== null && h.live !== undefined && last && (
          <circle cx={x(last.date) + 6} cy={y(h.live)} r={6} className="vb-live" />
        )}
        <text x={left} y={H - 8} className="vb-axis-t">{day(h.opened)}</text>
        <text x={w - right} y={H - 8} textAnchor="end" className="vb-axis-t">{h.closedOn ? `closed ${day(h.closedOn)}` : `expiry ${day(h.expiry)}`}</text>
      </svg>
      <div className="vb-legend">
        <span><i className="vb-lg-dot" />close</span>
        <span><i className="vb-lg-off" />not a close</span>
        <span><i className="vb-lg-plan" />plan</span>
        {h.live !== undefined && h.live !== null && <span><i className="vb-lg-live" />live</span>}
      </div>
    </div>
  );
}

/** a small multiple: one line, its first and last value, nothing else */
export function Spark({ values, labels, height = 44, unit = "", className = "", digits = 1 }: {
  values: number[]; labels?: [string, string]; height?: number; unit?: string; className?: string; digits?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>(90, 40);
  if (values.length < 2) return <div ref={ref} />;
  const H = height, pad = 4;
  const lo = Math.min(...values), hi = Math.max(...values);
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + ((hi - v) / (hi - lo || 1)) * (H - 2 * pad);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <div ref={ref} className={`vb-spark ${className}`}>
      <svg width={w} height={H}><path d={d} /><circle cx={x(values.length - 1)} cy={y(values.at(-1)!)} r={2.5} /></svg>
      {labels && (
        <div className="vb-spark-l"><span>{labels[0]} {values[0]!.toFixed(digits)}{unit}</span><span>{labels[1]} {values.at(-1)!.toFixed(digits)}{unit}</span></div>
      )}
    </div>
  );
}

/** how far a value has travelled toward its threshold, as an arc */
export function Ring({ fill, state, size = 44, entryDistinct }: { fill: number; state: AlertState; size?: number; entryDistinct: boolean }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  const f = state === "quarantined" ? 0 : Math.max(0, Math.min(100, fill));
  const tone = state === "quarantined" ? "fault" : state === "fired" ? (entryDistinct ? "opp" : "alarm") : state === "near" ? "warn" : "calm";
  return (
    <svg width={size} height={size} className={`vb-ring vb-ring-${tone}`} aria-label={`${f}% of the way`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="vb-ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="vb-ring-bar" strokeDasharray={`${(c * f) / 100} ${c}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dy="0.35em" textAnchor="middle">{state === "quarantined" ? "off" : `${f}`}</text>
    </svg>
  );
}
