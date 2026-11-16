/** One contract, the holdings, the service itself, and the help text.
 *
 *  `/holdings` is here rather than beside the watchlist because a holding is not a rule: its
 *  figures come from `holdings.ts` — the same function `/positions/values` asks — so Telegram and
 *  the dashboard cannot disagree about a cost, a P&L or a Level.
 */
import { type Command, failed, requireNumber } from "./context.ts";
import { buildSpxCode } from "optionality/domain/contract";
import { displayTimeShort } from "optionality/domain/timefmt";
import { holdingValues } from "../../../holdings.ts";
import type { QuoteRecord } from "optionality/quotes";
import { marketPhase } from "optionality/domain/expiry";
import { HELP_TEXT, closedLine, escapeHtml, fmtValue, standingNote, table } from "../format.ts";

/** Where each Position stands: what it costs to buy back, what that is worth, and the one thing
 *  worth saying about it. Four columns, inside forty characters, as every table reply here is —
 *  and outside New York's session, valued from each holding's latest close, one line under the
 *  table saying which (#380). */
export const holdings: Command = async (ctx) => {
  // ONE instant for the figures and the line under them: read again after the Provider call, a reply
  // begun at 16:14:59 would put a live table under "market closed" (#380 review)
  const now = ctx.now();
  let valued;
  try {
    valued = await holdingValues(
      ctx.db, ctx.fetchQuotes, now, ctx.settings, ctx.settings.displayTz,
    );
  } catch (err) {
    return failed("Holdings", err);
  }
  // a holding whose row cannot be read is named, with why, under whatever else is said: it is the
  // owner's to fix or delete, and it no longer takes the whole reply down with it (#422)
  const unread = (html: boolean) => valued.unreadable.map(({ row, reason }) =>
    html ? `⚠️ ${escapeHtml(reason)} — id ${escapeHtml(row.id)}` : `⚠️ ${reason} — id ${row.id}`);
  if (valued.values.length === 0) {
    // no table, so a plain reply, and the words go as they are
    if (valued.unreadable.length > 0) return unread(false).join("\n");
    return "No holdings recorded. Record one on the dashboard, beside the rule that watches it.";
  }
  const table_ = table(["holding", "cost", "P&L", "note"], valued.values.map((v) => [
    v.row.name,
    v.cost === null ? "—" : v.cost.toFixed(2),
    v.pnl === null ? "—" : String(Math.round(v.pnl)),
    standingNote(v),
  ]));
  // outside the session the figures are a close's, and the table keeps its four columns: the one
  // line under it says which close (#380) — or, in the Curb and overnight, that they are live and
  // thin, and which were valued from a close (#416)
  const phase = marketPhase(now);
  const reply = phase === "regular" ? table_ : `${table_}\n${closedLine(valued.values, phase)}`;
  // escaped: the table makes this an HTML reply, and a row's words are the row's own
  return valued.unreadable.length === 0 ? reply : `${reply}\n${unread(true).join("\n")}`;
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
