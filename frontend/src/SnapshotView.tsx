import type { Entry, Health } from "./api";
import {
  COMBO_COLUMNS, SINGLE_COLUMNS, visible, type Grouping, type Signal,
} from "./columns";
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
  hiddenSingle, hiddenCombo,
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
}) {
  const horizon = health?.settings.manage_by_dte ?? 21;
  const nothing = () => {};
  return (
    <div className="snapshot">
      <h2>optionality watchlist</h2>
      {/* The only thing in the picture that dates it. A screenshot with no timestamp is worthless
          a week later, and both cadences are kept because they answer different questions: the
          SERVICE decides how fresh the figures are, the screen only when they arrived. */}
      <p className="meta">
        {fetchedAt ? `fetched at ${fetchedAt}` : "waiting for first sweep"}
        {polledAt ? ` · screen updated ${polledAt}` : ""}
        {health ? ` · service sweeps every ${health.settings.sweep_seconds}s` : ""}
      </p>
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
    </div>
  );
}
