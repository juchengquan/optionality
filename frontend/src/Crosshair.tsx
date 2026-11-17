/** The ONE crosshair a holding's history shares (#395): the burndown, the IV chart and "SPX against
 *  the strikes" each draw it on the day the other two do, and each says that day in its own readout.
 *
 *  - **One state**, held by `HoldingHistory`: the index of the stop pointed at (`historyDays.ts`'s
 *    `stopsOf` — every recorded day, then today's valuation), or none. Each panel moves it, and each
 *    draws from it; none keeps a day of its own.
 *  - **The same hands in every panel**, as the burndown had them (#360): a mouse points by moving
 *    and leaving a panel lets go; a finger chooses by a tap — a second tap, a scroll, or a tap
 *    outside EVERY panel lets go — or by a drag gone sideways, which scrubs, while a vertical one
 *    stays the page's (`touch-action: pan-y`). The arrows step a stop at a time, Home and End to
 *    the ends; Escape lets go of a day, and with none chosen is left to the page, whose inspector it
 *    closes. Each panel is ONE tab stop.
 *  - **One mapping of a DTE to an x** (`dayScale`): `span` at the shared left margin to 0 at the
 *    shared right one, so a day is at the same x in every panel (#298, #327).
 *  - **Each panel's readout** is a tooltip for the eye, placed by hand inside the panel
 *    (`tipPlace`, #360) and hidden from a screen reader; the panel's status line says it in full.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { scaleLinear } from "@visx/scale";

import { nearestDay, stepDay, tipPlace } from "./burndown";
import type { Stop } from "./historyDays";

/** The tooltip's width, or the panel's where that is narrower. */
const TIP_W = 192;
/** How far a finger must move sideways, and more sideways than up or down, before it scrubs: until
 *  then the page may yet take it as a scroll, and a scroll is never a choice of day. */
const SCRUB = 10;

/** The crosshair every panel of one holding's history shares. `plots` are the panels' boxes, so a
 *  tap outside all of them — and only that — lets go. */
export interface Cross {
  stops: Stop[];
  pointed: number | null;
  /** the stop pointed at, and the panel that moved it */
  point: (at: number | null, by: Panel) => void;
  plots: React.RefObject<Set<HTMLElement>>;
  /** the panel being driven — focused, pointed into, or the last to move the crosshair. Its status
   *  line alone is live: one key moves every panel, and a polite region each said it once per panel
   *  (#399's review) */
  driver: Panel;
  drive: (by: Panel) => void;
}

export type Panel = "burndown" | "iv" | "spx";

/** A panel's status line's `aria-live`: polite for the panel being driven, off for the others. */
export const liveOf = (cross: Cross, panel: Panel) => (cross.driver === panel ? "polite" : "off");

/** The margins every panel of a holding shares (#298). */
export interface Gutters {
  L: number;
  R: number;
}

/** A DTE's x in a panel `W` wide: the same in every panel, from the window's start at the left
 *  margin to expiry at the right. */
export const dayScale = (span: number, W: number, { L, R }: Gutters) =>
  scaleLinear<number>({ domain: [span, 0], range: [L, W - R] });

/** What the keys step through, for a panel's label: every recorded day, and the valuation after them. */
export function stepped(cross: Cross): string {
  const days = cross.stops.filter((s) => s.on !== null).length;
  return `${days} day${days === 1 ? "" : "s"}${days < cross.stops.length ? " and today's valuation" : ""}`;
}

/** The stop pointed at, or null: an index left over from another set of stops is none. */
export const pointedStop = (cross: Cross): Stop | null =>
  cross.pointed === null ? null : cross.stops[cross.pointed] ?? null;

/** A panel's hands on the shared crosshair: the pointer's on its SVG and the keys' on its box, which
 *  it registers so a tap inside it is not "outside". */
export function usePanel(cross: Cross, panel: Panel, box: React.RefObject<HTMLDivElement | null>, xs: number[],
                         W: number) {
  const { pointed, plots, drive } = cross;
  const point = (at: number | null) => cross.point(at, panel);
  useLayoutEffect(() => {
    const el = box.current;
    const set = plots.current;
    if (!el || !set) return;
    set.add(el);
    return () => { set.delete(el); };
  }, [box, plots]);
  /** The stop nearest a pointer, from where it is across the drawing. */
  const nearest = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // the drawing is its measured width, but should the box ever be scaled the pointer is not
    return nearestDay(xs, (e.clientX - r.left) * (r.width > 0 ? W / r.width : 1));
  };
  const pick = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const stop = nearest(e);
    if (stop !== null) point(stop);
  };
  // A mouse points by moving. A finger chooses a day only by a TAP, or by a drag that has gone
  // sideways (`SCRUB`): never on touching down, because a vertical scroll that starts on a panel
  // touches down too, and then left a day chosen for the life of the page (#360's review)
  const kind = useRef("mouse");
  const touch = useRef<{ x0: number; y0: number; scrubbing: boolean } | null>(null);
  const svg = {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      kind.current = e.pointerType;
      if (e.pointerType === "mouse") pick(e);
      else touch.current = { x0: e.clientX, y0: e.clientY, scrubbing: false };
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === "mouse") { pick(e); return; }
      const t = touch.current;
      if (!t) return;
      const [dx, dy] = [Math.abs(e.clientX - t.x0), Math.abs(e.clientY - t.y0)];
      if (!t.scrubbing && (dx < SCRUB || dx <= dy)) return;
      t.scrubbing = true;
      pick(e);
    },
    onClick: (e: React.MouseEvent<SVGSVGElement>) => {
      const t = touch.current;
      touch.current = null;
      if (kind.current === "mouse") { pick(e); return; }
      // a scrub ends on the day it reached; a tap chooses a day, or lets go of the one chosen
      if (t?.scrubbing) return;
      const stop = nearest(e);
      point(stop === pointed ? null : stop);
    },
    // the page took the touch — a scroll — so nothing the finger did chooses a day
    onPointerCancel: () => { touch.current = null; point(null); },
    onPointerLeave: (e: React.PointerEvent<SVGSVGElement>) => { if (e.pointerType === "mouse") point(null); },
    // the panel a pointer is in is the one being driven, before it moves anything
    onPointerEnter: () => drive(panel),
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = stepDay(e.key, pointed, xs.length);
    if (next === undefined) return;
    e.preventDefault();
    point(next === "clear" ? null : next);
  };
  // and so is the one focused, before a key moves anything: a region turned live in the same update
  // as its text changes may not be announced
  return { svg, onKeyDown, onFocus: () => drive(panel) };
}

/** A panel's readout: centred on its day, inside the panel, at the edge further from the points it
 *  describes (`tipPlace`) — `ys`, every point the crosshair meets on that day, none of which it may
 *  cover. Its height is measured before it is painted, never guessed. */
export function CrossTip({ x, ys, W, H, children }: { x: number; ys: number[]; W: number; H: number; children: ReactNode }) {
  const tip = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(0);
  useLayoutEffect(() => {
    const h = tip.current?.offsetHeight;
    if (h && h !== tipH) setTipH(h);
  });
  const tipW = Math.min(TIP_W, W);
  // the points as one span: its middle, and a radius reaching both ends with the point's own beyond
  const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  const { left, top } = tipPlace({ x, y: (lo + hi) / 2, W, H, tipW, tipH, r: (hi - lo) / 2 + 6 });
  return (
    <div className="nx-bd-tip" ref={tip} data-tip="" aria-hidden="true" style={{ left, top, width: tipW }}>
      {children}
    </div>
  );
}
