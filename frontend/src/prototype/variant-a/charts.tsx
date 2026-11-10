/** PROTOTYPE — throwaway. Variant A's charts, hand-written SVG: the strike strip, the payoff at
 *  expiry (never a T+0 curve: there is no pricing model), the burndown and the IV small multiple.
 *  Colours come from the .va CSS variables, so dark mode and the up/down flip cost nothing. */
import type { Sample, Side } from "../data";
import { md, spx } from "./fmt";

export interface Wing {
  side: Side;
  short: number;
  long: number | null;
  /** credit per spread, points: the entry for a holding, today's value "if sold now" otherwise */
  credit: number;
  contracts: number;
  shortDelta: number | null;
}

const lin = (d0: number, d1: number, r0: number, r1: number) => (x: number) =>
  r0 + ((x - d0) / (d1 - d0 || 1)) * (r1 - r0);

/** The price window both the strip and the payoff use: every strike and spot, padded. */
export function priceDomain(wings: Wing[], spot: number): [number, number] {
  const xs = [spot, ...wings.flatMap((w) => (w.long == null ? [w.short] : [w.short, w.long]))];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = Math.max((hi - lo) * 0.28, spot * 0.008);
  return [lo - pad, hi + pad];
}

/** Points per one lot of each wing at expiry, summed and weighted by contracts. */
export function payoff(wings: Wing[], s: number): number {
  let total = 0;
  for (const w of wings) {
    const intr = (k: number) => (w.side === "call" ? Math.max(0, s - k) : Math.max(0, k - s));
    const loss = intr(w.short) - (w.long == null ? 0 : intr(w.long));
    total += (w.credit - loss) * w.contracts;
  }
  return total;
}

function breakevens(wings: Wing[], d: [number, number]): number[] {
  const out: number[] = [];
  const n = 400;
  let px = d[0], py = payoff(wings, px);
  for (let i = 1; i <= n; i++) {
    const x = d[0] + ((d[1] - d[0]) * i) / n, y = payoff(wings, x);
    if ((py < 0 && y >= 0) || (py > 0 && y <= 0)) out.push(px + ((0 - py) / (y - py)) * (x - px));
    px = x; py = y;
  }
  return out;
}

/** One standard deviation of SPX by expiry, from the short leg's own IV. */
export const sigma = (spot: number, ivPct: number | null, dte: number) =>
  ivPct == null ? null : spot * (ivPct / 100) * Math.sqrt(Math.max(dte, 0.5) / 365);

// ---------------------------------------------------------------------------------------------

