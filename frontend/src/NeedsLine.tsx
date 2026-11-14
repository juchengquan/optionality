import { BellRing, Clock, OctagonAlert, OctagonX, Sparkles, Target } from "lucide-react";

import type { EntryStyle } from "./shared/prefs";
import type { Arrangement } from "./arrangement";
import { toneOf, type Need, type NeedKind } from "./needs";

/** How many the desk's line names before it counts the rest: a bad day must not become a
 *  paragraph, and a count without names makes you hunt (decided for the old page's top line, #301). */
const NAMED = 3;

/** Each kind's glyph. Attention is told apart from the "down" colour by its shape as well as its
 *  hue (ADR 0023), so every item carries one, wherever it is drawn. */
const GLYPH: Record<NeedKind, typeof BellRing> = {
  fault: OctagonAlert, stop: OctagonX, alarm: BellRing, entry: Sparkles, target: Target, manage: Clock,
};

export function Glyph({ kind }: { kind: NeedKind }) {
  const Icon = GLYPH[kind];
  // its colour comes from the item it sits in (`[data-kind]` sets --chip there), so the glyph
  // carries no kind of its own
  return <Icon className="nx-glyph" aria-hidden="true" />;
}

/** The needs-you line: one line on the desk, a banner per item on the phone (ADR 0023).
 *
 *  It APPEARS rather than reports, as the old page's top line did, and for its reason: a line that is
 *  almost always the same becomes furniture and stops being read. So with nothing to say it is not
 *  drawn at all — and that is not an all-clear, which only Settings' full list can give.
 */
export function NeedsLine({ items, arrangement, entryStyle, onReveal = reveal }: {
  items: Need[];
  arrangement: Arrangement;
  entryStyle: EntryStyle;
  /** what a tapped banner does with the row it is about; the page passes one that first leaves
   *  Settings, where the book is not drawn */
  onReveal?: (ref: string) => void;
}) {
  if (items.length === 0) return null;
  const tone = toneOf(items, entryStyle === "risk");
  // the index too: two items can say the same words about two rows, and a key must not
  const key = (n: Need, i: number) => `${i}:${n.kind}:${n.text}`;

  if (arrangement === "phone") {
    return (
      <div className="nx-banners" role="status" aria-label="needs you" data-tone={tone}>
        <ul>
          {items.map((n, i) => (
            <li key={key(n, i)} data-kind={n.kind}>
              {n.ref ? (
                <button type="button" onClick={() => onReveal(n.ref!)}>
                  <Glyph kind={n.kind} />{n.text}
                </button>
              ) : <span><Glyph kind={n.kind} />{n.text}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const named = items.slice(0, NAMED);
  const rest = items.length - named.length;
  return (
    <div className="nx-needs" role="status" aria-label="needs you" data-tone={tone}>
      <strong>{items.length === 1 ? "1 needs you" : `${items.length} need you`}</strong>
      {" — "}
      {named.map((n, i) => (
        <span key={key(n, i)} className="nx-need" data-kind={n.kind}>
          {i > 0 ? " · " : ""}<Glyph kind={n.kind} />{n.text}
        </span>
      ))}
      {rest > 0 ? ` · +${rest} more` : null}
    </div>
  );
}

/** Bring the row a banner is about into view, and mark it for a moment. Every rule and every
 *  holding on the page carries its `data-ref`, nested ones included. */
export function reveal(ref: string): void {
  // matched on the dataset rather than through a selector, so an id needs no escaping
  const row = [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref);
  if (!row) return;
  // optional: jsdom has no scrolling, and marking the row matters more than moving to it
  row.scrollIntoView?.({ block: "center", behavior: "smooth" });
  row.dataset.revealed = "";
  setTimeout(() => { delete row.dataset.revealed; }, 1500);
}
