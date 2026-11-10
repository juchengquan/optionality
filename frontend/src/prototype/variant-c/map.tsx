/** PROTOTYPE — throwaway. The live price map: ONE SPX axis for the whole book.
 *
 *  Desk: price runs left→right, one horizontal lane per expiry.
 *  Phone: the axis turns VERTICAL — price up the screen like a ladder, one column per expiry —
 *  because 2,000 index points across 358px leaves a 50-wide spread 9px wide; up the screen it
 *  gets ~22px and the view opens centred on spot. */
import { useMemo } from "react";

import type { Book } from "../data";
import {
  breakeven, cushion, fmtDeltaShort, fmtPx, fmtSignedPct, fmtStrike, hi, holdingLeg, lo, niceTicks,
  priceDomain, sigma, worstTone, type Lane, type Spread, type Tone,
} from "./lib";

const TONE_COLOR: Record<Tone, string> = {
  neutral: "var(--ink)", near: "var(--near)", opportunity: "var(--opp)", alarm: "var(--alarm)",
  fault: "var(--fault)", muted: "var(--ink-3)",
};

interface Props {
  book: Book;
  lanes: Lane[];
  width: number;
  phone: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  entryStyle: "distinct" | "same";
}


/** greedy slotting: a spread takes the first slot (row or sub-column) its footprint fits in */
function slot(items: Spread[], footprint: (s: Spread) => [number, number]): Map<string, number> {
  const slots: [number, number][][] = [];
  const out = new Map<string, number>();
  for (const s of items) {
    const [a, b] = footprint(s);
    let i = slots.findIndex((taken) => taken.every(([x, y]) => b < x || a > y));
    if (i < 0) { slots.push([]); i = slots.length - 1; }
    slots[i]!.push([a, b]);
    out.set(s.id, i);
  }
  return out;
}

export function PriceMap(p: Props) {
  return p.phone ? <VerticalMap {...p} /> : <HorizontalMap {...p} />;
}

// ---------------------------------------------------------------------------------------------
// the shared marks: a bar, its short-strike notch and Δ, its state glyph, its progress

function Glyph({ x, y, tone }: { x: number; y: number; tone: Tone }) {
  if (tone === "neutral" || tone === "muted") return null;
  const c = TONE_COLOR[tone];
  if (tone === "near") return <circle cx={x} cy={y} r={5} fill="none" stroke={c} strokeWidth={2} />;
  if (tone === "fault") {
    return (
      <g>
        <circle cx={x} cy={y} r={6} fill="none" stroke={c} strokeWidth={1.8} />
        <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} stroke={c} strokeWidth={1.8} />
      </g>
    );
  }
  if (tone === "opportunity") {
    return (
      <g className="glow">
        <circle cx={x} cy={y} r={7} fill={c} />
        <circle cx={x} cy={y} r={3.6} fill="none" stroke="var(--opp-ink)" strokeWidth={1.6} />
        <circle cx={x} cy={y} r={1.2} fill="var(--opp-ink)" />
      </g>
    );
  }
  return (
    <g className="pulse">
      <circle cx={x} cy={y} r={7} fill={c} />
      <text x={x} y={y + 3.6} textAnchor="middle" fontSize={10} fontWeight={800} fill="var(--alarm-ink)">!</text>
    </g>
  );
}

function barPaint(s: Spread) {
  const quarantined = s.kind === "candidate" && s.alerts.some((a) => a.state === "quarantined");
  if (quarantined) return { fill: "url(#vc-hatch)", stroke: "var(--fault)", dash: "3 2" };
  if (s.kind === "holding") return { fill: "var(--held-fill)", stroke: "var(--held)", dash: undefined };
  return { fill: "var(--panel)", stroke: "var(--ink-2)", dash: undefined };
}

function Defs() {
  return (
    <defs>
      <pattern id="vc-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="5" stroke="var(--fault)" strokeWidth="1.4" opacity="0.6" />
      </pattern>
    </defs>
  );
}

function maxFill(s: Spread) {
  return Math.max(0, ...s.alerts.filter((a) => a.state !== "quarantined").map((a) => a.fill)) / 100;
}

function describe(s: Spread, spot: number) {
  const dist = cushion(s.side, s.short, spot);
  const where = dist >= 0 ? `${Math.round(dist)} pts out of the money` : `${Math.round(-dist)} pts IN the money`;
  const what = s.long === null ? `${s.side} ${s.short}` : `${s.side} spread ${s.short}/${s.long}`;
  return `${s.name} · ${s.kind === "holding" ? "held" : "watching"} · ${what} · short ${where} · ${s.alerts.map((a) => a.sentence).join("; ")}`;
}

// ---------------------------------------------------------------------------------------------
// desk: price across

