/** What a leg IS, drawn (#391; ADR 0023's fourth colour family). Every place on the page that writes
 *  a leg draws it here, so all of them colour it alike: its type letter (or word) in its type's
 *  colour — CALL teal, PUT orange — and a short leg in bold. The side is weight and sign, never a
 *  hue. The characters are exactly `legText`'s, so the letter and the sign stay and the colour is
 *  never the only signal; the colours are `next.css`'s `--call` and `--put`. */
import { Fragment } from "react";

import { legParts, type LegForm, type WrittenLeg } from "./format";

const sideOf = (l: WrittenLeg) => (l.short === undefined ? undefined : l.short ? "short" : "long");

/** One leg, as `legText` writes it. */
export function Leg({ leg, form = "signs" }: { leg: WrittenLeg; form?: LegForm }) {
  return <Drawn side={sideOf(leg)} type={leg.option_type} parts={legParts(leg, form)} />;
}

function Drawn({ side, type, parts: [before, letter, after] }: {
  side: string | undefined; type: string; parts: [string, string, string];
}) {
  return (
    <span className="nx-leg" data-side={side}>
      {before}<span className="nx-leg-t" data-type={type}>{letter}</span>{after}
    </span>
  );
}

/** Legs as the book writes them, a space between each. */
export function Legs({ legs, form = "signs" }: { legs: readonly WrittenLeg[]; form?: LegForm }) {
  return (
    <>
      {legs.map((l, i) => (
        <Fragment key={`${i}:${l.option_type}${l.strike}`}>{i > 0 ? " " : null}<Leg leg={l} form={form} /></Fragment>
      ))}
    </>
  );
}

/** One leg as a chart's text, its type in a `tspan`. */
export function SvgLeg({ leg, form = "minus", ...at }: {
  leg: WrittenLeg; form?: LegForm; x: number; y: number; textAnchor?: "start" | "middle" | "end";
}) {
  return <text {...at}><SvgLegSpan leg={leg} form={form} /></text>;
}

/** One leg inside a chart's text that says more than the leg, as the price map's label does. */
export function SvgLegSpan({ leg, form = "minus" }: { leg: WrittenLeg; form?: LegForm }) {
  const [before, type, after] = legParts(leg, form);
  return (
    <tspan className="nx-leg" data-side={sideOf(leg)}>
      {before}<tspan className="nx-leg-t" data-type={leg.option_type}>{type}</tspan>{after}
    </tspan>
  );
}

/** A side's sign before its words on the add form's side buttons (#391): "−" short, "+" long, as
 *  the book writes a leg. Drawn and said to nobody — the button's words are its name. */
export function SideSign({ side }: { side: "short" | "long" }) {
  return <span className="nx-sign" aria-hidden="true">{side === "short" ? "−" : "+"}</span>;
}