export function StrikeStrip({ wings, spot, sd, compact = false }: {
  wings: Wing[]; spot: number; sd: number | null; compact?: boolean;
}) {
  const W = 400, H = compact ? 18 : 104;
  const d = priceDomain(wings, spot);
  const x = lin(d[0], d[1], compact ? 2 : 14, W - (compact ? 2 : 14));
  const axisY = compact ? 9 : 50;
  const shorts = wings.map((w) => w.short);
  const near = shorts.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), shorts[0]!);
  const dist = Math.abs(near - spot);
  // the profit zone: between two shorts for a condor, else from the short away from its wing
  const calls = wings.filter((w) => w.side === "call").map((w) => w.short);
  const puts = wings.filter((w) => w.side === "put").map((w) => w.short);
  const zoneLo = puts.length ? Math.max(...puts) : d[0];
  const zoneHi = calls.length ? Math.min(...calls) : d[1];
  const bandH = compact ? 8 : 14;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={compact ? 18 : undefined} preserveAspectRatio={compact ? "none" : "xMidYMid meet"}
         role="img" aria-label={`SPX ${spx(spot)}, nearest short strike ${near}, ${dist.toFixed(0)} points away`}>
      {!compact && sd != null && (
        <rect x={x(spot - sd)} y={axisY - 22} width={x(spot + sd) - x(spot - sd)} height={44}
              fill="var(--accent)" opacity={0.07} />
      )}
      <rect x={x(zoneLo)} y={axisY - bandH / 2} width={Math.max(0, x(zoneHi) - x(zoneLo))} height={bandH}
            fill="var(--up)" opacity={0.13} />
      {wings.map((w, i) => w.long == null ? null : (
        <g key={i}>
          <rect x={Math.min(x(w.short), x(w.long))} y={axisY - bandH / 2} width={Math.abs(x(w.long) - x(w.short))}
                height={bandH} fill="var(--down)" opacity={0.28} />
          <rect x={w.side === "call" ? x(w.long) : x(d[0])} y={axisY - bandH / 2}
                width={w.side === "call" ? x(d[1]) - x(w.long) : x(w.long) - x(d[0])} height={bandH}
                fill="var(--down)" opacity={0.45} />
        </g>
      ))}
      <line x1={x(d[0])} x2={x(d[1])} y1={axisY} y2={axisY} stroke="var(--line-strong)" />
      {wings.map((w, i) => (
        <g key={`k${i}`}>
          <line x1={x(w.short)} x2={x(w.short)} y1={axisY - bandH / 2 - (compact ? 0 : 4)} y2={axisY + bandH / 2}
                stroke="var(--text)" strokeWidth={compact ? 1.5 : 1.5} />
          {!compact && (
            <>
              <text x={x(w.short)} y={axisY - 15} textAnchor="middle" className="lbl-strong">{w.short}</text>
              {w.shortDelta != null && (
                <text x={x(w.short)} y={axisY - 27} textAnchor="middle">Δ{Math.abs(w.shortDelta).toFixed(3).slice(1)}</text>
              )}
              {w.long != null && <text x={x(w.long)} y={axisY + 21} textAnchor="middle">{w.long}</text>}
            </>
          )}
        </g>
      ))}
      <circle cx={x(spot)} cy={axisY} r={compact ? 3 : 5} fill="var(--accent)" stroke="var(--panel)" strokeWidth={compact ? 1 : 2} />
      {!compact && (
        <>
          <line x1={x(spot)} x2={x(near)} y1={axisY + 36} y2={axisY + 36} stroke="var(--dim)" strokeDasharray="2 3" />
          <line x1={x(spot)} x2={x(spot)} y1={axisY + 26} y2={axisY + 40} stroke="var(--accent)" opacity={0.5} />
          <line x1={x(near)} x2={x(near)} y1={axisY + 30} y2={axisY + 40} stroke="var(--dim)" />
          <text x={(x(spot) + x(near)) / 2} y={axisY + 50} textAnchor="middle" className="lbl-strong">
            {dist.toFixed(0)} pts{sd ? ` · ${(dist / sd).toFixed(1)}σ` : ""}
          </text>
          <text x={x(spot)} y={axisY + 21} textAnchor={x(spot) > W - 60 ? "end" : x(spot) < 60 ? "start" : "middle"}
                fill="var(--accent)" style={{ fill: "var(--accent)" }}>SPX {spx(spot)}</text>
        </>
      )}
    </svg>
  );
}

