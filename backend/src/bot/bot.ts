/** The Telegram bot. Ported from telegram_bot.py (ADR 0009, phase 7).
 *
 *  Long-polls getUpdates and answers commands, from the owner chat only.
 *
 *  **The token allows ONE getUpdates consumer** (CLAUDE.md), so this must never run beside the Python
 *  service against the same token, and no test may reach the real API. The tests drive `handleUpdate`
 *  directly with a fake, exactly as the Python's do; the real thing is first exercised at cutover.
 */
import type { DatabaseSync } from "node:sqlite";

import { buildSpxCode, normalizeStrikeDate } from "../domain/contract.ts";
import { comboFieldError, monitorLegCodes } from "../domain/monitor.ts";
import {
  findComboByName, findMonitorByCodeField, findMonitorsByIdentifier, insertMonitor, listMonitors,
  updateMonitorFields,
} from "../db/queries.ts";
import { atomic } from "../db/open.ts";
import type { MonitorRow } from "../db/rows.ts";
import { clearMonitorLinks, deleteMonitorRow } from "../db/queries.ts";
import { toSqlDatetime } from "../db/time.ts";
import { fromSqliteBool, toSqliteBool, toSqliteJson } from "../db/values.ts";
import type { Settings } from "../env.ts";
import { toMonitor } from "../hydrate.ts";
import { linkToPositions, watchlistQuotes } from "../monitors.ts";
import { verifyContracts, type QuoteFetcher, type QuoteRecord } from "../quotes.ts";
import { displayTimeShort } from "../timefmt.ts";
import {
  BOT_COMMANDS, FIELD_SHORT, HELP_TEXT, fmtValue, hasFormat, pyNumber, ruleText, shortCode, table,
  thresholdError,
} from "./format.ts";
import type { SweeperPort, WorkerPort } from "../ports.ts";

/** One call to the Telegram API. A fake in tests; HTTPS in production. */
export type TelegramApi = (method: string, params: Record<string, string>) => Promise<unknown>;

export interface BotDeps {
  db: DatabaseSync;
  settings: Settings;
  api: TelegramApi;
  fetchQuotes: QuoteFetcher;
  sweeper?: SweeperPort;
  worker?: WorkerPort;
  now?: () => Date;
}

interface Update {
  update_id?: number;
  message?: { chat?: { id?: unknown }; text?: unknown };
}

/** uuid4().hex, as every other id in this service is. */
const newId = () => crypto.randomUUID().replaceAll("-", "");

const LEG_TOKEN = /^([+-])([CP])(\d+(?:\.\d+)?)$/;
const SHORT_CONTRACT = /^(\d{6})([CP])(\d+)$/;

export class TelegramBot {
  private readonly deps: BotDeps;
  private offset = 0;
  private stopped = false;

  constructor(deps: BotDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Publish the "/" autocomplete menu and drain the backlog. Does NOT start polling.
   *
   *  The drain matters: without it a service restart replays every command sent while it was down, and
   *  a `/unwatch` from an hour ago would be obeyed as if it were new.
   *
   *  Separate from `run()` so that a caller — and a test — can do the setup without entering a loop.
   *  The real loop blocks for 25 seconds in getUpdates; a fake that answers at once turns it into a
   *  busy wait that starves everything else. */
  async start(): Promise<void> {
    try {
      await this.deps.api("setMyCommands", { commands: JSON.stringify(BOT_COMMANDS) });
    } catch (err) {
      console.error("telegram setMyCommands failed:", err);
    }
    try {
      const last = (await this.deps.api("getUpdates", { offset: "-1", timeout: "0" })) as Update[];
      if (Array.isArray(last) && last.length > 0) {
        this.offset = (last.at(-1)!.update_id ?? -1) + 1;
      }
    } catch (err) {
      console.error("telegram backlog drain failed:", err);
    }
  }

  /** The long-poll loop. Runs until `stop()`. */
  async run(): Promise<void> {
    console.log("telegram bot polling started");
    while (!this.stopped) {
      let updates: Update[];
      try {
        updates = (await this.deps.api("getUpdates", {
          offset: String(this.offset), timeout: "25",
        })) as Update[];
      } catch (err) {
        console.error("telegram getUpdates failed; retrying:", err);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of updates ?? []) {
        this.offset = (update.update_id ?? this.offset) + 1;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          console.error(`failed handling telegram update ${update.update_id}:`, err);
        }
      }
    }
  }

  /** What the next poll will ask for, so a test can see the backlog was drained. */
  nextOffset(): number {
    return this.offset;
  }

