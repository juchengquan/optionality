/** The bot door's scenarios, as inputs: a world and one message each (ADR 0021).
 *
 *  `coverage.test.ts` holds this list to the "/" menu the bot publishes: every command it
 *  announces has at least one scenario here. The rest are the branches a phone can reach — a usage
 *  error, a refusal in the bot's own words, a Provider that is down, a stranger.
 */
import type { Update, World } from "../format.ts";
import {
  BOOK, C7300, C7350, C7500, at, combo, except, link, message, monitor, position, world,
} from "./fixtures.ts";

export interface BotInput {
  name: string;
  world: World;
  update: Update;
}

const DOWN = "connect ECONNREFUSED 127.0.0.1:33333";

/** The same book the HTTP scenarios use: the condor held, a delta rule on its short call, a combo
 *  on its call spread, both linked. */
const held = {
  positions: [position({ id: "pos-1" })],
  monitors: [
    monitor({
      id: "mon-1", scope: "leg", triggered: 1, last_value: 0.312,
      last_checked_at: "2026-11-09 14:59:45.000000", last_alarm_at: "2026-11-09 14:40:00.000000",
    }),
    combo({
      id: "mon-2", scope: "calls", last_value: -1, last_checked_at: "2026-11-09 14:59:45.000000",
    }),
  ],
  monitor_positions: [link("mon-1", "pos-1"), link("mon-2", "pos-1")],
};

