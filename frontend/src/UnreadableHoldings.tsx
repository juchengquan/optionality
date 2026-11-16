import type { Holding } from "./shared/api";
import { RawDetails } from "./shared/ErrorWords";

/** What the page says of a holding the service could not read (#422): plain words, the same in the
 *  list and in the needs-you line, with the service's own reason one tap away. */
export const unreadableWords = (name: string) => `${name} cannot be read — fix it or delete it`;

/** The holdings the service could not read (#422, the owner's decision): each listed by name, with
 *  the service's reason and its id behind "details" (#420's standard: plain words, the raw text
 *  disclosed), so it can be fixed or deleted — and the rest of the book drawn as usual, where one
 *  such row used to fail the whole valuation. Kept apart from the book's own rows on purpose: it has
 *  no legs and no figures to put in their columns. */
export function UnreadableHoldings({ rows }: { rows: Pick<Holding, "id" | "name" | "unreadable">[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="holdings that cannot be read" className="nx-banner" role="status">
      <ul>
        {rows.map((h) => (
          <li key={h.id} data-unreadable={h.id}>
            <div>
              <strong>{h.name}</strong>{" cannot be read — fix it or delete it"}
              <RawDetails plain={unreadableWords(h.name)} raw={`${h.unreadable ?? ""} (id ${h.id})`} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
