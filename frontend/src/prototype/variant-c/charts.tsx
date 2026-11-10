/** PROTOTYPE — throwaway. Variant C's small charts, hand-written SVG. "Never draw what the
 *  system doesn't know": the payoff is AT EXPIRY only (no pricing model, so no T+0 line), and a
 *  sample that is not the close is drawn hollow, never passed off as one. */
import type { Holding, Sample, Side } from "../data";
import {
  breakeven, cushion, dayIndex, fmtDate, fmtDeltaShort, fmtPx, fmtStrike, fmtUsd, hi, isoOfDay, lo,
  niceTicks, payoff, planned, sigma, type PayoffLeg,
} from "./lib";

// ---- the strike strip: spot as a dot among the strikes -----------------------------------------

export interface StripSpread { id: string; side: Side; short: number; long: number | null; shortDelta: number | null; held: boolean }

export function StrikeStrip({ spreads, spot, iv, dte, width }: {
  spreads: StripSpread[]; spot: number; iv: number | null; dte: number; width: number;
}) {
  const H = 64, PAD = 16;
  let a = spot, b = spot;
  for (const s of spreads) { a = Math.min(a, lo(s)); b = Math.max(b, hi(s)); }
  const span = Math.max(80, b - a);
  a -= span * 0.12; b += span * 0.12;
  const x = (p: number) => PAD + ((p - a) / (b - a)) * (width - PAD * 2);
  const sg = iv === null ? null : sigma(spot, iv, dte);
  const mid = 34;
  return (
    <svg width={width} height={H} role="img" aria-label="Where SPX sits among the strikes">
      {sg !== null && (
        <rect x={x(Math.max(a, spot - sg))} y={mid - 14} width={x(Math.min(b, spot + sg)) - x(Math.max(a, spot - sg))}
              height={28} fill="var(--band)" stroke="var(--band-edge)" strokeDasharray="2 3" rx={6} />
      )}
      <line x1={PAD} x2={width - PAD} y1={mid} y2={mid} stroke="var(--rule)" strokeWidth={2} />
      {spreads.map((s, i) => (
        <g key={s.id}>
          {s.long !== null && (
            <rect x={x(lo(s))} y={mid - 6} width={Math.max(4, x(hi(s)) - x(lo(s)))} height={12} rx={3}
                  fill={s.held ? "var(--held-fill)" : "var(--panel)"} stroke={s.held ? "var(--held)" : "var(--ink-2)"} strokeWidth={1.5} />
          )}
          <rect x={x(s.short) - 1.5} y={mid - 11} width={3} height={22} rx={1} fill="var(--ink)" />
          {s.shortDelta !== null && (
            <text x={x(s.short)} y={mid - 15} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink)">{fmtDeltaShort(s.shortDelta)}</text>
          )}
          {/* a strike label only where it has room: close strikes would print as one number */}
          {!spreads.some((o, j) => j < i && Math.abs(x(o.short) - x(s.short)) < 34) && Math.abs(x(s.short) - x(spot)) > 30 && (
            <text x={x(s.short)} y={mid + 24} textAnchor="middle" fontSize={11} fill="var(--ink-2)">{fmtStrike(s.short)}</text>
          )}
        </g>
      ))}
      <circle cx={x(spot)} cy={mid} r={6.5} fill="var(--spot)" stroke="var(--bg)" strokeWidth={2} />
      <text x={x(spot)} y={mid + 24} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink)">{Math.round(spot)}</text>
    </svg>
  );
}

export function cushionLine(side: Side, short: number, spot: number, iv: number | null, dte: number) {
  const d = cushion(side, short, spot);
  const sg = iv === null ? null : sigma(spot, iv, dte);
  const pct = (Math.abs(d) / spot) * 100;
  const sig = sg === null ? "" : ` · ${(Math.abs(d) / sg).toFixed(1)}σ`;
  const dir = side === "call" ? (d >= 0 ? "below" : "above") : (d >= 0 ? "above" : "below");
  return `SPX ${Math.round(Math.abs(d))} pts (${pct.toFixed(1)}%${sig}) ${dir} the short ${side} ${fmtStrike(short)}${d < 0 ? " — in the money" : ""}`;
}