export const BOT: readonly BotInput[] = [
  {
    name: "/holdings values each holding in a four-column table",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/holdings"),
  },
  {
    name: "/holdings with nothing held",
    world: world(),
    update: message("/holdings"),
  },
  {
    name: "/holdings says so when the Provider is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    update: message("/holdings"),
  },
  {
    name: "/monitors lists the stored rules without asking the Provider",
    world: world({ tables: held }),
    update: message("/monitors"),
  },
  {
    // Telegram appends the bot's name in a group and the keyboard capitalises
    name: "/Monitors@optionality_bot is still /monitors",
    world: world({ tables: held }),
    update: message("/Monitors@optionality_bot"),
  },
  {
    name: "/monitors on an empty watchlist",
    world: world(),
    update: message("/monitors"),
  },
  {
    name: "/quotes prices the single-leg rules with the bell from the same reading",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/quotes"),
  },
  {
    name: "/quotes says so when the Provider is down",
    world: world({ tables: held, provider: { down: DOWN } }),
    update: message("/quotes"),
  },
  {
    name: "/quotes on an empty watchlist asks the Provider nothing",
    world: world(),
    update: message("/quotes"),
  },
  {
    name: "/greeks shows delta gamma and theta",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/greeks"),
  },
  {
    name: "/vol shows IV and vega",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/vol"),
  },
  {
    name: "/watch adds a rule and links it to the holding of its contract",
    world: world({ tables: { positions: [position({ id: "pos-1" })] }, provider: { quotes: BOOK } }),
    update: message("/watch 2026-12-18 call 7300 0.3"),
  },
  {
    name: "/watch takes a field a direction and a signed compare in any order",
    world: world({ provider: { quotes: BOOK } }),
    update: message("/watch 20261218 PUT 6400 -0.25 signed below"),
  },
  {
    name: "/watch with too few words answers with its usage",
    world: world(),
    update: message("/watch 2026-12-18 CALL 7300"),
  },
  {
    name: "/watch refuses a rule already there without asking the Provider",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/watch 2026-12-18 CALL 7300 0.35"),
  },
  {
    name: "/watch refuses a contract the Provider does not know",
    world: world({ provider: { unknown: [C7500] } }),
    update: message("/watch 2026-12-18 CALL 7500 0.3"),
  },
  {
    name: "/watch refuses a zero threshold in the bot's own words",
    world: world({ provider: { quotes: BOOK } }),
    update: message("/watch 2026-12-18 CALL 7300 0"),
  },
  {
    name: "/watchcombo adds a combo from signed legs",
    world: world({ provider: { quotes: BOOK } }),
    update: message("/watchcombo dec-calls 2026-12-18 -C7300 +C7350 4"),
  },
  {
    name: "/watchcombo with one leg answers with its usage",
    world: world(),
    update: message("/watchcombo dec-calls 2026-12-18 -C7300 4"),
  },
  {
    name: "/unwatch removes a rule named by its short contract and keeps the holding",
    world: world({ tables: held }),
    update: message("/unwatch 261218 C7300"),
  },
  {
    name: "/unwatch names nothing it cannot match",
    world: world({ tables: held }),
    update: message("/unwatch 261218 C9999"),
  },
  {
    // every match rather than the first: silently picking one is how the wrong alarm gets deleted
    name: "/unwatch refuses an id prefix that matches more than one rule",
    world: world({ tables: held }),
    update: message("/unwatch mon"),
  },
  {
    name: "/combo breaks a combo into its legs with the signed total",
    world: world({ tables: held, provider: { quotes: BOOK } }),
    update: message("/combo dec-calls"),
  },
  {
    // no partial sums
    name: "/combo calls the total incomplete when a leg is unpriced",
    world: world({ tables: held, provider: { quotes: except(BOOK, C7350) } }),
    update: message("/combo dec-calls"),
  },
  {
    // a quantity per leg (#351): the 7350 sold twice over, said beside its sign and counted twice
    name: "/combo counts a leg's quantity in the total",
    world: world({
      tables: { monitors: [combo({
        id: "mon-ratio", code: "dec-ratio",
        legs: [{ sign: 1, option_type: "CALL", strike: 7300 }, { sign: -1, option_type: "CALL", strike: 7350, qty: 2 }],
      })] },
      provider: { quotes: BOOK },
    }),
    update: message("/combo dec-ratio"),
  },
  {
    // a derived name keeps every leg (#351), and the table shortens one it cannot fit in its middle
    // rather than letting the row wrap on the phone
    name: "/monitors shortens a name too long for the table",
    world: world({
      tables: { monitors: [combo({ id: "mon-long", code: "1218_+P6350_-2P6400_-C7300_+2C7350" })] },
    }),
    update: message("/monitors"),
  },
  {
    name: "/combo names nothing it cannot find",
    world: world({ tables: held }),
    update: message("/combo dec-puts"),
  },
  {
    name: "/threshold moves a rule named by its code",
    world: world({ tables: held }),
    update: message(`/threshold ${C7300} 0.35`),
  },
  {
    name: "/threshold refuses a zero threshold",
    world: world({ tables: held }),
    update: message("/threshold dec-calls 0"),
  },
  {
    name: "/rename renames a combo and keeps its alarm state",
    world: world({ tables: held }),
    update: message("/rename dec-calls dec-call-spread"),
  },
  {
    name: "/rename refuses a name already taken",
    world: world({
      tables: { ...held, monitors: [...held.monitors, combo({ id: "mon-3", code: "dec-wing" })] },
    }),
    update: message("/rename dec-calls dec-wing"),
  },
  {
    name: "/snapshot quotes a contract nothing watches",
    world: world({ provider: { quotes: BOOK } }),
    update: message("/snapshot 2026-12-18 CALL 7350"),
  },
  {
    name: "/snapshot says when there is no data",
    world: world(),
    update: message("/snapshot 2026-12-18 CALL 7500"),
  },
  {
    name: "/health on a service that has not swept yet",
    world: world(),
    update: message("/health"),
  },
  {
    name: "/health after a sweep names when it ran",
    world: world({
      tables: { positions: [position({ id: "pos-1" })] },
      sweeps: [{ at: at(-10), down: null }],
    }),
    update: message("/health"),
  },
  {
    name: "/help lists the commands",
    world: world(),
    update: message("/help"),
  },
  {
    name: "a word that is not a command gets the help",
    world: world(),
    update: message("what is my delta"),
  },
  {
    // the TypeScript's table is a plain object, so a name Object.prototype has was found there and
    // crashed the reply; the Python's mapping never had the bug, and this holds both to the help
    name: "a name every object has is not a command",
    world: world(),
    update: message("/constructor"),
  },
  {
    // a reply would confirm the bot exists to whoever found it
    name: "a message from any other chat gets no reply",
    world: world({ tables: held }),
    update: message("/unwatch 261218 C7300", 666),
  },
];
