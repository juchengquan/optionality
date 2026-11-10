import type { EntryStyle } from "../prefs";
import type { Arrangement } from "./arrangement";
import { isBad, type Need } from "./needs";

/** How many the desk's line names before it counts the rest: a bad day must not become a
 *  paragraph, and a count without names makes you hunt (TopLine.tsx, where this was decided). */
const NAMED = 3;

/** The needs-you line: one line on the desk, a banner per item on the phone (ADR 0023).
 *
 *  It APPEARS rather than reports, as the line at `/opt` does, and for its reason: a line that is
 *  almost always the same becomes furniture and stops being read. So with nothing to say it is not
 *  drawn at all — and that is not an all-clear, which only Settings' full list can give.
 */
export function NeedsLine({ items, arrangement, entryStyle }: {
  items: Need[];
  arrangement: Arrangement;
  entryStyle: EntryStyle;
}) {
  if (items.length === 0) return null;
  const tone = isBad(items, entryStyle === "risk") ? "bad" : "good";

  if (arrangement === "phone") {
    return (
      <ul className="nx-banners" role="status" aria-label="needs you" data-tone={tone}>
        {items.map((n) => (
          <li key={n.kind + n.text} data-kind={n.kind}>
            {n.ref
              ? <button type="button" onClick={() => reveal(n.ref!)}>{n.text}</button>
              : <span>{n.text}</span>}
          </li>
        ))}
      </ul>
    );
  }

  const named = items.slice(0, NAMED);
  const rest = items.length - named.length;
  return (
    <div className="nx-needs" role="status" aria-label="needs you" data-tone={tone}>
      <strong>{items.length === 1 ? "1 needs you" : `${items.length} need you`}</strong>
      {" — "}
      {named.map((n, i) => (
        <span key={n.kind + n.text} data-kind={n.kind}>{i > 0 ? " · " : ""}{n.text}</span>
      ))}
      {rest > 0 ? ` · +${rest} more` : null}
    </div>
  );
}

/** Bring the row a banner is about into view, and say which it is for a moment. */
function reveal(ref: string): void {
  const row = document.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.dataset.revealed = "";
  setTimeout(() => { delete row.dataset.revealed; }, 1500);
}