  async handleUpdate(update: Update): Promise<void> {
    const chatId = String(update.message?.chat?.id ?? "");
    // only the owner chat may command the bot; everyone else is ignored without a reply, because a
    // reply would confirm the bot exists
    if (chatId !== this.deps.settings.telegramChatId) return;
    const text = String(update.message?.text ?? "").trim();
    if (!text) return;
    const reply = await this.dispatch(text);
    if (!reply) return;
    const params: Record<string, string> = { chat_id: chatId, text: reply };
    // HTML parse mode ONLY for tables: a plain reply containing "<0.6" would lose it to a tag
    if (reply.startsWith("<pre>")) params.parse_mode = "HTML";
    await this.deps.api("sendMessage", params);
  }

  async dispatch(text: string): Promise<string> {
    const parts = text.split(/\s+/);
    const first = parts[0] ?? "";
    const command = first.startsWith("/") ? first.split("@")[0]!.slice(1).toLowerCase() : "";
    const args = parts.slice(1);

    switch (command) {
      case "monitors": return this.monitors();
      case "quotes": return this.quoteTable("Quotes", ["contract", "mid", "bid/ask"], (snap) => {
        const mid = snap.mid_price === undefined || snap.mid_price === null
          ? "—" : pyNumber(Number(snap.mid_price));
        const bidAsk = snap.bid_price !== undefined && snap.bid_price !== null
          && snap.ask_price !== undefined && snap.ask_price !== null
          ? `${pyNumber(Number(snap.bid_price))}/${pyNumber(Number(snap.ask_price))}`
          : "—";
        return [mid, bidAsk];
      });
      case "greeks": return this.quoteTable("Greeks", ["contract", "delta", "gamma", "theta"], (snap) => [
        snap.option_delta === undefined || snap.option_delta === null
          ? "—" : fmtValue("option_delta", Number(snap.option_delta)),
        // SPX gammas are ~1e-4, so five decimals; three would render every gamma as 0.000
        snap.option_gamma === undefined || snap.option_gamma === null
          ? "—" : Number(snap.option_gamma).toFixed(5),
        snap.option_theta === undefined || snap.option_theta === null
          ? "—" : Number(snap.option_theta).toFixed(2),
      ]);
      case "vol": return this.quoteTable("Vol", ["contract", "IV", "vega"], (snap) => [
        snap.option_implied_volatility === undefined || snap.option_implied_volatility === null
          ? "—" : fmtValue("option_implied_volatility", Number(snap.option_implied_volatility)),
        snap.option_vega === undefined || snap.option_vega === null
          ? "—" : Number(snap.option_vega).toFixed(2),
      ]);
      case "watch": return this.watch(args);
      case "watchcombo": return this.watchCombo(args);
      case "combo": return this.combo(args);
      case "unwatch": return this.unwatch(args);
      case "threshold": return this.threshold(args);
      case "rename": return this.rename(args);
      case "snapshot": return this.snapshot(args);
      case "health": return this.health();
      default: return HELP_TEXT;
    }
  }

  // --- the listing commands ----------------------------------------------------------------
  private monitors(): string {
    const rows = listMonitors(this.deps.db);
    if (rows.length === 0) return "Watchlist is empty. Add one with /watch.";
    return table(["contract", "field", "last", "thr", "state"], rows.map((m) => {
      let state = fromSqliteBool(m.triggered) ? "🔔" : "armed";
      if (!fromSqliteBool(m.enabled)) state = "off";
      // three places for a field with a format of its own, four for everything else — a mid of
      // 26.4000 reads as spurious precision, and a delta of 0.0456 loses the figure that matters
      const last = m.last_value === null ? "—"
        : hasFormat(m.field) ? fmtValue(m.field, m.last_value)
        : m.last_value.toFixed(4);
      const thr = `${m.direction === "below" ? "≤" : "≥"}${pyNumber(m.threshold)}`;
      return [shortCode(m.code), FIELD_SHORT[m.field] ?? m.field, last, thr, state];
    }));
  }

