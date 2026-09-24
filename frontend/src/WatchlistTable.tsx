import type { Entry } from "./api";
import { LEFT, signalColumns, type Column } from "./columns";
import { alarmText, DASH, fmt, fmtText, legSummary } from "./format";
import { EntryCell, RowActions } from "./RowActions";

function cellValue(entry: Entry, key: string, isCombo: boolean): string {
  const snap = entry.snapshot ?? {};
  const greeks = entry.combo_greeks ?? {};
  const greek = (name: string, col: string) =>
    isCombo ? fmt(greeks[name] ?? null, col) : fmt(snap[name as keyof typeof snap] as number | null, col);

  switch (key) {
    case "dte": return String(entry.dte);
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
  title, entries, columns, isCombo, handlers,
}: {
  title: string;
  entries: Entry[];
  columns: Column[];
  isCombo: boolean;
  handlers: RowHandlers;
}) {
  if (entries.length === 0) return null;
  const shown = new Set(columns.map((c) => c.key));

  return (
    <>
      <h3>{title}</h3>
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
              <tr key={entry.id} className={entry.triggered ? "triggered" : undefined}>
                {columns.map((c) => {
                  const hl = c.key === signal.fill;
                  const classes = [hl ? "hl" : "", LEFT.has(c.key) ? "left" : ""].filter(Boolean);
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
                          {isCombo ? entry.code : (entry.snapshot?.name ?? entry.code)}
                          {entry.error ? <span className="badge">{entry.error}</span> : null}
                          {entry.triggered && signal.bell === identity ? " 🔔" : null}
                          {isCombo && entry.legs ? (
                            <div className="legs">{entry.strike_date} · {legSummary(entry.legs)}</div>
                          ) : null}
                        </>
                      ) : c.key === "alarm" ? (
                        <>
                          {cellValue(entry, c.key, isCombo)}
                          {entry.triggered && signal.bell === "alarm" ? " 🔔" : null}
                        </>
                      ) : c.key === "actions" ? (
                        <RowActions
                          entry={entry}
                          onPatch={handlers.onPatch}
                          onDelete={handlers.onDelete}
                          onRename={handlers.onRename}
                        />
                      ) : c.key === "entry" ? (
                        <EntryCell entry={entry} onEntry={handlers.onEntry} onTotal={handlers.onTotal} />
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
    </>
  );
}
