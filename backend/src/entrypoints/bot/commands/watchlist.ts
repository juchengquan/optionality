/** Reading the watchlist: the stored rules, the three live tables, and one combo's legs.
 *
 *  The three live tables — /quotes, /greeks, /vol — differ only in their columns and fail the same
 *  way, which is why they are one function and three column mappers. They are three commands
 *  rather than one wide one because a Telegram table is ~40 monospace characters and four columns
 *  at most: a new question gets a new command, never a fifth column (CLAUDE.md).
 */
import { EMPTY_WATCHLIST, type BotContext, type Command, failed } from "./context.ts";
import { monitorLegCodes } from "optionality/domain/monitor";
import { round4 } from "optionality/domain/quote";
import { shortSpxCode } from "optionality/domain/contract";
import { exitPolicy } from "optionality/domain/exit";
import { findComboByName, listMonitors } from "../../../db/queries/index.ts";
import { fromSqliteBool } from "../../../db/values.ts";
import { toMonitor } from "../../../hydrate.ts";
import { watchlistQuotes } from "../../../monitors.ts";
import type { QuoteRecord } from "optionality/quotes";
import { figureShort, ruleShort, type RuleShape } from "optionality/domain/alarm";
import { FIELD_SHORT, fmtValue, pyNumber, table } from "../format.ts";

/** A figure that may not have arrived, rendered the way its own field wants. */
function cell(value: unknown, render: (n: number) => string): string {
  return value === undefined || value === null ? "—" : render(Number(value));
}

/** The stored rules, each in the short form the alarms use (#388): its rule, its last figure and
 *  its state — four columns, where the field and the threshold were two of five. A held credit's
 *  stop reads `close ≥ 9.44` beside its last cost to close, as the dashboard says it. */
export const monitors: Command = (ctx) => {
  const rows = listMonitors(ctx.db);
  if (rows.length === 0) return EMPTY_WATCHLIST;
  return table(["contract", "rule", "last", "state"], rows.map((m) => {
    let state = fromSqliteBool(m.triggered) ? "🔔" : "armed";
    if (!fromSqliteBool(m.enabled)) state = "off";
    const rule: RuleShape = {
      field: m.field, combo: m.legs !== null, compare: m.compare, direction: m.direction,
      threshold: m.threshold,
    };
    const last = m.last_value === null ? "—" : figureShort(rule, m.last_value);
    return [shortSpxCode(m.code), ruleShort(rule), last, state];
  }));
};

/** One live table: one bounded call, and the columns this command asked for. */
async function quoteTable(
  ctx: BotContext, label: string, headers: string[], cells: (snap: QuoteRecord) => string[],
): Promise<string> {
  let quotes;
  try {
    quotes = await watchlistQuotes(ctx.db, ctx.settings.displayTz, ctx.fetchQuotes,
      { now: ctx.now(), policy: exitPolicy(ctx.settings) });
  } catch (err) {
    return failed(label, err);
  }
  if (quotes.length === 0) return EMPTY_WATCHLIST;
  return table(headers, quotes.map((q) => [
    shortSpxCode(q.code) + (q.triggered ? " 🔔" : ""),
    ...cells(q.quote ?? {}),
  ]));
}

export const quotes: Command = (ctx) =>
  quoteTable(ctx, "Quotes", ["contract", "mid", "bid/ask"], (snap) => {
    const bid = snap.bid_price;
    const ask = snap.ask_price;
    const bidAsk = bid !== undefined && bid !== null && ask !== undefined && ask !== null
      ? `${pyNumber(Number(bid))}/${pyNumber(Number(ask))}`
      : "—";
    return [cell(snap.mid_price, pyNumber), bidAsk];
  });

export const greeks: Command = (ctx) =>
  quoteTable(ctx, "Greeks", ["contract", "delta", "gamma", "theta"], (snap) => [
    cell(snap.option_delta, (n) => fmtValue("option_delta", n)),
    // SPX gammas are ~1e-4, so five decimals; three would render every gamma as 0.000
    cell(snap.option_gamma, (n) => n.toFixed(5)),
    cell(snap.option_theta, (n) => n.toFixed(2)),
  ]);

export const vol: Command = (ctx) =>
  quoteTable(ctx, "Vol", ["contract", "IV", "vega"], (snap) => [
    cell(snap.option_implied_volatility, (n) => fmtValue("option_implied_volatility", n)),
    cell(snap.option_vega, (n) => n.toFixed(2)),
  ]);

/** One combo, leg by leg, with the signed total it is watched on.
 *
 *  NO partial sums: any missing leg makes the total "incomplete" rather than a number computed
 *  from part of a structure (CLAUDE.md).
 */
export const combo: Command = async (ctx, args) => {
  if (args.length === 0) return "Usage: /combo <name>";
  const found = findComboByName(ctx.db, args[0]!);
  if (!found) return `No combo named '${args[0]}'.`;
  const monitor = toMonitor(found);
  const codes = monitorLegCodes(monitor);
  let records: QuoteRecord[];
  try {
    ({ records } = await ctx.fetchQuotes([...new Set(codes)].sort()));
  } catch (err) {
    return failed("Combo", err);
  }
  const byCode = Object.fromEntries(records.map((r) => [String(r.code), r]));

  const rows: string[][] = [];
  let total = 0;
  let complete = true;
  for (const [index, leg] of (monitor.legs ?? []).entries()) {
    const code = codes[index]!;
    const value = byCode[code]?.[monitor.field];
    // a quantity beside its sign, `-2`, as the dashboard writes one (#351); one says nothing more
    const qty = leg.qty ?? 1;
    // the real minus, as /help writes a short leg and every table writes a figure (#388)
    const sign = `${leg.sign > 0 ? "+" : "\u2212"}${qty === 1 ? "" : qty}`;
    if (value === undefined || value === null) {
      rows.push([sign, shortSpxCode(code), "—"]);
      complete = false;
    } else {
      total += leg.sign * qty * Number(value);
      rows.push([sign, shortSpxCode(code), fmtValue(monitor.field, Number(value))]);
    }
  }
  // 4dp on the total, as the Python rounds it: a signed sum of three-decimal mids otherwise shows
  // float noise in a figure read as a price
  const totalCell = complete ? fmtValue(monitor.field, round4(total)) : "incomplete";
  rows.push(["", "total", totalCell]);
  return table(["", "leg", FIELD_SHORT[monitor.field] ?? monitor.field], rows);
};