  /** The three live tables differ only in their columns, and they fail the same way. */
  private async quoteTable(
    label: string, headers: string[], cells: (snap: QuoteRecord) => string[],
  ): Promise<string> {
    let quotes;
    try {
      quotes = await watchlistQuotes(this.deps.db, this.deps.settings.displayTz, this.deps.fetchQuotes,
        { now: this.now() });
    } catch (err) {
      return `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (quotes.length === 0) return "Watchlist is empty. Add one with /watch.";
    return table(headers, quotes.map((q) => [
      shortCode(q.code) + (q.triggered ? " 🔔" : ""),
      ...cells(q.snapshot ?? {}),
    ]));
  }

  // --- creating -----------------------------------------------------------------------------
  private async watch(args: string[]): Promise<string> {
    const usage = "Usage: /watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field] [above|below]";
    if (args.length < 4) return usage;
    const optionType = args[1]!.toUpperCase();
    if (optionType !== "CALL" && optionType !== "PUT") return usage;
    let strikeDate: string;
    let strike: number;
    let threshold: number;
    let code: string;
    try {
      strikeDate = normalizeStrikeDate(args[0]!);
      strike = requireNumber(args[2]!);
      threshold = requireNumber(args[3]!);
      code = buildSpxCode(strikeDate, optionType, strike);
    } catch {
      return usage;
    }
    const { field, direction, compare } = modifiers(args.slice(4, 7), "option_delta");
    const bad = thresholdError(threshold, compare);
    if (bad) return bad;

    const missing = await verifyContracts([code], this.deps.fetchQuotes);
    if (missing) return missing;
    if (findMonitorByCodeField(this.deps.db, code, field)) {
      return `Already watching ${code} (${field}).`;
    }
    await this.insert({
      code, strike_date: strikeDate, option_type: optionType, strike, field, threshold,
      direction, compare, legs: null,
    }, [code]);
    return ruleText(`Watching ${code}`, field, threshold, direction, compare);
  }

  private async watchCombo(args: string[]): Promise<string> {
    const usage = "Usage: /watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below]  (−short +long)";
    if (args.length < 5) return usage;
    const name = args[0]!;
    let strikeDate: string;
    try {
      strikeDate = normalizeStrikeDate(args[1]!);
    } catch {
      return usage;
    }
    const legs: { sign: 1 | -1; option_type: "CALL" | "PUT"; strike: number }[] = [];
    let i = 2;
    while (i < args.length) {
      const m = LEG_TOKEN.exec(args[i]!.toUpperCase());
      if (!m) break;
      legs.push({
        sign: m[1] === "+" ? 1 : -1,
        option_type: m[2] === "C" ? "CALL" : "PUT",
        strike: Number(m[3]),
      });
      i += 1;
    }
    if (legs.length < 2 || i >= args.length) return usage;
    let threshold: number;
    try {
      threshold = requireNumber(args[i]!);
    } catch {
      return usage;
    }
    const { field, direction, compare } = modifiers(args.slice(i + 1, i + 4), "mid_price");
    const bad = thresholdError(threshold, compare);
    if (bad) return bad;
    const notAdditive = comboFieldError(field);
    if (notAdditive) return notAdditive;

    const legCodes = [...new Set(legs.map((l) => buildSpxCode(strikeDate, l.option_type, l.strike)))].sort();
    const missing = await verifyContracts(legCodes, this.deps.fetchQuotes);
    if (missing) return missing;
    if (findMonitorByCodeField(this.deps.db, name, field)) {
      return `Already watching ${name} (${field}).`;
    }
    await this.insert({
      code: name, strike_date: strikeDate, option_type: "CMB", strike: 0, field, threshold,
      direction, compare, legs: toSqliteJson(legs),
    }, legs.map((l) => buildSpxCode(strikeDate, l.option_type, l.strike)));
    return ruleText(
      `Watching combo ${name} (${legs.length} legs)`, field, threshold, direction, compare,
    );
  }

  /** Write the monitor and attach it to whatever Position already holds its contracts.
   *
   *  The Python's bot does NOT link — only the API does — so a monitor created from the phone had no
   *  entry and no P&L until something re-created it. The linkage is a lookup, not a guess (see
   *  positionsHolding), so there is no reason for the two doors to behave differently. */
  private async insert(fields: Partial<MonitorRow>, contracts: string[]): Promise<void> {
    const { db } = this.deps;
    await atomic(db, () => {
      const row = insertMonitor(db, {
        id: newId(),
        code: "", strike_date: "", option_type: "", strike: 0, field: "", threshold: 0,
        direction: "above", compare: "abs", legs: null, scope: null,
        enabled: toSqliteBool(true), disabled_reason: null, triggered: toSqliteBool(false),
        last_value: null, last_checked_at: null, last_alarm_at: null,
        created_at: toSqlDatetime(this.now()),
        ...fields,
      } as MonitorRow);
      linkToPositions(db, row.id, contracts);
    });
  }

  // --- reading one combo --------------------------------------------------------------------
  private async combo(args: string[]): Promise<string> {
    if (args.length === 0) return "Usage: /combo <name>";
    const row = findComboByName(this.deps.db, args[0]!);
    if (!row) return `No combo named '${args[0]}'.`;
    const monitor = toMonitor(row);
    const codes = monitorLegCodes(monitor);
    let records: QuoteRecord[];
    try {
      records = await this.deps.fetchQuotes([...new Set(codes)].sort());
    } catch (err) {
      return `Combo failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const byCode = Object.fromEntries(records.map((r) => [String(r.code), r]));

    const rows: string[][] = [];
    let total = 0;
    let complete = true;
    for (const [index, leg] of (monitor.legs ?? []).entries()) {
      const code = codes[index]!;
      const value = byCode[code]?.[monitor.field];
      const sign = leg.sign > 0 ? "+" : "-";
      if (value === undefined || value === null) {
        rows.push([sign, shortCode(code), "—"]);
        complete = false;
      } else {
        total += leg.sign * Number(value);
        rows.push([sign, shortCode(code), fmtValue(monitor.field, Number(value))]);
      }
    }
    // 4dp on the total, as the Python rounds it: a signed sum of three-decimal mids otherwise shows
    // float noise in a figure read as a price
    const totalCell = complete ? fmtValue(monitor.field, round4(total)) : "incomplete";
    rows.push(["", "total", totalCell]);
    return table(["", "leg", FIELD_SHORT[monitor.field] ?? monitor.field], rows);
  }

  // --- changing -----------------------------------------------------------------------------
  private matches(args: string[]): MonitorRow[] {
    const token = args[0] ?? "";
    const joined = args.join("").toUpperCase();
    const short = SHORT_CONTRACT.exec(joined);
    const expanded = short ? `US.SPXW${short[1]}${short[2]}${short[3]}000` : null;
    return findMonitorsByIdentifier(this.deps.db, token, joined, expanded);
  }

  private threshold(args: string[]): string {
    const usage = "Usage: /threshold <name, code, id prefix, or contract> <value>";
    if (args.length < 2) return usage;
    let value: number;
    try {
      value = requireNumber(args.at(-1)!);
    } catch {
      return usage;
    }
    const identifier = args.slice(0, -1);
    const found = this.matches(identifier);
    if (found.length === 0) return `No monitor matches '${identifier.join(" ")}'.`;
    if (found.length > 1) {
      return "Ambiguous — matches: " + found.map((m) => m.code).join(", ");
    }
    const monitor = found[0]!;
    const bad = thresholdError(value, monitor.compare);
    if (bad) return bad;
    updateMonitorFields(this.deps.db, monitor.id, { threshold: value });
    return ruleText(monitor.code, monitor.field, value, monitor.direction, monitor.compare);
  }

  private rename(args: string[]): string {
    if (args.length !== 2) return "Usage: /rename <old combo name> <new name>";
    const [old, next] = args as [string, string];
    const row = findComboByName(this.deps.db, old);
    if (!row) return `No combo named '${old}'.`;
    if (findMonitorByCodeField(this.deps.db, next, row.field, row.id)) {
      return `'${next}' is already taken.`;
    }
    updateMonitorFields(this.deps.db, row.id, { code: next });
    return `Renamed ${old} → ${next} (alarm state and history kept).`;
  }

  private async unwatch(args: string[]): Promise<string> {
    if (args.length === 0) {
      return "Usage: /unwatch <name, code, id prefix, or contract like 260918 C8100>";
    }
    const found = this.matches(args);
    if (found.length === 0) return `No monitor matches '${args.join(" ")}'.`;
    if (found.length > 1) {
      return "Ambiguous — matches: " + found.map((m) => m.id.slice(0, 8)).join(", ");
    }
    const monitor = found[0]!;
    // the links go first: deleting a linked monitor is refused by the foreign key, and every monitor
    // in the live database is linked (#70). The Position stays — it is a holding.
    await atomic(this.deps.db, () => {
      clearMonitorLinks(this.deps.db, monitor.id);
      deleteMonitorRow(this.deps.db, monitor.id);
    });
    return `Removed monitor for ${monitor.code}.`;
  }

  // --- one contract, and the service itself -------------------------------------------------
  private async snapshot(args: string[]): Promise<string> {
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
      records = await this.deps.fetchQuotes([code]);
    } catch (err) {
      return `Snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
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
  }

  private health(): string {
    const lines: string[] = [];
    if (this.deps.worker) lines.push(`queue depth: ${this.deps.worker.queueDepth()}`);
    if (this.deps.sweeper) {
      const { label } = this.deps.sweeper.alarmState();
      const sweptAt = displayTimeShort(this.deps.sweeper.lastSweepAt(), this.deps.settings.displayTz);
      lines.push(`alarms: ${label}${sweptAt ? ` — last sweep ${sweptAt}` : ""}`);
    }
    return lines.length > 0 ? `Service is up.\n${lines.join("\n")}` : "Service is up.";
  }
}

/** `float(x)` in the Python: anything unparseable is a usage error, not NaN. */
function requireNumber(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`not a number: ${text}`);
  return value;
}

/** The trailing `[field] [above|below] [signed]` words, in any order. */
function modifiers(extras: string[], defaultField: string) {
  let field = defaultField;
  let direction = "above";
  let compare = "abs";
  for (const extra of extras) {
    const low = extra.toLowerCase();
    if (low === "above" || low === "below") direction = low;
    else if (low === "signed") compare = "signed";
    else field = extra;
  }
  return { field, direction, compare };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
