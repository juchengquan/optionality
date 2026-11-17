/** A rule's every figure, drawn in whichever arrangement asks (#332): the desk's inspector passes
 *  its key-value grid's class, the phone's sheet its facts grid's, so each looks like the figures
 *  around it. What the list says is `rulefigures.ts`, one list for both. */
import type { Entry } from "./shared/api";
import { ruleFigures, wholeMissing } from "./quotefigures";
import "./rulefigures.css";

export function RuleFigures({ entry, className, held = entry.held }: {
  entry: Entry; className: string;
  /** whether the row is drawn as something held (`ruleFigures`): not a spread drawn in the
   *  watchlist because it only partly overlaps a holding (#346) */
  held?: boolean;
}) {
  // no quote at all: one reason, rather than ten dashes each repeating it
  const missing = wholeMissing(entry);
  const figures = ruleFigures(entry, held);
  const none = missing === null ? null
    : <p className="nx-meta nx-figures-missing" data-figures-missing="">{`no figures — ${missing}`}</p>;
  if (figures.length === 0) return none;
  // a reason two or more dashes share is said once, under the list, naming the figures it is for —
  // "a leg has no figure, and no sum is taken from part of them" was said four times in a row
  // under a spread's Δ Γ Θ ν (2026-11-17); a reason only one dash has stays beside it
  const shared = [...new Set(figures.map((f) => f.why))]
    .filter((why): why is string => why !== null && figures.filter((f) => f.why === why).length > 1);
  return (
    <>
    {/* out of the session a quote-less watchlist row still says its last in-session price */}
    {none}
    <dl className={`${className} nx-figures`} role="group" aria-label="figures">
      {figures.map((f) => (
        <div key={f.key} data-figure={f.key} data-detail={f.detail ? "" : undefined}>
          <dt>{f.label}</dt>
          {/* the reason sits under its dash, in words a finger can read: a title is for a pointer */}
          <dd>{f.text}{f.why === null || shared.includes(f.why) ? null : <>{" "}<span className="nx-figure-why">{f.why}</span></>}</dd>
        </div>
      ))}
    </dl>
    {shared.map((why) => (
      <p key={why} className="nx-meta nx-figures-why" data-figures-why="">
        {`${figures.filter((f) => f.why === why).map((f) => f.label).join(" ")}: ${why}`}
      </p>
    ))}
    </>
  );
}
