/** The payoff at expiry, drawn (#291; on visx with a crosshair readout since #396, ADR 0023): a
 *  held spread's at its Entry, and a watched spread's at its current value, in the desk's inspector
 *  and the phone's detail sheet, and a spread nobody has saved yet in the add form's preview.
 *
 *  AT EXPIRY ONLY. No T+0 curve, no "today" line and no probability: the service has no pricing
 *  model, and ADR 0023 says never to draw what the system does not know. So SPX's marker is a
 *  vertical line and NOT a dot on the curve — a dot would read as "what it is worth now", which an
 *  expiry curve does not say. Its price is the DERIVED one (ADR 0024), never a Reference's.
 *
 *  The figures are the service's (`payoffAtExpiry`, served by `/positions/{id}/payoff` and
 *  `POST /positions/payoff`), each leg's quantity in them (#351); `payoffChart.ts` joins their
 *  corners and adds no maths. What is drawn, matching the burndown (`BurndownChart.tsx`):
 *  - the curve, the gain above zero and the loss below it shaded in the OUTCOME colours (visx's
 *    `Threshold`), and the zero line;
 *  - each strike a dashed rule, its legs named beneath it through `shared/Legs` in their type's
 *    colour (#391), joined where they would overlap;
 *  - each breakeven a dot on the zero line, labelled with its price;
 *  - the maximum profit and loss as labelled rules where they are finite, and at the drawing's edge,
 *    with an arrow, where the window does not reach them;
 *  - SPX's derived price as a vertical marker.
 *
 *  **The crosshair** reads out the P&L at expiry at any SPX price in the window, with the price and
 *  its distance from SPX's: in points per contract, and in money across the contracts held where
 *  the valuation served a contract size — masked under privacy, which keeps the points, as they
 *  say no count. A mouse points by moving, and snaps onto a strike, a breakeven or SPX within a few
 *  pixels so each can be read exactly. A finger chooses by a tap (a second tap, a tap outside the
 *  chart or a scroll lets go) or by a drag gone sideways, which scrubs, while a vertical one still
 *  scrolls the page (`touch-action: pan-y`). The arrow keys step along SPX through every step and
 *  every marked price, starting from SPX's; Home and End go to the window's ends; Escape lets go,
 *  and with nothing chosen is left to the page, whose inspector it closes. ONE tab stop. The
 *  tooltip is for the eye and hidden from a screen reader; the line beneath says the same in full
 *  once a key or a finger has CHOSEN a price, and is what is announced (a polite live region) —
 *  never as a mouse merely passes over.
 *
 *  visx for the scale and the shapes only (`@visx/scale`, `shape`, `threshold`, already in the
 *  bundle for the burndown); the labels and the tooltip are placed here, for the reasons
 *  `BurndownChart.tsx` gives. Its width is MEASURED rather than scaled from a viewBox, so text
 *  stays its own size in a 272px inspector and on a 390px phone alike.
 */
import { spx as spxText } from "./shared/numbers";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { Threshold } from "@visx/threshold";

import { fetchDraftPayoff, fetchPayoff, type DraftPayoff, type Entry, type Holding, type Payoff } from "./shared/api";
import { heldLeg, legText, shortFirst, signedLeg, type WrittenLeg } from "./shared/format";
import { SvgLegSpan } from "./shared/Legs";
import { fieldWords } from "./needs";
import { textWidth, tipPlace } from "./burndown";
import {
  labelRows, level, payoffWindow, pnlAt, pnlWords, priceStops, readout, shortWords, snapPrice, stepPrice,
  type PayoffUnit,
} from "./payoffChart";
import { newYorkWeekdayWhen } from "./session";
import { closeWords, payoffAt } from "./watchhistory";
import "./payoff.css";

/** One spread nobody holds: one contract, in points, and no money to hide. */
const POINTS: PayoffUnit = { contracts: 1, size: null, hidden: false, perContract: false };

interface PayoffState {
  /** the payoff on screen, and the key it was asked for under */
  payoff?: Payoff;
  shown?: string;
  error?: string;
  /** a newer key is being asked for, and the payoff on screen is the last one */
  updating: boolean;
}

