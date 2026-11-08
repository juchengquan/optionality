/** Every command the bot answers, by the name the owner types.
 *
 *  A table rather than a switch, which is the point of this directory. `dispatch` held forty lines
 *  of `case` — including the column mappers for three of the replies — so the file with the
 *  long-poll loop in it knew every command's name and half of their formatting. Now the loop looks
 *  a name up here and knows nothing else, and the set can be compared with the "/" menu that
 *  announces it (index.test.ts).
 *
 *  `UNKNOWN` is deliberately not a member: a word that is not a command is not a failure, it is
 *  somebody who does not know the commands, and the help text is the answer.
 */
import type { Command } from "./context.ts";
import { combo, greeks, monitors, quotes, vol } from "./watchlist.ts";
import { watch, watchcombo } from "./create.ts";
import { rename, threshold, unwatch } from "./edit.ts";
import { health, help, holdings, snapshot } from "./service.ts";

export type { BotContext, Command } from "./context.ts";

export const COMMANDS: Readonly<Record<string, Command>> = {
  combo,
  greeks,
  health,
  help,
  holdings,
  monitors,
  quotes,
  rename,
  snapshot,
  threshold,
  unwatch,
  vol,
  watch,
  watchcombo,
};

/** What an unrecognised word gets. */
export const UNKNOWN: Command = help;