// ---- payoff at expiry --------------------------------------------------------------------------

export function Payoff({ legs, spot, width, height = 170, privacy }: {
  legs: PayoffLeg[]; spot: number; width: number; height?: number; privacy: boolean;
}) {
  const L = 52, R = 12, T = 14, B = 26;
  const shorts = legs.map((l) => l.short);
  const longs = legs.map((l) => (l.side === "call" ? l.short + l.width : l.short - l.width));
  const bes = legs.map(breakeven);
  let a = Math.min(spot, ...shorts, ...longs, ...bes), b = Math.max(spot, ...shorts, ...longs, ...bes);
  const span = Math.max(100, b - a);
  a -= span * 0.25; b += span * 0.25;
  const xs: number[] = [];
  const kinks = [...shorts, ...longs].filter((k) => k > a && k < b).sort((m, n) => m - n);
  xs.push(a, ...kinks, b);
  const ys = xs.map((v) => payoff(legs, v));
  const ymax = Math.max(...ys, 1), ymin = Math.min(...ys, -1);
  const pad = (ymax - ymin) * 0.12;
  const X = (v: number) => L + ((v - a) / (b - a)) * (width - L - R);
  const Y = (v: number) => T + ((ymax + pad - v) / (ymax - ymin + pad * 2)) * (height - T - B);
  const path = xs.map((v, i) => `${i ? "L" : "M"}${X(v).toFixed(1)} ${Y(ys[i]!).toFixed(1)}`).join(" ");
  const zero = Y(0);
  const now = payoff(legs, spot);
  const clipId = `vc-pay-${legs.map((l) => l.short).join("-")}`;
  const area = `${path} L${X(b)} ${zero} L${X(a)} ${zero} Z`;
  const ticks = niceTicks(a, b, Math.floor((width - L - R) / 80));
  return (
    <svg width={width} height={height} role="img" aria-label="Profit and loss at expiry">
      <defs>
        <clipPath id={`${clipId}-up`}><rect x={0} y={0} width={width} height={zero} /></clipPath>
        <clipPath id={`${clipId}-dn`}><rect x={0} y={zero} width={width} height={height} /></clipPath>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X(t)} x2={X(t)} y1={T} y2={height - B} stroke="var(--grid)" />
          <text x={X(t)} y={height - 8} textAnchor="middle" fontSize={10.5} fill="var(--ink-3)">{fmtStrike(t)}</text>
        </g>
      ))}
      <path d={area} fill="var(--gain)" opacity={0.18} clipPath={`url(#${clipId}-up)`} />
      <path d={area} fill="var(--loss)" opacity={0.18} clipPath={`url(#${clipId}-dn)`} />
      <line x1={L} x2={width - R} y1={zero} y2={zero} stroke="var(--rule)" />
      <path d={path} fill="none" stroke="var(--ink)" strokeWidth={2} />
      {shorts.map((s) => <line key={`s${s}`} x1={X(s)} x2={X(s)} y1={T} y2={height - B} stroke="var(--ink-3)" strokeDasharray="3 3" />)}
      {bes.map((v) => (
        <g key={`be${v}`}>
          <line x1={X(v)} x2={X(v)} y1={zero - 8} y2={zero + 8} stroke="var(--ink-2)" strokeWidth={1.5} />
          <text x={X(v)} y={zero + 20} textAnchor="middle" fontSize={10} fill="var(--ink-2)">BE {Math.round(v)}</text>
        </g>
      ))}
      <text x={L - 6} y={Y(ymax) + 4} textAnchor="end" fontSize={10.5} fill="var(--gain)">{privacy ? "max" : fmtUsd(ymax, false)}</text>
      <text x={L - 6} y={Y(ymin) + 4} textAnchor="end" fontSize={10.5} fill="var(--loss)">{privacy ? "min" : fmtUsd(ymin, false)}</text>
      {/* the one point the system knows: today's spot, carried to expiry unchanged */}
      <line x1={X(spot)} x2={X(spot)} y1={T} y2={height - B} stroke="var(--spot)" strokeWidth={1.2} />
      <circle cx={X(spot)} cy={Y(now)} r={5} fill="var(--spot)" stroke="var(--bg)" strokeWidth={2} />
      <text x={Math.min(X(spot) + 8, width - 110)} y={T + 10} fontSize={10.5} fontWeight={650} fill="var(--ink)">
        SPX {Math.round(spot)} → {privacy ? (now >= 0 ? "profit" : "loss") : fmtUsd(now, false)}
      </text>
    </svg>
  );
}

