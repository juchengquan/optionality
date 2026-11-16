import { useId, useRef, useState } from "react";

import { DeleteAsk } from "./HoldingActions";
import type { Holding } from "./shared/api";
import { RawDetails } from "./shared/ErrorWords";

/** What the page says of a holding the service could not read (#422): plain words, the same in the
 *  list and in the needs-you line, with the service's own reason one tap away. Not "fix it": the
 *  page has no way to — a correction of its legs is refused, since the legs are what will not read —
 *  and deleting it is the one remedy offered here. */
export const unreadableWords = (name: string) => `${name} cannot be read — its stored row is damaged`;

/** The holdings the service could not read (#422, the owner's decision): each listed by name, with
 *  the service's reason and its id behind "details" (#420's standard: plain words, the raw text
 *  disclosed), and the delete a holding recorded by mistake is given (`DeleteAsk`) — while the rest
 *  of the book is drawn as usual, where one such row used to fail the whole valuation. Kept apart
 *  from the book's own rows on purpose: it has no legs and no figures to put in their columns. Each
 *  item carries its `data-ref`, so the needs-you line's button leads to it. */
export function UnreadableHoldings<H extends Pick<Holding, "id" | "name" | "unreadable">>({ rows, onDeleted }: {
  rows: H[];
  onDeleted: (holding: H) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="holdings that cannot be read" className="nx-banner" role="status">
      <ul>
        {rows.map((h) => (
          <li key={h.id} data-unreadable={h.id} data-ref={h.id}>
            <div>
              <strong>{h.name}</strong>{" cannot be read — its stored row is damaged"}
              <RawDetails plain={unreadableWords(h.name)} raw={`${h.unreadable ?? ""} (id ${h.id})`} />
            </div>
            <Remove holding={h} onDeleted={() => onDeleted(h)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "delete…", and the question every delete of a holding asks, as a closed trade's does. */
function Remove({ holding, onDeleted }: { holding: Pick<Holding, "id" | "name">; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const cancel = () => { setAsking(false); button.current?.focus(); };
  return (
    <div className="nx-hold" onKeyDown={(e) => {
      if (e.key !== "Escape" || !asking) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }}>
      <div className="nx-hold-actions">
        <button ref={button} type="button" className="nx-hold-danger" aria-expanded={asking}
                aria-controls={asking ? id : undefined} onClick={() => setAsking((a) => !a)}>delete…</button>
      </div>
      {asking ? <DeleteAsk id={id} holding={holding} watching={0} onCancel={cancel} onDeleted={onDeleted} /> : null}
    </div>
  );
}
