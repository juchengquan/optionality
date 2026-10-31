import { Fragment } from "react";

import type { Entry, HoldingValues } from "./api";
import {
  LEFT, groupRows, identityBadges, imminentReading, signalColumns,
  type Column, type Grouping, type Signal,
} from "./columns";
import { cellValue } from "./cells";
import { shortContract } from "./format";

/** Somewhere the name may fold when the column is capped on a narrow screen.
 *
 *  <wbr> is a break OPPORTUNITY, not a break: it costs nothing when there is room and folds
 *  at "1016_ bs_ 8050" when there is not. Without it the browser either overflows the cap or
 *  breaks mid-token, and "1016_bs_80" followed by "50" is not a name anyone recognises. */
function breakable(name: string): React.ReactNode {
  const parts = name.split(/(?<=[_ ])/);
  // Fragments, NOT spans. A span around each part means no single element holds the whole
  // name, and every test that looks for it by text stops finding it — thirteen of them did.
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

export interface RowHandlers {
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onEntry: (positionId: string, value: number) => void;
  onTotal: (monitorId: string, value: number) => void;
  /** Record what a holding cost and when it was put on — creating it where the rule has none.
   *  App resolves the rule from its own /monitors state, so no component carries both lists. */
  onHolding: (row: Entry, values: HoldingValues) => void;
}

export function WatchlistTable({
  title, entries, columns, isCombo, onOpen, containerRef, picker, add, reading, band, horizon,
  grouping,
}: {
  title: string;
  entries: Entry[];
  columns: Column[];
  isCombo: boolean;
  /** what the second colour is earned against, and the band it clears. The BAR is untouched by
   *  both: it is always the distance travelled toward the threshold. Named `reading` because
   *  `signal` is taken here by signalColumns' answer — which columns carry the bar and the bell. */
  reading: Signal;
  band: number;
  /** the manage-by DTE, from /health — the horizon pressure weighs a fill against */
  horizon: number;
  /** how the rows are divided up. One group covering the whole table draws no divider, so a
   *  watchlist of one expiry looks exactly as it did before (columns.ts: groupRows). */
  grouping: Grouping;
  onOpen: (entry: Entry, isCombo: boolean) => void;
  containerRef?: React.Ref<HTMLDivElement>;
  /** this table's column choices, sat beside its name rather than in the page's chrome */
  picker?: React.ReactNode;
  /** the trigger that adds a row to THIS table, on its heading for the same reason */
  add?: React.ReactNode;
}) {
  const shown = new Set(columns.map((c) => c.key));

  // An empty table used to render NOTHING — heading included. That was invisible while the add
  // triggers lived in the page chrome, and became a trap the moment they moved onto these
  // headings: with no rows of a kind there would be no way to create the first one, on a fresh
  // install or the moment you deleted your last. So the heading always draws, and says so.
  // The picker does not: there is nothing to choose between for a table with no rows.
  if (entries.length === 0) {
    return (
      <div ref={containerRef}>
        <div className="table-head">
          <h3>{title}</h3>
          {add}
        </div>
        <p className="pending">nothing watched yet</p>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <div className="table-head">
        <h3>{title}</h3>
        {add}
        {picker}
      </div>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={LEFT.has(c.key) ? "left" : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupRows(entries, grouping).map((group) => (
            <Fragment key={group.label ?? "all"}>
            {group.label ? (
              // a heading, not a row: it has nothing to open, so it carries no click handler and
              // the sheet stays shut when it is tapped
              <tr className="group">
                <td colSpan={columns.length}>{group.label}</td>
              </tr>
            ) : null}
            {group.rows.map((entry) => {
            const signal = signalColumns(entry, isCombo, shown);
            return (
              <tr
                key={entry.id}
                className={entry.triggered ? "triggered" : undefined}
                // the whole row opens its detail now: there is nothing else in it to click
                onClick={() => onOpen(entry, isCombo)}
              >
                {columns.map((c) => {
                  const hl = c.key === signal.fill;
                  // a fired row has its own colour and outranks this: two markings on one
                  // row would say nothing about which state it is in
                  const imminent = hl && !entry.triggered && entry.fill !== null
                    && imminentReading(entry.fill, entry.dte, reading, horizon) >= band;
                  const classes = [
                    hl ? "hl" : "",
                    imminent ? "imminent" : "",
                    LEFT.has(c.key) ? "left" : "",
                  ].filter(Boolean);
                  // --fill carries how far the value has travelled toward its threshold,
                  // so urgency is seen rather than computed, without spending a column
                  const style = hl && entry.fill !== null
                    ? ({ ["--fill" as string]: `${entry.fill}%` } as React.CSSProperties)
                    : undefined;
                  const identity = isCombo ? "combo" : "contract";
                  return (
                    <td key={c.key} className={classes.join(" ") || undefined} style={style}>
                      {c.key === identity ? (
                        <>
                          {breakable(isCombo ? entry.code : shortContract(entry.quote?.name ?? entry.code))}
                          {identityBadges(entry).map((b) => (
                            <Fragment key={b.text}>
                              {/* `breakable` above puts a break opportunity BETWEEN the name's
                                  parts and none after the last, so "8150" and the badge beside it
                                  were one unbreakable unit: measured at 390px the frozen column
                                  went from 88px to 93.66px, buying back the width its cap exists
                                  to save. One <wbr> and the badge folds under the name instead. */}
                              <wbr />
                              <span className={b.quiet ? "badge quiet" : "badge"} title={b.title}>
                                {b.text}
                              </span>
                            </Fragment>
                          ))}
                          {entry.triggered && signal.bell === identity ? " 🔔" : null}
                        </>
                      ) : c.key === "alarm" ? (
                        // The threshold IS this figure, so this is what you tap to change it. The
                        // row's own click opens the sheet and the sheet focuses the threshold box,
                        // so no handler belongs here — only the signal that the figure is a door.
                        // Without it the controls were three steps away with nothing pointing at
                        // them, which read as there being no way to edit a combo's threshold.
                        <>
                          <span className="editable" title="edit the threshold">
                            {cellValue(entry, c.key, isCombo)}
                          </span>
                          {entry.triggered && signal.bell === "alarm" ? " 🔔" : null}
                        </>
                      ) : (
                        cellValue(entry, c.key, isCombo)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
            })}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