// ---- burndown: cost to close against the plan ---------------------------------------------------

export function Burndown({ h, today, width, height = 150, domain }: {
  h: Holding; today: string; width: number; height?: number; domain?: [string, string];
}) {
  const L = 40, R = 10, T = 10, B = 22;
  const d0 = dayIndex(domain?.[0] ?? h.opened), d1 = dayIndex(domain?.[1] ?? h.expiry);
  const X = (iso: string) => L + ((dayIndex(iso) - d0) / Math.max(1, d1 - d0)) * (width - L - R);
  const top = Math.max(h.stop, ...h.samples.map((s) => s.cost)) * 1.08;
  const Y = (v: number) => T + ((top - v) / top) * (height - T - B);
  const planDays: string[] = [];
  for (let d = dayIndex(h.opened); d <= dayIndex(h.expiry); d++) planDays.push(isoOfDay(d));
  const plan = planDays.map((iso, i) => `${i ? "L" : "M"}${X(iso).toFixed(1)} ${Y(planned(h, iso)).toFixed(1)}`).join(" ");
  const live = h.value ?? h.samples.at(-1)?.cost ?? h.entry;
  return (
    <svg width={width} height={height} role="img" aria-label={`${h.name}: cost to close against the plan`}>
      <rect x={X(today)} y={T} width={Math.max(0, X(h.expiry) - X(today))} height={height - T - B} fill="var(--panel-2)" opacity={0.6} />
      <line x1={L} x2={width - R} y1={Y(h.stop)} y2={Y(h.stop)} stroke="var(--loss)" strokeDasharray="5 3" />
      <text x={width - R} y={Y(h.stop) - 3} textAnchor="end" fontSize={10} fill="var(--loss)">stop {h.stop.toFixed(2)}</text>
      <line x1={L} x2={width - R} y1={Y(h.target)} y2={Y(h.target)} stroke="var(--gain)" strokeDasharray="5 3" />
      <text x={width - R} y={Y(h.target) + 11} textAnchor="end" fontSize={10} fill="var(--gain)">target {h.target.toFixed(2)}</text>
      <line x1={L} x2={width - R} y1={Y(h.entry)} y2={Y(h.entry)} stroke="var(--rule)" />
      <text x={L - 4} y={Y(h.entry) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)">{h.entry.toFixed(2)}</text>
      <line x1={X(h.manageBy)} x2={X(h.manageBy)} y1={T} y2={height - B} stroke="var(--near)" strokeDasharray="2 3" />
      <text x={X(h.manageBy) + 3} y={height - B - 4} fontSize={10} fill="var(--near)">manage by</text>
      <path d={plan} fill="none" stroke="var(--ink-2)" strokeDasharray="1.5 3" strokeWidth={1.6} />
      {h.samples.map((s) => <SampleDot key={s.date} s={s} cx={X(s.date)} cy={Y(s.cost)} />)}
      <circle cx={X(today)} cy={Y(live)} r={5.5} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
      <text x={L} y={height - 6} fontSize={10} fill="var(--ink-3)">{fmtDate(isoOfDay(d0))}</text>
      <text x={width - R} y={height - 6} textAnchor="end" fontSize={10} fill="var(--ink-3)">{fmtDate(isoOfDay(d1))}</text>
      <text x={X(today)} y={height - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--ink-2)">today</text>
    </svg>
  );
}

function SampleDot({ s, cx, cy }: { s: Sample; cx: number; cy: number }) {
  return s.atClose
    ? <circle cx={cx} cy={cy} r={3} fill="var(--ink)"><title>{`${s.date} close: ${s.cost.toFixed(2)}`}</title></circle>
    : <circle cx={cx} cy={cy} r={3.4} fill="var(--bg)" stroke="var(--near)" strokeWidth={1.6}><title>{`${s.date}: ${s.cost.toFixed(2)} — NOT the close (an evening fill)`}</title></circle>;
}

