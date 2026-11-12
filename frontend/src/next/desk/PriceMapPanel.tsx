/** The price map, as a desk panel (#298, ADR 0023's prototype C): every spread on the book, held and
 *  watched, on ONE SPX axis, a lane per expiry, SPX's derived price as a line through all of them,
 *  and a ±1σ band per lane from the service's `one_sigma`. What is drawn is `pricemap.ts`'s; this
 *  only places it.
 *
 *  - **One selection.** Each spread is the table row of the same id: picking one here picks it in
 *    the table and opens the inspector, and the row picked in the table is the spread marked here.
 *    The desk owns the selection; this panel reads it and asks to change it.
 *  - **No SPX, no line.** Where the batch could not give SPX's price the panel says why, and draws
 *    neither the line nor any band — never a line at zero.
 *  - **Asks for nothing.** It draws what the page already polls (ADR 0010): no call of its own.
 *  - **No money.** Strikes, Δ, distances and σ; no $ figure and no contract count, so privacy has
 *    nothing here to hide.
 *  - **Labels never collide.** Each lane's spreads are slotted into rows by their footprint
 *    INCLUDING their labels (`slotRows`), and the plot is inset by a label's half-width, so a label
 *    on the outermost strike stays inside. Measured in the browser suite at 900, 1280 and 2560px.
 *
 *  Hand-written SVG at its measured width, as `Payoff.tsx` is.
 */
import { useLayoutEffect, useRef, useState } from "react";

import { shortDate } from "../../format";
import {
  bandWords, domainOf, slotRows, ticksOf, type MapSpread, type PriceMap,
} from "../pricemap";
import { distanceWords, nearest, strikeName } from "../strip";

/** Text widths at the map's 11px tabular figures, near enough to leave room. */
const textWidth = (text: string, px = 11) => text.length * px * 0.6;

/** "Δ−.21": the map's Δ, two places with a true minus — the strip and inspector show three. */
const deltaShort = (d: number | null) =>
  d === null ? "Δ—" : `Δ${d < 0 ? "−" : ""}${Math.abs(d).toFixed(2).replace(/^0/, "")}`;

const labelOf = (k: MapSpread["shorts"][number]) => `${strikeName(k)} ${deltaShort(k.delta)}`;

const TOP = 30, BOTTOM = 24, RIGHT = 8, PAD = 4, ROW = 46;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
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

/** A spread said in full, for a reader that does not see it: never a $ figure or a count. */
function spreadWords(s: MapSpread): string {
  const strikes = [...s.shorts.map((k) => `short ${strikeName(k)}`), ...s.longs.map((k) => `long ${strikeName(k)}`)];
  const k = nearest({ shorts: s.shorts, longs: s.longs, spx: null, reason: null });
  return [s.name, s.kind, strikes.join(" "), ...(k ? [distanceWords(k)] : [])].join(", ");
}

