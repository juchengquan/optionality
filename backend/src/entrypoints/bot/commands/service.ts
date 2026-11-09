/** One contract, the holdings, the service itself, and the help text.
 *
 *  `/holdings` is here rather than beside the watchlist because a holding is not a rule: its
 *  figures come from `holdings.ts` — the same function `/positions/values` asks — so Telegram and
 *  the dashboard cannot disagree about a cost, a P&L or a Level.
 */
import { type Command, failed, requireNumber } from "./context.ts";
import { buildSpxCode } from "../../../domain/contract.ts";
import { displayTimeShort } from "../../../domain/timefmt.ts";
import { holdingValues } from "../../../holdings.ts";
import type { QuoteRecord } from "../../../quotes.ts";
import { HELP_TEXT, fmtValue, standingNote, table } from "../format.ts";

/** Where each Position stands: what it costs to buy back, what that is worth, and the one thing
 *  worth saying about it. Four columns, inside forty characters, as every table reply here is. */
export const holdings: Command = async (ctx) => {
  let valued;
  try {
    valued = await holdingValues(
      ctx.db, ctx.fetchQuotes, ctx.now(), ctx.settings, ctx.settings.displayTz,
    );
  } catch (err) {
    return failed("Holdings", err);
  }
  if (valued.values.length === 0) {
    return "No holdings recorded. Record one on the dashboard, beside the rule that watches it.";
  }
  return table(["holding", "cost", "P&L", "note"], valued.values.map((v) => [
    v.row.name,
    v.cost === null ? "—" : v.cost.toFixed(2),
    v.pnl === null ? "—" : String(Math.round(v.pnl)),
    standingNote(v),
  ]));
};

/** One contract's live figures, for a strike nothing watches. The reason `/spx/quote` could be
 *  dropped (#199): this answers the same question in-process. */
export const snapshot: Command = async (ctx, args) => {
  const usage = "Usage: /snapshot <YYYY-MM-DD> <CALL|PUT> <strike>";
  if (args.length < 3) return usage;
  const optionType = args[1]!.toUpperCase();
  if (optionType !== "CALL" && optionType !== "PUT") return usage;
  let code: string;
  try {
    code = buildSpxCode(args[0]!, optionType, requireNumber(args[2]!));
  } catch {
    return usage;
  }
  let records: QuoteRecord[];
  try {
    ({ records } = await ctx.fetchQuotes([code]));
  } catch (err) {
    return failed("Snapshot", err);
  }
  if (records.length === 0) return `No data for ${code}.`;
  const r = records[0]!;
  const name = (r.name as string | undefined) || code;
  const fields = [
    "option_delta", "option_implied_volatility", "mid_price", "bid_price", "ask_price",
    "last_price", "option_theta",
  ];
  const lines = fields
    .filter((f) => r[f] !== undefined && r[f] !== null)
    .map((f) => `${f}: ${fmtValue(f, typeof r[f] === "number" ? r[f] : r[f])}`);
  return `${name}\n${lines.join("\n")}`;
};

export const health: Command = (ctx) => {
  const lines: string[] = [];
  if (ctx.sweeper) {
    const { label } = ctx.sweeper.alarmState();
    const sweptAt = displayTimeShort(ctx.sweeper.lastSweepAt(), ctx.settings.displayTz);
    lines.push(`alarms: ${label}${sweptAt ? ` — last sweep ${sweptAt}` : ""}`);
  }
  return lines.length > 0 ? `Service is up.\n${lines.join("\n")}` : "Service is up.";
};

/** Registered rather than left to `default`, so the table and the "/" menu can be compared
 *  exactly: `help` was announced in BOT_COMMANDS and answered only by falling through the switch,
 *  which is the one shape that comparison could not see. */
export const help: Command = () => HELP_TEXT;