export function PayoffChart({ wings, spot, dollars }: { wings: Wing[]; spot: number; dollars: boolean }) {
  const W = 400, H = 170, L = 58, R = 10, T = 12, B = 22;
  const d = priceDomain(wings, spot);
  const n = 160;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const s = d[0] + ((d[1] - d[0]) * i) / n;
    return [s, payoff(wings, s)] as const;
  });
  const ys = pts.map((p) => p[1]);
  const ymax = Math.max(...ys, 0), ymin = Math.min(...ys, 0);
  const span = ymax - ymin || 1;
  const x = lin(d[0], d[1], L, W - R);
  const y = lin(ymax + span * 0.08, ymin - span * 0.08, T, H - B);
  const path = pts.map(([s, v], i) => `${i ? "L" : "M"}${x(s).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${path}L${x(d[1])},${y(0)}L${x(d[0])},${y(0)}Z`;
  const bes = breakevens(wings, d);
  const unit = (v: number) => {
    const s = v < 0 ? "−" : "";
    return dollars ? `${s}$${Math.round(Math.abs(v) * 100).toLocaleString("en-US")}` : `${s}${Math.abs(v).toFixed(2)} pts`;
  };
  const now = payoff(wings, spot);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="payoff at expiry">
      <defs>
        <clipPath id="va-above"><rect x={0} y={0} width={W} height={y(0)} /></clipPath>
        <clipPath id="va-below"><rect x={0} y={y(0)} width={W} height={H} /></clipPath>
      </defs>
      <path d={area} fill="var(--up)" opacity={0.16} clipPath="url(#va-above)" />
      <path d={area} fill="var(--down)" opacity={0.16} clipPath="url(#va-below)" />
      <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />
      {wings.map((w, i) => (
        <line key={i} x1={x(w.short)} x2={x(w.short)} y1={T} y2={H - B} stroke="var(--dim)" strokeDasharray="3 3" opacity={0.7} />
      ))}
      <path d={path} fill="none" stroke="var(--text)" strokeWidth={1.6} />
      {bes.map((b, i) => (
        <g key={i}>
          <circle cx={x(b)} cy={y(0)} r={2.5} fill="var(--text)" />
          <text x={x(b)} y={H - 8} textAnchor="middle">BE {b.toFixed(0)}</text>
        </g>
      ))}
      <line x1={x(spot)} x2={x(spot)} y1={T} y2={H - B} stroke="var(--accent)" />
      <circle cx={x(spot)} cy={y(now)} r={4} fill="var(--accent)" stroke="var(--panel)" strokeWidth={1.5} />
      <text x={L - 4} y={y(ymax) + 4} textAnchor="end">{unit(ymax)}</text>
      <text x={L - 4} y={y(ymin) + 4} textAnchor="end">{unit(ymin)}</text>
      {Math.min(Math.abs(y(0) - y(ymax)), Math.abs(y(0) - y(ymin))) > 12 && <text x={L - 4} y={y(0) + 3} textAnchor="end">0</text>}
      <text x={Math.min(x(spot) + 6, W - 60)} y={T + 8} style={{ fill: "var(--accent)" }}>SPX {spot.toFixed(0)}</text>
    </svg>
  );
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const between = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Cost to close per day against the plan: actual against ideal, the way a burndown reads. */
export function Burndown({ samples, entry, target, stop, manageBy, expiry, live, exitOn }: {
  samples: Sample[]; entry: number; target: number; stop: number; manageBy: string; expiry: string;
  /** today's live mark, drawn apart from the closes */
  live?: { date: string; value: number };
  /** a closed trade's exit */
  exitOn?: { date: string; value: number };
}) {
  const W = 400, H = 180, L = 34, R = 10, T = 10, B = 22;
  const opened = samples[0]?.date ?? manageBy;
  const end = [manageBy, live?.date ?? opened, exitOn?.date ?? opened, samples.at(-1)?.date ?? opened].sort().at(-1)!;
  const span = Math.max(1, between(opened, end));
  const RL = 64; // a label gutter right of the last day: stop / entry / target are named there, off the data
  const x = (iso: string) => L + (between(opened, iso) / span) * (W - L - R - RL);
  const costs = samples.map((s) => s.cost);
  const ymax = Math.max(stop, ...costs, live?.value ?? 0) * 1.08;
  const y = lin(ymax, 0, T, H - B);
  const dteAtOpen = between(opened, expiry);
  const mbDte = between(manageBy, expiry);
  const plan: string[] = [];
  for (let i = 0; i <= span; i++) {
    const iso = addDays(opened, i);
    const left = Math.max(0, between(iso, expiry) - mbDte);
    const v = target + (entry - target) * Math.sqrt(left / Math.max(1, dteAtOpen - mbDte));
    plan.push(`${i ? "L" : "M"}${x(iso).toFixed(1)},${y(v).toFixed(1)}`);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="cost to close against the plan">
      <line x1={L} x2={W - R - RL + 4} y1={y(stop)} y2={y(stop)} stroke="var(--alarm)" strokeWidth={1} />
      <text x={W - R} y={y(stop) + 3} textAnchor="end" style={{ fill: "var(--alarm)" }}>stop {stop.toFixed(2)}</text>
      <line x1={L} x2={W - R - RL + 4} y1={y(target)} y2={y(target)} stroke="var(--up)" strokeDasharray="5 3" />
      <text x={W - R} y={y(target) + 3} textAnchor="end" style={{ fill: "var(--up)" }}>target {target.toFixed(2)}</text>
      <line x1={L} x2={W - R - RL + 4} y1={y(entry)} y2={y(entry)} stroke="var(--faint)" strokeDasharray="1 3" />
      <text x={W - R} y={y(entry) + 3} textAnchor="end">entry {entry.toFixed(2)}</text>
      <line x1={x(manageBy)} x2={x(manageBy)} y1={T} y2={H - B} stroke="var(--warn)" strokeDasharray="2 2" />
      <text x={x(manageBy)} y={H - 6} textAnchor="middle" style={{ fill: "var(--warn)" }}>manage-by {md(manageBy)}</text>
      <path d={plan.join("")} fill="none" stroke="var(--dim)" strokeDasharray="1.5 3" strokeWidth={1.4} />
      <polyline points={samples.map((s) => `${x(s.date)},${y(s.cost)}`).join(" ")} fill="none" stroke="var(--text)" strokeWidth={1} opacity={0.35} />
      {samples.map((s) => s.atClose
        ? <circle key={s.date} cx={x(s.date)} cy={y(s.cost)} r={2.8} fill="var(--text)" />
        : <circle key={s.date} cx={x(s.date)} cy={y(s.cost)} r={3.2} fill="var(--panel)" stroke="var(--text)" strokeDasharray="1.5 1.2" />)}
      {live && (
        <rect x={x(live.date) - 4} y={y(live.value) - 4} width={8} height={8} transform={`rotate(45 ${x(live.date)} ${y(live.value)})`}
              fill="var(--panel)" stroke="var(--accent)" strokeWidth={1.6} />
      )}
      {exitOn && (
        <rect x={x(exitOn.date) - 4} y={y(exitOn.value) - 4} width={8} height={8} fill="var(--accent)" />
      )}
      <text x={L} y={H - 6} textAnchor="start">{md(opened)}</text>
      {end !== manageBy && <text x={x(end)} y={H - 6} textAnchor="middle">{md(end)}</text>}
      <text x={L - 4} y={y(0) + 3} textAnchor="end">0</text>
    </svg>
  );
}

export function IvSpark({ samples }: { samples: Sample[] }) {
  const W = 400, H = 58, L = 34, R = 10, T = 8, B = 14;
  if (samples.length < 2) return null;
  const v = samples.map((s) => s.shortIv);
  const lo = Math.min(...v), hi = Math.max(...v);
  const x = lin(0, samples.length - 1, L, W - R);
  const y = lin(hi + 0.2, lo - 0.2, T, H - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="short leg IV by day">
      <polyline points={v.map((iv, i) => `${x(i)},${y(iv)}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
      {v.map((iv, i) => <circle key={i} cx={x(i)} cy={y(iv)} r={1.8} fill="var(--accent)" />)}
      <text x={L - 4} y={y(hi) + 3} textAnchor="end">{hi.toFixed(1)}</text>
      <text x={L - 4} y={y(lo) + 3} textAnchor="end">{lo.toFixed(1)}</text>
      <text x={W - R} y={H - 2} textAnchor="end">{v.at(-1)!.toFixed(1)}% now</text>
    </svg>
  );
}
