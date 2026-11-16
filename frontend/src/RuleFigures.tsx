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
  return (
    <>
    {/* out of the session a quote-less watchlist row still says its last in-session price */}
    {none}
    <dl className={`${className} nx-figures`} role="group" aria-label="figures">
      {figures.map((f) => (
        <div key={f.key} data-figure={f.key} data-detail={f.detail ? "" : undefined}>
          <dt>{f.label}</dt>
          {/* the reason sits under its dash, in words a finger can read: a title is for a pointer */}
          <dd>{f.text}{f.why === null ? null : <>{" "}<span className="nx-figure-why">{f.why}</span></>}</dd>
        </div>
      ))}
    </dl>
    </>
  );
}