// ---- where SPX was against my strikes -------------------------------------------------------------

export function SpotPath({ samples, side, short, long, entry, width, height = 120, domain, spotToday, today }: {
  samples: Sample[]; side: Side; short: number; long: number; entry: number; width: number; height?: number;
  domain?: [string, string]; spotToday?: number; today?: string;
}) {
  const L = 44, R = 10, T = 10, B = 18;
  const d0 = dayIndex(domain?.[0] ?? samples[0]!.date), d1 = dayIndex(domain?.[1] ?? samples.at(-1)!.date);
  const X = (iso: string) => L + ((dayIndex(iso) - d0) / Math.max(1, d1 - d0)) * (width - L - R);
  const be = side === "call" ? short + entry : short - entry;
  const prices = [...samples.map((s) => s.spot), short, long, be, ...(spotToday ? [spotToday] : [])];
  let a = Math.min(...prices), b = Math.max(...prices);
  const pad = (b - a) * 0.1 + 10; a -= pad; b += pad;
  const Y = (p: number) => T + ((b - p) / (b - a)) * (height - T - B);
  const lossTop = side === "call" ? Y(b) : Y(short);
  const lossH = side === "call" ? Y(short) - Y(b) : Y(a) - Y(short);
  const pts = samples.map((s, i) => `${i ? "L" : "M"}${X(s.date).toFixed(1)} ${Y(s.spot).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label="SPX's path against the short strike">
      <rect x={L} y={lossTop} width={width - L - R} height={Math.max(0, lossH)} fill="var(--loss)" opacity={0.1} />
      <line x1={L} x2={width - R} y1={Y(short)} y2={Y(short)} stroke="var(--ink)" strokeWidth={1.4} />
      <text x={L - 4} y={Y(short) + 3} textAnchor="end" fontSize={10} fontWeight={700} fill="var(--ink)">{fmtStrike(short)}</text>
      <line x1={L} x2={width - R} y1={Y(long)} y2={Y(long)} stroke="var(--ink-3)" strokeDasharray="2 2" />
      <text x={L - 4} y={Y(long) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)">{fmtStrike(long)}</text>
      <line x1={L} x2={width - R} y1={Y(be)} y2={Y(be)} stroke="var(--ink-2)" strokeDasharray="5 3" />
      <text x={width - R} y={Y(be) - 3} textAnchor="end" fontSize={9.5} fill="var(--ink-2)">BE {Math.round(be)}</text>
      <path d={pts} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
      {samples.map((s) => <circle key={s.date} cx={X(s.date)} cy={Y(s.spot)} r={s.atClose ? 2.2 : 2.8}
                                  fill={s.atClose ? "var(--accent)" : "var(--bg)"} stroke={s.atClose ? "none" : "var(--near)"} />)}
      {spotToday && today && <circle cx={X(today)} cy={Y(spotToday)} r={4.5} fill="var(--spot)" stroke="var(--bg)" strokeWidth={2} />}
      <text x={L} y={height - 4} fontSize={9.5} fill="var(--ink-3)">SPX {fmtPx(samples[0]!.spot)}</text>
    </svg>
  );
}

// ---- per-day short IV ----------------------------------------------------------------------------

export function IvSpark({ samples, width, height = 36 }: { samples: Sample[]; width: number; height?: number }) {
  const v = samples.map((s) => s.shortIv);
  const a = Math.min(...v), b = Math.max(...v);
  const X = (i: number) => 4 + (i / Math.max(1, v.length - 1)) * (width - 8);
  const Y = (x: number) => 4 + ((b - x) / Math.max(0.01, b - a)) * (height - 8);
  const d = v.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label="Short leg IV per day">
      <path d={d} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} />
      {samples.map((s, i) => <circle key={s.date} cx={X(i)} cy={Y(s.shortIv)} r={1.8} fill={s.atClose ? "var(--ink-2)" : "var(--near)"} />)}
    </svg>
  );
}
