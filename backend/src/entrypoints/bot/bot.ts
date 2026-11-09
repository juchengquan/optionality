/** The Telegram bot's transport: the long poll, the owner check, and the reply.
 *
 *  Long-polls getUpdates and answers commands, from the owner chat only.
 *
 *  **The token allows ONE getUpdates consumer** (CLAUDE.md), so this must never run beside a
 *  second service instance against the same token, and no test may reach the real API. The tests
 *  drive `handleUpdate` directly with a fake, exactly as the Python's did.
 *
 *  What the commands THEMSELVES do is `commands/`, and this file knows none of their names. It
 *  held a forty-line `switch` with three of the replies' column mappers inside it, so the file
 *  with the poll loop in it was also where `/greeks` decided how many decimals a gamma gets. Now
 *  a command is a function from a context and some words to the text of a reply, the set is a
 *  table, and the table can be held to the "/" menu that announces it.
 */
import type { DatabaseSync } from "node:sqlite";

import { COMMANDS, UNKNOWN, type BotContext } from "./commands/index.ts";
import { BOT_COMMANDS } from "./format.ts";
import type { Settings } from "../../env.ts";
import type { SweeperPort } from "../../ports.ts";
import type { QuoteFetcher } from "optionality/quotes";

/** One call to the Telegram API. A fake in tests; HTTPS in production. */
export type TelegramApi = (method: string, params: Record<string, string>) => Promise<unknown>;

export interface BotDeps {
  db: DatabaseSync;
  settings: Settings;
  api: TelegramApi;
  fetchQuotes: QuoteFetcher;
  sweeper?: SweeperPort;
  now?: () => Date;
  /** the id a created rule gets; a uuid unless a door scenario states it (ADR 0021) */
  newId?: () => string;
}

interface Update {
  update_id?: number;
  message?: { chat?: { id?: unknown }; text?: unknown };
}

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

  /** The command, if the words name one, and the help text if they do not.
   *
   *  `/watch@thebot` and `/Watch` both arrive — Telegram appends the bot's username in a group
   *  and the keyboard capitalises — so the name is stripped and lower-cased before the lookup.
   */
  async dispatch(text: string): Promise<string> {
    const parts = text.split(/\s+/);
    const first = parts[0] ?? "";
    const name = first.startsWith("/") ? first.split("@")[0]!.slice(1).toLowerCase() : "";
    const command = COMMANDS[name] ?? UNKNOWN;
    return command(this.context(), parts.slice(1));
  }

  /** What a command is given: no chat id and no `api`, so a command cannot reply twice or to
   *  somebody else. Built per dispatch because the clock is read through it. */
  private context(): BotContext {
    return {
      db: this.deps.db,
      settings: this.deps.settings,
      fetchQuotes: this.deps.fetchQuotes,
      sweeper: this.deps.sweeper,
      now: () => this.now(),
      newId: this.deps.newId,
    };
  }
}
