/** What a row SAYS in each column, as text, for everything that is not the drawing of it.
 *
 *  Three callers, and only one of them paints: the table draws these cells, the detail sheet
 *  lists every column whether or not the table has room for it (ADR 0008), and the column
 *  fitting asks how wide each column needs to be. Two of those would drift from the third if
 *  there were two of this function, and the widest columns on the page — a contract's name, a
 *  combo's legs — are exactly the ones a second copy would get wrong.
 *
 *  It lived in `WatchlistTable.tsx` and was imported from there, which put a component module on
 *  the measuring path: `useTableFit` runs on every poll, for both tables, and again on every
 *  resize, and it reached one `switch` statement through a React tree's worth of module.
 *  `columns.ts` dodged that by taking the function as an ARGUMENT instead, so the workaround was
 *  visible in `widthsFromContent`'s signature and every caller had to carry it. Nothing here
 *  renders anything, so nothing here needs React — `__tests__/Modules.test.ts` holds that.
 */
import type { Entry } from "./api";
import { alarmText, DASH, fmt, fmtText, legSummary, shortContract, shortDate } from "./format";

/** Row plus column key to displayed text. */
export function cellValue(entry: Entry, key: string, isCombo: boolean): string {
  const snap = entry.quote ?? {};
  const greeks = entry.combo_greeks ?? {};
  const greek = (name: string, col: string) =>
    isCombo ? fmt(greeks[name] ?? null, col) : fmt(snap[name as keyof typeof snap] as number | null, col);

  switch (key) {
    // the identity columns are DRAWN by the JSX below, badge and bell and all — but they
    // still have to answer here, because the fitting measurement asks this function how
    // wide every column needs to be and these are the widest on the page
    case "contract": return shortContract(entry.quote?.name ?? entry.code);
    case "combo": return entry.code;
    case "dte": return String(entry.dte);
    case "legs": return entry.legs ? legSummary(entry.legs) : DASH;
    case "expiry": return shortDate(entry.strike_date);
    case "alarm": return alarmText(entry.field, entry.direction, entry.threshold, entry.compare);
    case "value": return fmt(entry.cost_to_close ?? entry.combo_value ?? null, "mid");
    // blank rather than a dash-or-zero where there is no declared holding: a 0.00 here would
    // read as "exactly on pace", which is the opposite of "no schedule"
    case "on_pace": return entry.schedule?.on_pace == null ? "" : fmt(entry.schedule.on_pace, "mid");
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
