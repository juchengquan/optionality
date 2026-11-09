/** What a command is, and what it is given.
 *
 *  A command answers with the TEXT of its reply and nothing else — no sending, no chat id, no
 *  Telegram API. That is what lets each one be driven directly by a test, and it is why the
 *  transport in `../bot.ts` can hold the only `api` call in the package: the only thing a command
 *  may do with the outside world is make its one bounded market-data call.
 *
 *  Faults come back as sentences rather than exceptions, because a chat is the error channel here:
 *  there is nowhere else to put a usage error, and a throw would reach the long-poll loop, be
 *  logged, and leave the owner's message unanswered.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Settings } from "../../../env.ts";
import type { SweeperPort } from "../../../ports.ts";
import type { QuoteFetcher } from "../../../quotes.ts";

export interface BotContext {
  db: DatabaseSync;
  settings: Settings;
  /** the one bounded call a command may make (CLAUDE.md's invariant) */
  fetchQuotes: QuoteFetcher;
  /** absent in a test that is not about the engine's own health */
  sweeper?: SweeperPort;
  /** injectable, so a test states the time rather than waiting for it */
  now(): Date;
}

/** The arguments are the words after the command, already split. Parsing them is each command's
 *  own business — `/watch` takes a date and a strike, `/unwatch` takes anything that might name a
 *  rule — and there is no shared grammar to put above them. */
export type Command = (ctx: BotContext, args: string[]) => string | Promise<string>;

/** `float(x)` in the Python: anything unparseable is a usage error, not NaN. */
export function requireNumber(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`not a number: ${text}`);
  return value;
}

/** What create-monitor.ts needs: the database, one Provider and a clock. */
export function creating(ctx: BotContext) {
  return { db: ctx.db, fetchQuotes: ctx.fetchQuotes, now: () => ctx.now() };
}

/** A failed market-data call, said the way each table says it.
 *
 *  Every command that leaves the machine catches, because a Provider that is down must produce a
 *  sentence in the chat rather than a logged throw and a silence on the phone.
 */
export function failed(label: string, err: unknown): string {
  return `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** The reply every table command gives for an empty watchlist. One sentence, in one place. */
export const EMPTY_WATCHLIST = "Watchlist is empty. Add one with /watch.";