export function PriceMapPanel({ id, map, selected, onSelect }: {
  id: string; map: PriceMap; selected: string | null; onSelect: (id: string) => void;
}) {
  const [box, W] = useWidth();
  const [lo, hi] = domainOf(map);
  // the lanes' own labels: the expiry and DTE, and the band's width and whose IV it is
  const laneWords = map.lanes.map((l) => [`${shortDate(l.expiry)} · ${l.dte} DTE`, bandWords(l)] as const);
  const LEFT = Math.ceil(Math.max(80, ...laneWords.flatMap(([a, b]) => [textWidth(a, 12), textWidth(b, 10.5)]))) + 14;
  // the plot is inset by the widest strike label's half, so one on the outermost strike stays inside
  const inset = Math.ceil(Math.max(20, ...map.lanes.flatMap((l) => l.spreads.flatMap((s) => [
    ...s.shorts.map((k) => textWidth(labelOf(k)) / 2), ...s.longs.map((k) => textWidth(String(k.strike), 10) / 2),
  ])))) + 4;
  const [from, to] = [LEFT + inset, Math.max(LEFT + inset + 40, W - RIGHT - inset)];
  const x = (p: number) => from + ((p - lo) / (hi - lo)) * (to - from);

  // each spread's footprint: its bar and every label on it, so a row never holds two that touch
  const layout = map.lanes.map((lane) => {
    const footprints = lane.spreads.map((s): [number, number] => {
      const edges = [x(s.lo), x(s.hi),
        ...s.shorts.flatMap((k) => [x(k.strike) - textWidth(labelOf(k)) / 2, x(k.strike) + textWidth(labelOf(k)) / 2])];
      return [Math.min(...edges) - 6, Math.max(...edges) + 6];
    });
    const rows = slotRows(footprints);
    const count = Math.max(1, ...rows.map((r) => r + 1));
    return { lane, rows, height: Math.max(44, PAD * 2 + count * ROW) };
  });
  let y0 = TOP;
  const tops = layout.map((L) => { const t = y0; y0 += L.height; return t; });
  const H = y0 + BOTTOM;
  const ticks = ticksOf(lo, hi, Math.max(2, Math.floor((to - from) / 90)));
  const spx = map.spx;
  const spxLabel = spx === null ? null : `SPX ${spx.toFixed(2)}`;
  const spxLabelX = spx === null ? 0
    : Math.min(Math.max(x(spx), LEFT + textWidth(spxLabel!, 12) / 2), W - RIGHT - textWidth(spxLabel!, 12) / 2);
  const choose = (sid: string) => onSelect(sid);

  return (
    <section id={id} className="nxm" role="region" aria-label="price map">
      {spx === null ? <p className="nxm-why">{`SPX — ${map.reason ?? "no price"}`}</p> : null}
      {map.lanes.length === 0 ? <p className="nx-meta">no spread held or watched to place</p> : (
        <div className="nxm-box" ref={box}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group"
               aria-label="every spread on one SPX axis, a lane per expiry">
            {ticks.map((t) => (
              <g key={t} className="nxm-tick">
                <line x1={x(t)} x2={x(t)} y1={TOP} y2={H - BOTTOM} />
                <text x={x(t)} y={H - 7} textAnchor="middle">{t}</text>
              </g>
            ))}
            {layout.map(({ lane, rows, height }, i) => {
              const top = tops[i]!;
              const [when, band] = laneWords[i]!;
              return (
                <g key={lane.expiry} data-lane={lane.expiry} className="nxm-lane">
                  <rect className="nxm-lane-bg" data-even={i % 2 === 0 ? "" : undefined}
                        x={0} y={top} width={W} height={height} />
                  {lane.band ? (
                    <rect data-band={lane.band.strike.code} className="nxm-band"
                          x={Math.max(from - inset, x(lane.band.lo))} y={top + 2}
                          width={Math.max(0, Math.min(to + inset, x(lane.band.hi)) - Math.max(from - inset, x(lane.band.lo)))}
                          height={height - 4} />
                  ) : null}
                  <text className="nxm-when" x={8} y={top + 18}>{when}</text>
                  <text className="nxm-sigma" x={8} y={top + 34}>{band}</text>
                  {lane.spreads.map((s, j) => (
                    <Spread key={s.id} spread={s} x={x} top={top + PAD + rows[j]! * ROW}
                            selected={selected === s.id} onSelect={choose} />
                  ))}
                </g>
              );
            })}
            {spx !== null ? (
              <g data-spx-line="" className="nxm-spx">
                <line x1={x(spx)} x2={x(spx)} y1={TOP - 6} y2={H - BOTTOM} />
                <text x={spxLabelX} y={TOP - 10} textAnchor="middle">{spxLabel}</text>
              </g>
            ) : null}
          </svg>
        </div>
      )}
    </section>
  );
}

function Spread({ spread: s, x, top, selected, onSelect }: {
  spread: MapSpread; x: (p: number) => number; top: number; selected: boolean; onSelect: (id: string) => void;
}) {
  const a = x(s.lo);
  const w = Math.max(4, x(s.hi) - a);
  const barY = top + 16;
  // a short strike's label goes under the bar; one that would touch the label before it goes over
  const placed: { k: MapSpread["shorts"][number]; above: boolean }[] = [];
  for (const k of [...s.shorts].sort((p, q) => p.strike - q.strike)) {
    const prev = placed.filter((p) => !p.above).at(-1);
    const clash = prev !== undefined
      && x(k.strike) - textWidth(labelOf(k)) / 2 < x(prev.k.strike) + textWidth(labelOf(prev.k)) / 2 + 4;
    placed.push({ k, above: clash });
  }
  const words = spreadWords(s);
  return (
    <g data-spread={s.id} data-kind={s.kind} data-selected={selected ? "" : undefined} className="nxm-spread"
       role="button" tabIndex={0} aria-pressed={selected} aria-label={words}
       onClick={() => onSelect(s.id)}
       onKeyDown={(e) => {
         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); }
       }}>
      <title>{words}</title>
      {/* a generous target: the bar itself can be a few pixels wide */}
      <rect className="nxm-hit" x={a - 8} y={top} width={w + 16} height={ROW - 2} />
      {selected ? <rect className="nxm-sel" x={a - 5} y={barY - 5} width={w + 10} height={20} rx={4} /> : null}
      <rect className="nxm-bar" x={a} y={barY} width={w} height={10} rx={2} />
      {s.longs.map((k) => (
        <rect key={`l${k.option_type}${k.strike}`} className="nxm-long" x={x(k.strike) - 1} y={barY - 2} width={2} height={14} />
      ))}
      {s.shorts.map((k) => (
        <rect key={k.code} className="nxm-short" x={x(k.strike) - 1.5} y={barY - 4} width={3} height={18} />
      ))}
      {placed.map(({ k, above }) => (
        <text key={`t${k.code}`} className="nxm-label" x={x(k.strike)} y={above ? barY - 6 : barY + 24}
              textAnchor="middle">{labelOf(k)}</text>
      ))}
    </g>
  );
}
