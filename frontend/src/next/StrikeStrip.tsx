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
import { DASH } from "../format";
import { deltaWords, distanceWords, scaleOf, strikeName, type Strip } from "./strip";
import "./StrikeStrip.css";

export function StrikeStrip({ strip, compact = false }: { strip: Strip; compact?: boolean }) {
  // nothing to place: a spread whose legs the service did not describe
  if (strip.shorts.length === 0 && strip.longs.length === 0) return null;
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
          {compact ? null : <span className="nxs-l"><b>{k.strike}</b><i>{deltaWords(k.delta)}</i></span>}
        </span>
      ))}
      {strip.spx !== null ? <span className="nxs-spx" style={{ left: pct(at(strip.spx)) }} /> : null}
    </div>
  );
  if (compact) return <span className="nxs" data-compact="">{scale}</span>;
  return (
    <figure className="nxs" aria-label="strike strip">
      {scale}
      <figcaption className="nxs-words">
        <span className="nxs-spx-words">
          {strip.spx !== null ? `SPX ${strip.spx.toFixed(2)}` : `SPX ${DASH} ${strip.reason ?? "no price"}`}
        </span>
        {strip.shorts.map((k) => (
          <span key={k.code}>
            {`${strikeName(k)} ${deltaWords(k.delta)}${strip.spx === null ? "" : ` · ${distanceWords(k)}`}`}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