/** The served payoff for `key`, asked for again only when the key changes — never on a timer: none
 *  of it moves with the market. A watched spread's key carries its value, so a poll that moves the
 *  value asks once more (one POST, no Provider); until that answers, the LAST payoff stays on
 *  screen, marked as updating, rather than blanking to "drawing…" once a poll. It is kept only for
 *  the same `subject`: another holding's curve is never shown as this one's. A null key asks for
 *  nothing. */
function usePayoff(subject: string, key: string | null, load: () => Promise<Payoff>): PayoffState | null {
  const [state, setState] = useState<{ subject: string; key: string; payoff?: Payoff; shown?: string; error?: string } | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState((prev) => (prev?.subject === subject && prev.payoff
      ? { subject, key, payoff: prev.payoff, shown: prev.shown }
      : { subject, key }));
    loader.current().then(
      (payoff) => { if (live) setState({ subject, key, payoff, shown: key }); },
      (err: unknown) => {
        if (live) setState({ subject, key, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { live = false; };
  }, [subject, key]);
  if (key === null || state?.subject !== subject) return null;
  // a render between the key changing and the effect running still shows the last payoff
  return { payoff: state.payoff, shown: state.shown, error: state.key === key ? state.error : undefined,
    updating: state.shown !== key };
}

/** The fields whose combo value is a PRICE, and so a credit a curve can be drawn at. Only the mid:
 *  the service takes any field a rule names, and a combo's value is the signed sum of THAT field
 *  (`monitorValue`) — on delta, gamma, theta or vega it is no credit at all. A signed sum of bids or
 *  of asks is a price but not what the spread sells for (that is short bids less long asks), so
 *  the mid, which every figure on this page already prices by, is the one value it is honest to
 *  draw at. */
const PRICE_FIELDS: ReadonlySet<string> = new Set(["mid_price"]);

/** A holding's payoff, at the Entry it was taken for, over the contracts held. */
export function HoldingPayoff({ holding, privacy }: { holding: Holding; privacy: boolean }) {
  const { id, entry, contracts } = holding;
  const state = usePayoff(id, entry === null ? null : `${id}|${entry}|${contracts}`, () => fetchPayoff(id));
  // points per contract, and money across the contracts held at the size the valuation served
  const unit: PayoffUnit = { contracts, size: holding.contract_size, hidden: privacy, perContract: true };
  return (
    <PayoffFigure state={state} unit={unit} legs={holding.legs.map(heldLeg)}
                  spx={holding.spx} spxReason={holding.spx_reason}
                  blank={entry === null ? "no Entry recorded, so there is no credit to draw it at" : null} />
  );
}

/** A watched spread's payoff. It has no Entry, so it is drawn at a value of its own as the credit,
 *  and says which: its CURRENT value in the session, and outside it — or where the rule watches no
 *  price, a spread watched on its delta — its last close, said with its time (#402, `payoffAt`).
 *  Minus is short (ADR 0013) and a combo's value is the signed sum under its signs, so what it would
 *  be sold for is the negative of its value. One spread, in points: nobody holds it, so there is no
 *  count and no size to make money of. */
export function WatchedPayoff({ entry, session }: { entry: Entry; session: boolean }) {
  // live in the session, at its last close outside it — or where the rule watches no price (#402)
  const at = payoffAt(entry, session, PRICE_FIELDS.has(entry.field));
  const value = at.value;
  const draft: DraftPayoff | null = value === null || !entry.legs ? null : {
    legs: entry.legs.map((l) => ({
      side: l.sign < 0 ? "short" : "long", option_type: l.option_type as "CALL" | "PUT", strike: l.strike,
      // a quantity is drawn as the rule values it (#351): a butterfly's middle twice over
      ...(l.qty === undefined || l.qty === 1 ? {} : { qty: l.qty }),
    })),
    // to the cent, so a value that moved by float noise alone is not asked for again
    entry: Number((-value).toFixed(2)) || 0,
    contracts: 1,
  };
  const key = draft === null ? null : JSON.stringify(draft);
  const state = usePayoff(entry.id, key, () => fetchDraftPayoff(draft!));
  // the label says the value the curve ON SCREEN was drawn at, which while updating is the last one
  const credit = state?.shown ? (JSON.parse(state.shown) as DraftPayoff).entry : draft?.entry ?? 0;
  const blank = "blank" in at
    ? (PRICE_FIELDS.has(entry.field) ? at.blank
      : `watches the ${fieldWords(entry.field, true)}, which is no price to draw it at, and no close is recorded`)
    : draft === null ? "no current value to draw it at" : null;
  const where = "close" in at
    ? `${closeWords(at.close)}${(() => { const when = newYorkWeekdayWhen(at.close.observed_at); return when ? `, ${when}` : ""; })()}`
    : "its current value";
  return (
    <PayoffFigure state={state} unit={POINTS} legs={shownLegs(state) ?? (entry.legs ?? []).map(signedLeg)}
                  spx={entry.spx} spxReason={entry.spx_reason} blank={blank}
                  note={`no Entry: drawn at ${where}, ${Math.abs(credit).toFixed(2)}, as the ${credit < 0 ? "debit" : "credit"}`} />
  );
}

/** The payoff of a spread nobody has saved yet: the add form's preview (#293), beside the legs it
 *  draws, so a leg on the wrong side shows as the wrong curve before anything is saved (ADR 0023).
 *  Asked for again as the legs change, a moment after the typing stops — one POST, no Provider —
 *  with the last curve kept on screen, marked as updating, until the next one arrives. Per
 *  contract and in points (`add.ts`, `previewOf`), so it says nothing privacy hides. */
export function DraftPreview({ subject, draft, blank, note, spx, spxReason, onDrawn }: {
  /** which draft spread this is, so another one's curve is never shown as this one's */
  subject: string;
  draft: DraftPayoff | null;
  /** why nothing is drawn while `draft` is null */
  blank: string;
  note?: string;
  spx: number | null;
  spxReason: string | null;
  /** told the payoff on screen and the draft it was served for (its JSON), or null when none is:
   *  the add form reads what the legs can cost to close from it rather than working it out again */
  onDrawn?: (drawn: { key: string; payoff: Payoff } | null) => void;
}) {
  const raw = draft === null ? null : JSON.stringify(draft);
  const key = useSettled(raw, 200);
  const asked = usePayoff(subject, key, () => fetchDraftPayoff(JSON.parse(key!) as DraftPayoff));
  const told = useRef(onDrawn);
  told.current = onDrawn;
  const payoff = asked?.payoff ?? null;
  const shown = asked?.shown ?? null;
  useEffect(() => {
    told.current?.(payoff && shown !== null ? { key: shown, payoff } : null);
  }, [payoff, shown]);
  // updating from the moment the draft changes, not from when the pause ends: a side flipped a
  // moment ago must not leave the old curve standing as current
  const state = asked && raw !== null && asked.shown !== raw ? { ...asked, updating: true } : asked;
  return (
    <PayoffFigure state={state} unit={POINTS} legs={shownLegs(asked) ?? []} spx={spx} spxReason={spxReason}
                  blank={draft === null ? blank : null} note={note} />
  );
}

/** The legs of the draft whose curve is on screen — which, while a newer one is asked for, is the
 *  last one — so the strikes named under a curve are always that curve's. */
function shownLegs(state: PayoffState | null): WrittenLeg[] | null {
  return state?.shown ? (JSON.parse(state.shown) as DraftPayoff).legs.map(heldLeg) : null;
}

/** `value`, once it has stopped changing for `ms`: a strike typed digit by digit asks once. A
 *  null is passed at once, so a draft that stops being drawable says so straight away. */
function useSettled<T>(value: T | null, ms: number): T | null {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === null) { setSettled(null); return; }
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return value === null ? null : settled;
}

function PayoffFigure({ state, unit, legs, spx, spxReason, blank, note }: {
  state: PayoffState | null; unit: PayoffUnit; legs: WrittenLeg[]; spx: number | null; spxReason: string | null;
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
            <Chart payoff={state.payoff} unit={unit} legs={legs} spx={spx} />
            {spx === null ? <p className="nx-meta nx-payoff-spx">{`SPX — ${spxReason ?? "no price"}`}</p>
              // a price that is not current says so (#416): the marker is the last close's level
              : spxReason ? <p className="nx-meta nx-payoff-spx" data-stale="">{`SPX ${spxText(spx)} (${spxReason})`}</p> : null}
            <dl className="nx-payoff-kv">
              <div><dt>max profit</dt><dd>{state.payoff.max_profit === null ? "no ceiling" : pnlWords(state.payoff.max_profit, unit)}</dd></div>
              <div><dt>max loss</dt><dd>{state.payoff.max_loss === null ? "no floor" : pnlWords(state.payoff.max_loss, unit)}</dd></div>
              <div><dt>breakevens</dt><dd>{state.payoff.breakevens.length === 0 ? "none" : state.payoff.breakevens.map(level).join(" · ")}</dd></div>
            </dl>
          </>
        );
  return (
    <section className="nx-payoff" role="group" aria-label="payoff at expiry" aria-busy={state?.updating && state.payoff ? true : undefined}
             data-updating={blank === null && state?.updating && state.payoff ? "" : undefined}>
      <h4 className="nx-payoff-h">Payoff at expiry</h4>
      {body}
    </section>
  );
}

/** The plot's height, and the margins: above it for SPX's label, below it a row for each line of
 *  labels — the legs, then the breakevens — so a drawing with more of them grows rather than
 *  crowding them. */
const PLOT = 146, T = 18, L = 8, R = 8, ROW = 12;
/** Room inside the plot above the highest P&L and below the lowest, for their labels. */
const ROOM = 14;
/** The tooltip's width, or the chart's where that is narrower. */
const TIP_W = 184;
/** How far a finger must move sideways, and more sideways than up or down, before it scrubs. */
const SCRUB = 10;
/** How near, in pixels, a pointer must come to a strike, a breakeven or SPX to land on it. */
const REACH = 6;

function Chart({ payoff, unit, legs, spx }: { payoff: Payoff; unit: PayoffUnit; legs: WrittenLeg[]; spx: number | null }) {
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
  const id = useId().replace(/[^\w-]/g, "");
  const [pointed, setPointed] = useState<number | null>(null);
  // whether the price was CHOSEN — by a key or a finger — rather than passed over by a mouse: only
  // a choice is announced, or a mouse crossing the chart would speak a sentence at every step
  const [chosen, setChosen] = useState(false);
  const tipBox = useRef<HTMLDivElement>(null);
  const [tipH, setTipH] = useState(0);
  useLayoutEffect(() => {
    const h = tipBox.current?.offsetHeight;
    if (h && h !== tipH) setTipH(h);
  });

  const win = payoffWindow(payoff, spx);
  const { d0, d1 } = win;
  const strikes = payoff.at_strikes.map((a) => a.spx);
  const corners = [d0, ...strikes.filter((k) => k > d0 && k < d1), d1].map((s) => ({ s, v: pnlAt(payoff, s) }));
  const top = Math.max(...corners.map((c) => c.v), 0), bottom = Math.min(...corners.map((c) => c.v), 0);
  const x = scaleLinear<number>({ domain: [d0, d1], range: [L, W - R] });
  // each strike's legs named beneath it, and each breakeven's price, joined where they would overlap
  const legLabels = labelRows([...legs].sort((a, b) => a.strike - b.strike)
    .filter((l) => l.strike >= d0 && l.strike <= d1)
    // a little wider than plain figures: a short leg is drawn bold
    .map((l) => ({ x: x(l.strike), w: textWidth(legText(l, "signs")) * 1.1, leg: l })), 6, 2, W - 2);
  const beLabels = labelRows(payoff.breakevens.map((b) => ({ x: x(b), w: textWidth(`BE ${level(b)}`), b })), 6, 2, W - 2);
  /** A label pressed against an edge is anchored TO that edge, so it never depends on how good the
   *  estimate of its width was. */
  const anchored = (c: { x: number; w: number }) => (c.x - c.w / 2 <= 2.5 ? { x: 2, textAnchor: "start" as const }
    : c.x + c.w / 2 >= W - 2.5 ? { x: W - 2, textAnchor: "end" as const } : { x: c.x, textAnchor: "middle" as const });
  const legRows = legLabels.reduce((n, c) => Math.max(n, c.row + 1), 0);
  const rows = legRows + beLabels.reduce((n, c) => Math.max(n, c.row + 1), 0);
  const B = ROW * Math.max(rows, 1) + 5, H = T + PLOT + B;
  /** Where the `row`th line of labels under the plot sits. */
  const rowY = (row: number) => H - B + 13 + ROW * row;
  const y = scaleLinear<number>({ domain: [bottom, top === bottom ? bottom + 1 : top], range: [H - B - ROOM, T + ROOM] });
  const marks = [...strikes, ...payoff.breakevens, ...(spx === null ? [] : [spx])];
  const stops = priceStops(win, marks);

  // the price chosen, while it is still inside the window drawn: a new draft may have moved it
  const at = pointed !== null && pointed >= d0 && pointed <= d1 ? pointed : null;
  const priceAt = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // the drawing is its measured width, but should the box ever be scaled the pointer is not
    const px = (e.clientX - r.left) * (r.width > 0 ? W / r.width : 1);
    return snapPrice(x.invert(px), marks, win, (REACH * (d1 - d0)) / Math.max(1, W - L - R));
  };
  const pick = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>, choice: boolean) => {
    setPointed(priceAt(e));
    setChosen(choice);
  };
  // A mouse points by moving. A finger chooses only by a TAP, or by a drag gone sideways: never on
  // touching down, which a vertical scroll that starts on the chart does too
  const kind = useRef("mouse");
  const touch = useRef<{ x0: number; y0: number; scrubbing: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    kind.current = e.pointerType;
    if (e.pointerType === "mouse") pick(e, false);
    else touch.current = { x0: e.clientX, y0: e.clientY, scrubbing: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse") { pick(e, false); return; }
    const t = touch.current;
    if (!t) return;
    const [dx, dy] = [Math.abs(e.clientX - t.x0), Math.abs(e.clientY - t.y0)];
    if (!t.scrubbing && (dx < SCRUB || dx <= dy)) return;
    t.scrubbing = true;
    pick(e, true);
  };
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const t = touch.current;
    touch.current = null;
    if (kind.current === "mouse") { pick(e, false); return; }
    // a scrub ends on the price it reached; a tap chooses one, or lets go of the one chosen
    if (t?.scrubbing) return;
    const price = priceAt(e);
    setPointed(price === at ? null : price);
    setChosen(true);
  };
  // the page took the touch — a scroll — so nothing the finger did chooses a price
  const onPointerCancel = () => { touch.current = null; setPointed(null); };
  useEffect(() => {
    if (pointed === null) return;
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setPointed(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [pointed]);
  const onKey = (e: React.KeyboardEvent) => {
    const next = stepPrice(e.key, at, stops, spx);
    if (next === undefined) return;
    e.preventDefault();
    setPointed(next === "clear" ? null : next);
    setChosen(true);
  };

  const said = at === null ? null : readout(at, payoff, unit, spx);
  const pnl = at === null ? 0 : pnlAt(payoff, at);
  const tip = said === null ? null : (() => {
    const tipW = Math.min(TIP_W, W);
    return { tipW, ...tipPlace({ x: x(at!), y: y(pnl), W, H, tipW, tipH }) };
  })();

  // the maximums, where finite: on their rule inside the window's figures, its label above a
  // profit's and below a loss's; else at the plot's edge with an arrow, and the label INSIDE the plot
  // (under a ▲, over a ▼), so it lands on neither SPX's label in the margin over the plot nor the
  // legs named in the margin under it
  const maxima = ([["profit", payoff.max_profit], ["loss", payoff.max_loss]] as const)
    .filter((m): m is readonly ["profit" | "loss", number] => m[1] !== null)
    .filter(([kind, v]) => kind === "profit" || v !== payoff.max_profit)
    .map(([kind, v]) => {
      const off = v > top + 1e-9 ? "above" : v < bottom - 1e-9 ? "below" : null;
      const at = off === "above" ? T : off === "below" ? H - B : y(v);
      const labelY = off === "above" ? at + 12 : off === "below" ? at - 4 : kind === "profit" ? at - 4 : at + 12;
      return { kind, v, off, at, labelY, words: `${off === "above" ? "▲ " : off === "below" ? "▼ " : ""}max ${kind} ${shortWords(v, unit)}` };
    });
  const spxX = spx === null ? null : x(spx);

  return (
    <>
      <div className="nx-payoff-chart" ref={box} role="group" tabIndex={0} onKeyDown={onKey}
           aria-label={`payoff at expiry by SPX price, ${level(d0)} to ${level(d1)}: arrow keys move along SPX`}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"
             onPointerMove={onPointerMove} onPointerDown={onPointerDown} onClick={onClick}
             onPointerCancel={onPointerCancel}
             onPointerLeave={(e) => { if (e.pointerType === "mouse") setPointed(null); }}>
          <Threshold id={`${id}-pnl`} data={corners} x={(c) => x(c.s)} y0={(c) => y(c.v)} y1={() => y(0)}
                     clipAboveTo={T} clipBelowTo={H - B}
                     aboveAreaProps={{ className: "nx-payoff-gain" }} belowAreaProps={{ className: "nx-payoff-loss" }} />
          <line data-zero="" className="nx-payoff-zero" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
          {strikes.filter((k) => k >= d0 && k <= d1).map((k) => (
            <line key={k} data-strike={k} className="nx-payoff-strike" x1={x(k)} x2={x(k)} y1={T} y2={H - B} />
          ))}
          {maxima.map((m) => (
            <g key={m.kind} className="nx-payoff-max" data-kind={m.kind} data-off={m.off ?? undefined}>
              <line x1={L} x2={W - R} y1={m.at} y2={m.at} />
              <text data-max={m.kind} x={W - R} y={m.labelY} textAnchor="end">{m.words}</text>
            </g>
          ))}
          <LinePath data-curve="" className="nx-payoff-curve" data={corners} x={(c) => x(c.s)} y={(c) => y(c.v)} />
          {payoff.breakevens.map((b) => (
            <g key={b} data-breakeven={b}>
              <circle cx={x(b)} cy={y(0)} r={2.75} className="nx-payoff-be" />
            </g>
          ))}
          {legLabels.map((c) => (
            <text key={`${c.row}:${c.items.map((i) => legText(i.leg, "signs")).join()}`} data-strikes="" {...anchored(c)} y={rowY(c.row)}>
              {/* the legs one label joins, short first as everywhere they are written (2026-11-16) */}
              {shortFirst(c.items.map((i) => i.leg)).map((leg, n) => (
                <Fragment key={n}>{n > 0 ? " " : null}<SvgLegSpan leg={leg} /></Fragment>
              ))}
            </text>
          ))}
          {beLabels.map((c) => (
            <text key={c.items.map((i) => i.b).join()} data-breakeven-label="" className="nx-payoff-be-label"
                  {...anchored(c)} y={rowY(legRows + c.row)}>
              {`BE ${c.items.map((i) => level(i.b)).join(" · ")}`}
            </text>
          ))}
          {spxX === null ? null : (
            <g data-marker="spx" className="nx-payoff-marker">
              <line x1={spxX} x2={spxX} y1={T - 4} y2={H - B} />
              <text x={spxX > W * 0.6 ? spxX - 4 : spxX + 4} y={T - 6}
                    textAnchor={spxX > W * 0.6 ? "end" : "start"}>{`SPX ${spxText(spx!)}`}</text>
            </g>
          )}
          {at === null ? null : (
            <g data-crosshair={at} className="nx-payoff-cross" pointerEvents="none">
              <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} />
              <line x1={L} x2={W - R} y1={y(pnl)} y2={y(pnl)} />
              <circle cx={x(at)} cy={y(pnl)} r={4.75} data-outcome={pnl > 0 ? "gain" : pnl < 0 ? "loss" : undefined} />
            </g>
          )}
        </svg>
        {tip === null || said === null ? null : (
          <div className="nx-payoff-tip" ref={tipBox} data-tip="" aria-hidden="true"
               style={{ left: tip.left, top: tip.top, width: tip.tipW }}>
            <div className="nx-payoff-tip-h">{said.price}</div>
            {said.away === null ? null : <div className="nx-payoff-tip-away">{said.away}</div>}
            <div className="nx-payoff-tip-pnl" data-outcome={pnl > 0 ? "gain" : pnl < 0 ? "loss" : undefined}>{said.pnl}</div>
          </div>
        )}
      </div>
      {/* a polite live region, announced when a key or a finger chooses a price and never as a mouse
          passes over (its figures are the tooltip's). A live region rather than `role="status"`: the
          inspector's `status` lines are the holding's actions' and the burndown's, and the tests and
          tools that find "the status" of a holding's actions by role would find two */}
      <p className="nx-payoff-said" aria-live="polite" aria-atomic="true" data-said="">
        {chosen && said ? said.words : "point at a price, or use the arrow keys, for the P&L at expiry there"}
      </p>
    </>
  );
}
