/** A rule's every figure, drawn in whichever arrangement asks (#332): the desk's inspector passes
 *  its key-value grid's class, the phone's sheet its facts grid's, so each looks like the figures
 *  around it. What the list says is `rulefigures.ts`, one list for both. */
import type { Entry } from "../api";
import { ruleFigures, wholeMissing } from "./quotefigures";
import "./rulefigures.css";

export function RuleFigures({ entry, className }: { entry: Entry; className: string }) {
  // no quote at all: one reason, rather than ten dashes each repeating it
  const missing = wholeMissing(entry);
  if (missing !== null) return <p className="nx-meta nx-figures-missing" data-figures-missing="">{`no figures — ${missing}`}</p>;
  return (
    <dl className={`${className} nx-figures`} role="group" aria-label="figures">
      {ruleFigures(entry).map((f) => (
        <div key={f.key} data-figure={f.key}>
          <dt>{f.label}</dt>
          {/* the reason sits under its dash, in words a finger can read: a title is for a pointer */}
          <dd>{f.text}{f.why === null ? null : <>{" "}<span className="nx-figure-why">{f.why}</span></>}</dd>
        </div>
      ))}
    </dl>
  );
}
