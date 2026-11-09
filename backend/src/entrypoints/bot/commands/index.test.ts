/** The command table, as a table.
 *
 *  `dispatch` was a 40-line switch that also held the column mappers for three of the replies, so
 *  the long-poll loop's file knew every command's name and half their formatting. Now the set is
 *  data, and these are the two things a `switch` could not be asked:
 *
 *  - every command the "/" menu announces is one the bot will answer, and
 *  - every command the bot answers is announced.
 *
 *  Neither held before. `help` worked only by falling through `default`, so it was announced and
 *  not registered; nothing would have caught the reverse either.
 */
import { describe, expect, it } from "vitest";

import { COMMANDS } from "./index.ts";
import { BOT_COMMANDS } from "../format.ts";

describe("the command table", () => {
  it("answers exactly what the / menu announces", () => {
    // Telegram shows BOT_COMMANDS as autocomplete, so a name there that the bot does not answer
    // is an offer the owner taps and gets the help text for
    expect(Object.keys(COMMANDS).sort()).toEqual([...BOT_COMMANDS].map((c) => c.command).sort());
  });

  it("names every command in lower case, which is what dispatch compares", () => {
    // `/Watch` and `/watch@thebot` both arrive, and dispatch lower-cases and strips before it
    // looks here — a capitalised key would simply never be found
    for (const name of Object.keys(COMMANDS)) expect(name).toBe(name.toLowerCase());
  });
});
