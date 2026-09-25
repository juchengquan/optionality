import { Fragment } from "react";

import type { Entry } from "./api";
import { IMMINENT_FILL, LEFT, signalColumns, type Column } from "./columns";
import { alarmText, DASH, fmt, fmtText, legSummary, shortContract, shortDate } from "./format";

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

/** Row plus column key to displayed text. Exported because the detail sheet shows every
 *  column whether or not the table is drawing it, and two of these would drift. */
export function cellValue(entry: Entry, key: string, isCombo: boolean): string {
  const snap = entry.snapshot ?? {};
  const greeks = entry.combo_greeks ?? {};
  const greek = (name: string, col: string) =>
    isCombo ? fmt(greeks[name] ?? null, col) : fmt(snap[name as keyof typeof snap] as number | null, col);

  switch (key) {
    // the identity columns are DRAWN by the JSX below, badge and bell and all — but they
    // still have to answer here, because the fitting measurement asks this function how
    // wide every column needs to be and these are the widest on the page
    case "contract": return shortContract(entry.snapshot?.name ?? entry.code);
    case "combo": return entry.code;
    case "dte": return String(entry.dte);
    case "legs": return entry.legs ? legSummary(entry.legs) : DASH;
    case "expiry": return shortDate(entry.strike_date);
    case "alarm": return alarmText(entry.field, entry.direction, entry.threshold, entry.compare);
    case "value": return fmt(entry.cost_to_close ?? entry.combo_value ?? null, "mid");
    case "entry": return entry.scope === "all" ? fmt(entry.entry, "mid") : "";
    case "pnl": return entry.scope === "all" ? fmt(entry.pnl, "mid") : "";
    case "delta": return greek("option_delta", "delta");
    case "gamma": return greek("option_gamma", "gamma");
    case "theta": return greek("option_theta", "theta");
    case "vega": return greek("option_vega", "vega");
    case "iv": return fmt(snap.option_implied_volatility ?? null, "iv");
    case "mid": return fmt(snap.mid_price ?? null, "mid");
    case "bid": return fmt(snap.bid_price ?? null, "bid");
    case "ask": return fmt(snap.ask_price ?? null, "ask");
    case "last_trade": return fmtText(snap.update_time);
    default: return DASH;
  }
}

export interface RowHandlers {
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onEntry: (positionId: string, value: number) => void;
  onTotal: (monitorId: string, value: number) => void;
}

export function WatchlistTable({
  title, entries, columns, isCombo, onOpen, containerRef,
}: {
  title: string;
  entries: Entry[];
  columns: Column[];
  isCombo: boolean;
  onOpen: (entry: Entry, isCombo: boolean) => void;
  containerRef?: React.Ref<HTMLDivElement>;
}) {
  if (entries.length === 0) return null;
  const shown = new Set(columns.map((c) => c.key));

  return (
    <div ref={containerRef}>
      <h3>{title}</h3>
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
          {entries.map((entry) => {
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
                  const imminent =
                    hl && !entry.triggered && entry.fill !== null && entry.fill >= IMMINENT_FILL;
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
                          {breakable(isCombo ? entry.code : shortContract(entry.snapshot?.name ?? entry.code))}
                          {entry.error ? <span className="badge">{entry.error}</span> : null}
                          {entry.triggered && signal.bell === identity ? " 🔔" : null}
                        </>
                      ) : c.key === "alarm" ? (
                        <>
                          {cellValue(entry, c.key, isCombo)}
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
        </tbody>
      </table>
      </div>
    </div>
  );
}