function HorizontalMap({ book, lanes, width, selected, onSelect, entryStyle }: Props) {
  const LEFT = 132, RIGHT = 28, TOP = 46, BOTTOM = 30, ROW = 56, PAD = 10;
  const [min, max] = useMemo(() => priceDomain(book, lanes), [book, lanes]);
  const W = Math.max(200, width - LEFT - RIGHT);
  const x = (p: number) => LEFT + ((p - min) / (max - min)) * W;
  const ppt = W / (max - min);

  const layout = useMemo(() => lanes.map((l) => {
    const items: Spread[] = [...l.holdings, ...l.candidates];
    const half = 26 / ppt; // the Δ label's half-width, in index points
    const slots = slot(items, (s) => [Math.min(lo(s), s.short - half) - 8 / ppt, Math.max(hi(s), s.short + half) + 20 / ppt]);
    const rows = Math.max(1, ...[...slots.values()].map((v) => v + 1));
    return { lane: l, slots, rows, h: PAD * 2 + rows * ROW };
  }), [lanes, ppt]);

  let y0 = TOP;
  const tops = layout.map((L) => { const t = y0; y0 += L.h; return t; });
  const H = y0 + BOTTOM;
  const ticks = niceTicks(min, max, Math.floor(W / 90));
  const sx = x(book.spot);
  const up = book.spotChange >= 0;
  const spotLabel = `SPX ${fmtPx(book.spot)} ${up ? "▲" : "▼"} ${fmtSignedPct(book.spotChange)}`;
  const pill = spotLabel.length * 7.6 + 24;

  return (
    <svg className="map" width={width} height={H} role="img" aria-label="Every spread on one SPX price axis">
      <Defs />
      {/* gridlines and the axis, top and bottom */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={H - BOTTOM + 4} stroke="var(--grid)" />
          <text x={x(t)} y={H - BOTTOM + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{fmtStrike(t)}</text>
        </g>
      ))}
      {layout.map((L, i) => {
        const top = tops[i]!;
        const l = L.lane;
        const sg = l.iv === null ? null : sigma(book.spot, l.iv, l.dte);
        return (
          <g key={l.expiry}>
            <rect x={0} y={top} width={width} height={L.h} fill={i % 2 ? "transparent" : "var(--panel)"} opacity={0.55} />
            <line x1={0} x2={width} y1={top} y2={top} stroke="var(--rule)" />
            {/* lane label */}
            <text x={14} y={top + 24} fontSize={15} fontWeight={700} fill="var(--ink)">{fmtDateShort(l.expiry)}</text>
            <text x={14} y={top + 42} fontSize={12} fill="var(--ink-2)">{l.dte}d to expiry</text>
            <text x={14} y={top + 58} fontSize={11} fill="var(--ink-3)">
              {sg === null ? "no IV in lane" : `±1σ ≈ ${Math.round(sg)} pts`}
            </text>
            {/* the ±1σ band: one IV for the lane, so approximate */}
            {sg !== null && (
              <g>
                <rect x={x(book.spot - sg)} y={top + 3} width={x(book.spot + sg) - x(book.spot - sg)} height={L.h - 6}
                      fill="var(--band)" stroke="var(--band-edge)" strokeDasharray="2 3" rx={4} />
              </g>
            )}
            {/* condor brackets: two held spreads on one expiry */}
            {l.holdings.filter((h) => h.pairedWith && h.side === "put").map((put) => {
              const call = l.holdings.find((h) => h.id === put.pairedWith);
              if (!call) return null;
              const row = L.slots.get(put.id) ?? 0;
              const yy = top + PAD + row * ROW + 23;
              const inside = book.spot > put.short && book.spot < call.short;
              // the words only where they fit between the put's labels and the spot line
              const room = x(book.spot) - x(put.short) - 40;
              return (
                <g key={`c-${put.id}`}>
                  <line x1={x(put.short)} x2={x(call.short)} y1={yy} y2={yy} stroke="var(--held)" strokeDasharray="1 3" strokeWidth={1.5} />
                  {room > 170 && (
                    <text x={x(put.short) + 30} y={yy + 15} fontSize={10.5} fill="var(--ink-2)">
                      condor · SPX {inside ? "inside" : "OUTSIDE"} the shorts
                    </text>
                  )}
                </g>
              );
            })}
            {[...l.holdings, ...l.candidates].map((s) => {
              const row = L.slots.get(s.id) ?? 0;
              const by = top + PAD + row * ROW + 16; // bar top
              const tone = worstTone(s.alerts, entryStyle);
              const paint = barPaint(s);
              const a = x(lo(s)), b = x(hi(s));
              const w = Math.max(6, b - a);
              const sel = selected === s.id;
              const glyphX = s.side === "call" || s.long === null ? Math.max(a + w, x(s.short)) + 12 : a - 12;
              return (
                <g key={s.id} className="bar" tabIndex={0} role="button" aria-label={describe(s, book.spot)}
                   onClick={() => onSelect(s.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(s.id); }}>
                  <title>{describe(s, book.spot)}</title>
                  {/* a generous hit area: the bar is often 25px wide */}
                  <rect x={a - 10} y={by - 16} width={w + 20} height={ROW} fill="transparent" />
                  {sel && <rect x={a - 6} y={by - 15} width={w + 12} height={ROW - 4} rx={6} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                  {s.long === null ? (
                    <path d={`M${x(s.short)} ${by - 1} l7 7 l-7 7 l-7 -7 z`} fill={paint.fill} stroke={paint.stroke} strokeWidth={1.5} className="body" />
                  ) : (
                    <rect className="body" x={a} y={by} width={w} height={14} rx={3} fill={paint.fill} stroke={paint.stroke}
                          strokeWidth={s.kind === "holding" ? 1.8 : 1.3} strokeDasharray={paint.dash} />
                  )}
                  {/* the short strike: the edge that matters */}
                  <rect x={x(s.short) - 1.5} y={by - 4} width={3} height={20} rx={1} fill={TONE_COLOR[tone === "neutral" ? "neutral" : tone]} />
                  {s.shortDelta !== null && (
                    <text x={x(s.short)} y={by - 7} textAnchor="middle" fontSize={11} fontWeight={650}
                          fill={tone === "neutral" ? "var(--ink-2)" : TONE_COLOR[tone]}>{fmtDeltaShort(s.shortDelta)}</text>
                  )}
                  {/* which spread this is, by its short strike: "7700C" */}
                  <text x={x(s.short)} y={by + 38} textAnchor="middle" fontSize={10} fill="var(--ink-3)">
                    {fmtStrike(s.short)}{s.side === "call" ? "C" : "P"}
                  </text>
                  {/* how far toward its nearest alert */}
                  {s.long !== null && <rect x={a} y={by + 17} width={w * maxFill(s)} height={2.5} rx={1}
                                            fill={tone === "neutral" ? "var(--ink-3)" : TONE_COLOR[tone]} />}
                  <Glyph x={glyphX} y={by + 7} tone={tone} />
                  {/* breakeven at expiry, for what is held */}
                  {s.kind === "holding" && (
                    <g>
                      <path d={`M${x(breakeven(holdingLeg(s)))} ${by + 21} l-4 6 h8 z`} fill="var(--ink-3)" />
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
      {/* spot: the one line every lane is read against */}
      <line x1={sx} x2={sx} y1={TOP - 14} y2={H - BOTTOM + 4} stroke="var(--spot)" strokeWidth={1.6} />
      <g>
        <rect x={sx - pill / 2} y={6} width={pill} height={24} rx={12} fill="var(--spot)" />
        <text x={sx} y={22.5} textAnchor="middle" fontSize={12.5} fontWeight={750} fill="var(--bg)">
          {spotLabel}
        </text>
      </g>
      <line x1={0} x2={width} y1={H - BOTTOM} y2={H - BOTTOM} stroke="var(--rule)" />
    </svg>
  );
}

const fmtDateShort = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

// ---------------------------------------------------------------------------------------------
// phone: price up the screen

function VerticalMap({ book, lanes, width, selected, onSelect, entryStyle }: Props) {
  const AXIS = 50, RIGHT = 6, TOPPAD = 16;
  const [min, max] = useMemo(() => priceDomain(book, lanes), [book, lanes]);
  // the whole ladder in one screen: as many px per point as the window allows, within reason
  const PPT = Math.min(0.46, Math.max(0.22, (window.innerHeight - 200) / (max - min)));
  const H = Math.round((max - min) * PPT) + TOPPAD * 2;
  const y = (p: number) => TOPPAD + (max - p) * PPT;
  const colW = (width - AXIS - RIGHT) / Math.max(1, lanes.length);

  const layout = useMemo(() => lanes.map((l) => {
    const items: Spread[] = [...l.holdings, ...l.candidates];
    const slots = slot(items, (s) => [lo(s) - 22 / PPT, hi(s) + 22 / PPT]);
    const subs = Math.max(1, ...[...slots.values()].map((v) => v + 1));
    return { lane: l, slots, subs };
  }), [lanes, PPT]);

  const sy = y(book.spot);
  const ticks = niceTicks(min, max, Math.floor(H / 70));

  return (
    <div>
      {/* lane headers stay put while the ladder scrolls */}
      <div className="flex" style={{ paddingLeft: AXIS, paddingRight: RIGHT }}>
        {lanes.map((l) => {
          const sg = l.iv === null ? null : sigma(book.spot, l.iv, l.dte);
          return (
            <div key={l.expiry} style={{ width: colW }} className="px-1 pb-1.5 text-center leading-tight">
              <div className="text-[13px] font-bold">{fmtDateShort(l.expiry)}</div>
              <div className="num text-[11px] muted">{l.dte}d · {sg === null ? "no IV" : `σ≈${Math.round(sg)}`}</div>
            </div>
          );
        })}
      </div>
      <div className="relative rounded-xl border hairline" style={{ background: "var(--panel)" }}>
        <svg className="map" width={width - 2} height={H} role="img" aria-label="Every spread on one SPX price ladder">
          <Defs />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={AXIS} x2={width} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              {Math.abs(y(t) - sy) > 14 && <text x={AXIS - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)">{fmtStrike(t)}</text>}
            </g>
          ))}
          {layout.map((L, i) => {
            const l = L.lane;
            const left = AXIS + i * colW;
            const sg = l.iv === null ? null : sigma(book.spot, l.iv, l.dte);
            const subW = (colW - 6) / L.subs;
            return (
              <g key={l.expiry}>
                <line x1={left} x2={left} y1={0} y2={H} stroke="var(--rule)" />
                {sg !== null && (
                  <rect x={left + 2} y={y(book.spot + sg)} width={colW - 4} height={y(book.spot - sg) - y(book.spot + sg)}
                        fill="var(--band)" stroke="var(--band-edge)" strokeDasharray="2 3" rx={4} />
                )}
                {l.holdings.filter((h) => h.pairedWith && h.side === "put").map((put) => {
                  const call = l.holdings.find((h) => h.id === put.pairedWith);
                  if (!call) return null;
                  const sub = L.slots.get(put.id) ?? 0;
                  const xx = left + 3 + sub * subW + 7;
                  return <line key={`c-${put.id}`} x1={xx} x2={xx} y1={y(call.short)} y2={y(put.short)} stroke="var(--held)" strokeDasharray="1 3" strokeWidth={1.5} />;
                })}
                {[...l.holdings, ...l.candidates].map((s) => {
                  const sub = L.slots.get(s.id) ?? 0;
                  const bx = left + 3 + sub * subW + 1;
                  const tone = worstTone(s.alerts, entryStyle);
                  const paint = barPaint(s);
                  const top = y(hi(s)), bot = y(lo(s));
                  const h = Math.max(6, bot - top);
                  const sel = selected === s.id;
                  const glyphY = s.side === "call" || s.long === null ? top - 10 : bot + 10;
                  return (
                    <g key={s.id} className="bar" role="button" tabIndex={0} aria-label={describe(s, book.spot)}
                       onClick={() => onSelect(s.id)}>
                      {/* 44px-tall hit area around even a 22px bar */}
                      <rect x={bx - 4} y={Math.min(top, y(s.short)) - 12} width={subW} height={Math.max(44, h + 24)} fill="transparent" />
                      {sel && <rect x={bx - 4} y={top - 6} width={20} height={h + 12} rx={6} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                      {s.long === null ? (
                        <path d={`M${bx + 6} ${y(s.short) - 7} l7 7 l-7 7 l-7 -7 z`} fill={paint.fill} stroke={paint.stroke} strokeWidth={1.5} />
                      ) : (
                        <rect x={bx} y={top} width={12} height={h} rx={3} fill={paint.fill} stroke={paint.stroke}
                              strokeWidth={s.kind === "holding" ? 1.8 : 1.3} strokeDasharray={paint.dash} />
                      )}
                      <rect x={bx - 3} y={y(s.short) - 1.5} width={18} height={3} rx={1} fill={TONE_COLOR[tone]} />
                      {s.shortDelta !== null && (
                        <text x={bx + 17} y={y(s.short) + 4} fontSize={10.5} fontWeight={650}
                              fill={tone === "neutral" ? "var(--ink-2)" : TONE_COLOR[tone]}>{fmtDeltaShort(s.shortDelta)}</text>
                      )}
                      {s.long !== null && <rect x={bx + 13.5} y={top} width={2.5} height={h * maxFill(s)} rx={1}
                                                fill={tone === "neutral" ? "var(--ink-3)" : TONE_COLOR[tone]} />}
                      <Glyph x={bx + 6} y={glyphY} tone={tone} />
                    </g>
                  );
                })}
              </g>
            );
          })}
          <line x1={AXIS - 4} x2={width} y1={sy} y2={sy} stroke="var(--spot)" strokeWidth={1.6} />
          <rect x={2} y={sy - 10} width={AXIS - 6} height={20} rx={10} fill="var(--spot)" />
          <text x={(AXIS - 4) / 2 + 1} y={sy + 4} textAnchor="middle" fontSize={11} fontWeight={800} fill="var(--bg)">{Math.round(book.spot)}</text>
        </svg>
      </div>
    </div>
  );
}
