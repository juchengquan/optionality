/** The strike strip (#297, ADR 0023): a spread's short and long strikes on one scale, SPX's
 *  derived price as a dot, each short strike's Δ on it, and how far SPX is from each short strike
 *  in points and σ. Drawn in both arrangements — the desk's rows and inspector, the phone's cards
 *  and sheet — from `strip.ts`, whose figures are all the service's.
 *
 *  Two sizes. Whole, the scale carries its labels and a caption says every figure in words, so
 *  the drawing itself is decoration to a screen reader. Compact, for a table row, it is the bare
 *  scale: the row says the distance beside it.
 *
 *  Plain HTML positioned in percentages rather than an SVG: the scale takes whatever width its box
 *  has, so the phone's 390px and the desk's inspector draw the same strip with nothing measured,
 *  and the scale's padding (`scaleOf`) keeps a label centred on the outermost mark inside the box —
 *  measured under the iPhone profile at a 24px text size.
 */
import type { Holding } from "./shared/api";
import { deltaWords, distanceWords, scaleOf, spxStripWords, stripDraws, stripOfHolding, type Strip } from "./strip";
import { Leg } from "./shared/Legs";
import "./StrikeStrip.css";

/** @param reasonSaid the book this strip sits in says why SPX is not current, once, under its
 *  heading (`SpxNote`): the strip marks its price with an asterisk instead of saying it again — the
 *  same sentence was on every card of the phone's book (2026-11-17). A detail's one strip says it. */
/** How near two short strikes may sit, in percent of the scale, before their labels would touch: a
 *  label is a strike over a Δ, about 7ch of 0.72rem, centred on its mark; at 358px and at a 24px
 *  text size two of them need about a quarter of the scale between their marks. */
const CROWDED_PCT = 25;

export function StrikeStrip({ strip, compact = false, reasonSaid = false }: { strip: Strip; compact?: boolean; reasonSaid?: boolean }) {
  // nothing to place: a spread whose legs the service did not describe
  if (!stripDraws(strip)) return null;
  const at = scaleOf(strip);
  // each short strike's wing runs to the long strike of its own type nearest it
  const wings = strip.shorts.flatMap((k) => {
    const longs = strip.longs.filter((l) => l.option_type === k.option_type);
    if (longs.length === 0) return [];
    const long = longs.reduce((a, b) => (Math.abs(b.strike - k.strike) < Math.abs(a.strike - k.strike) ? b : a));
    const [a, b] = [at(k.strike), at(long.strike)].sort((p, q) => p - q);
    return [{ key: `${k.code}`, left: a!, width: b! - a! }];
  });
  const pct = (x: number) => `${x.toFixed(2)}%`;
  // short strikes too close for their labels to sit apart — an iron fly's two at one strike, or
  // 8000P and 8050C with SPX far off (review of #423, at 358px): no label over them, and the line
  // under the scale says each one's strike and Δ, drawn, where otherwise it says the Δ to a reader only
  const crowded = strip.shorts.map((k) => at(k.strike)).sort((p, q) => p - q)
    .some((p, i, all) => i > 0 && p - all[i - 1]! < CROWDED_PCT);
  const scale = (
    <div className="nxs-scale" aria-hidden="true">
      <span className="nxs-line" />
      {wings.map((w) => <span key={w.key} className="nxs-wing" style={{ left: pct(w.left), width: pct(w.width) }} />)}
      {strip.longs.map((l, i) => (
        <span key={`l${i}`} className="nxs-k" data-side="long"
              style={{ left: pct(at(l.strike)) }}>
          {compact ? null : <span className="nxs-l">{l.strike}</span>}
        </span>
      ))}
      {strip.shorts.map((k) => (
        <span key={k.code} className="nxs-k" data-side="short"
              style={{ left: pct(at(k.strike)) }}>
          {compact || crowded ? null : <span className="nxs-l"><b>{k.strike}</b><i>{deltaWords(k.delta)}</i></span>}
        </span>
      ))}
      {strip.spx !== null
        ? <span className="nxs-spx" data-stale={strip.reason ? "" : undefined} style={{ left: pct(at(strip.spx)) }} /> : null}
    </div>
  );
  if (compact) return <span className="nxs" data-compact="">{scale}</span>;
  return (
    <figure className="nxs" aria-label="strike strip">
      {scale}
      <figcaption className="nxs-words">
        <span className="nxs-spx-words" data-stale={strip.spx !== null && strip.reason ? "" : undefined}>
          {reasonSaid && strip.reason
            ? <>{spxStripWords({ ...strip, reason: null }).replace(/ no price$/, "")}<span aria-hidden="true" data-spx-mark="">*</span></>
            : spxStripWords(strip)}
        </span>
        {/* each short strike's Δ is drawn on the scale, over its strike: said here to a reader only,
            to whom the scale is decoration (2026-11-17) — and with no SPX to measure from, the line
            has nothing else to say, so all of it is the reader's */}
        {strip.shorts.map((k) => (
          <span key={k.code} className={strip.spx === null && !crowded ? "sr-only" : undefined} data-short-words="">
            <Leg leg={{ short: true, option_type: k.option_type, strike: k.strike }} form="name" />
            <span className={crowded ? undefined : "sr-only"}>{` ${deltaWords(k.delta)}${strip.spx === null ? "" : " ·"}`}</span>
            {strip.spx === null ? "" : ` ${distanceWords(k)}`}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** A holding's strip, or nothing for a holding with no short leg (`stripOfHolding`). */
export function HoldingStrip({ holding, reasonSaid = false }: { holding: Holding; reasonSaid?: boolean }) {
  const strip = stripOfHolding(holding);
  return strip ? <StrikeStrip strip={strip} reasonSaid={reasonSaid} /> : null;
}

/** Why SPX is not current, said once for a book (2026-11-17): "* SPX: index not computed overnight
 *  — the last close's level", the asterisk each strip's price carries. Read by a screen reader once
 *  per view, where the strips' marks are hidden from it. */
export function SpxNote({ reasons, className }: { reasons: readonly string[]; className: string }) {
  return (
    <>
      {reasons.map((r) => <p key={r} className={`${className} nx-spx-note`} data-spx-note="">{`* SPX: ${r}`}</p>)}
    </>
  );
}
