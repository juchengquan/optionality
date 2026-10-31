import type { Entry, Health, Holding } from "./api";
import {
  COMBO_COLUMNS, SINGLE_COLUMNS, visible, type Grouping, type Signal,
} from "./columns";
import { Freshness } from "./Freshness";
import { HoldingList, HoldingReadout } from "./Holdings";
import { TopLine } from "./TopLine";
import { WatchlistTable } from "./WatchlistTable";

/** The page as it goes into the image: a SECOND React tree, at a width of its own.
 *
 *  Not a clone of the live DOM, and that is the whole design. `useTableFit` measures the live
 *  container with a ResizeObserver and drops columns against it (ADR 0008), so a cloned node
 *  keeps whatever subset your phone was showing however wide you made the copy. Rendering again
 *  with the columns stated is the only way the picture can hold figures the screen cannot.
 *
 *  `columns` is already a prop of WatchlistTable, so the tables themselves are untouched: same
 *  grouping, same fill bars, same bells, same leg badges. What is left out is everything that
 *  can be pressed — nothing in a picture can be — so no pickers, no add triggers, no row
 *  handlers, and the sheet it would open is not here either.
 */
export function SnapshotView({
  singles, combos, health, fetchedAt, polledAt, grouping, reading, band,
  hiddenSingle, hiddenCombo, holdings, holdingsError,
}: {
  singles: Entry[];
  combos: Entry[];
  health: Health | null;
  /** the service's freshness and the screen's, both, exactly as the page words them */
  fetchedAt: string | null;
  polledAt: string | null;
  grouping: Grouping;
  reading: Signal;
  band: number;
  hiddenSingle: Set<string>;
  hiddenCombo: Set<string>;
  /** What is HELD, which no rule states: the entry, the cost to close and the P&L. Null while the
   *  figures have not arrived — the section is then left out rather than photographed mid-fetch. */
  holdings: Holding[] | null;
  /** why they could not be read, if they could not. An omitted section and an empty one look
   *  identical in a still image, and "nothing held" is a claim about the account. */
  holdingsError: string | null;
}) {
  const horizon = health?.settings.manage_by_dte ?? 21;
  const nothing = () => {};
  return (
    <div className="snapshot">
      <h2>optionality watchlist</h2>
      {/* The only thing in the picture that dates it. A screenshot with no timestamp is
          worthless a week later, and the SAME component as the page's — a second copy of this
          markup lived here and was the one thing in the image that could contradict the screen.
          It carries the session time too, which is what a reader outside this timezone needs. */}
      <Freshness fetchedAt={fetchedAt} polledAt={polledAt}
                 sweepSeconds={health?.settings.sweep_seconds ?? null} />
      <TopLine quotes={[...singles, ...combos]} health={health} />
      {singles.length > 0 ? (
        <WatchlistTable
          title="Single-leg" entries={singles} columns={visible(SINGLE_COLUMNS, hiddenSingle)}
          isCombo={false} reading={reading} band={band} horizon={horizon} grouping={grouping}
          onOpen={nothing}
        />
      ) : null}
      {combos.length > 0 ? (
        <WatchlistTable
          title="Combos" entries={combos} columns={visible(COMBO_COLUMNS, hiddenCombo)}
          isCombo={true} reading={reading} band={band} horizon={horizon} grouping={grouping}
          onOpen={nothing}
        />
      ) : null}
      {/* The half of the page a rule cannot state. Rendered from the same readout the panel uses,
          so the two cannot disagree — and rendered whether or not that panel is open, which is
          what the clone this replaces could not do (Holdings.HoldingReadout). */}
      {/* The heading goes with the figures: an "holdings" heading over nothing is a claim that
          nothing is held, which is exactly what the ladder refuses to say before the figures have
          arrived. `pending` is left out here for the same reason. */}
      {holdings === null && holdingsError === null ? null : (
        <section>
          <h2>holdings</h2>
          <HoldingList
            rows={holdings} error={holdingsError}
            row={(h) => (
              <div key={h.id} className="border-t py-3">
                <HoldingReadout holding={h} />
              </div>
            )}
          />
        </section>
      )}
    </div>
  );
}
