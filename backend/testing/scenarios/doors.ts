/** The service's three doors (ADR 0020), opened on a scenario's world: one request, one Telegram
 *  update, or one tick of the sweep, and what each did (ADR 0021, Decision 4).
 *
 *  This is the TypeScript's half of the replay, and the Python runner in phase 2 mirrors it, so it
 *  is kept to the steps the README names and nothing clever:
 *
 *    1. open the world (`world.ts`) and build the service on it — the real engine, the real routes,
 *       the real bot, with only the vendors, Telegram, the clock and the ids faked;
 *    2. run the earlier sweeps, each at its own instant, and check they left the tables alone;
 *    3. set the clock to the event, forget the earlier calls and messages, and dump the tables;
 *    4. do the one thing, dump again, and report the difference with what was said and asked.
 *
 *  The one file outside `src/` that reaches the engine and the entrypoints. Declared in
 *  `tools/check-seams.mjs` under both seams, with its reason, rather than tunnelled through
 *  `harness.ts` — whose app is a different world (an echo Provider, a sweeper that never sweeps).
 */
import { type Deps, createApp } from "../../src/entrypoints/http/index.ts";
import { TelegramBot } from "../../src/entrypoints/bot/bot.ts";
import { MonitorSweeper } from "../../src/engine/index.ts";
import type {
  BotExpect, BotScenario, Calls, HttpExpect, HttpScenario, SweepExpect, SweepScenario, Tables,
  World,
} from "./format.ts";
import { type OpenWorld, diffTables, dumpTables, openWorld } from "./world.ts";

/** The service logs every write, refusal and sweep; a corpus of a hundred events would bury the
 *  one line that matters when something fails. Silenced for the event and put back after. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const hush = () => { /* the service's own log, not the scenario's business */ };
  Object.assign(console, { log: hush, info: hush, warn: hush, error: hush });
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Calls in a stable order: vendors by name, each vendor's calls as they were made. */
function ordered(calls: Calls): Calls {
  return Object.fromEntries(Object.keys(calls).sort().map((name) => [name, calls[name]!]));
}

interface Opened {
  world: OpenWorld;
  sweeper: MonitorSweeper;
  before: Tables;
}

/** Steps 1 to 3: the service built on the world, with its memory, at the event's instant. */
async function open(world: World): Promise<Opened> {
  const w = openWorld(world);
  try {
    const sweeper = new MonitorSweeper({
      db: w.db, settings: w.settings, fetchQuotes: w.provider.fetchQuotes, send: w.send,
      now: () => w.clock.now,
    });
    for (const earlier of world.sweeps) {
      w.clock.now = new Date(earlier.at);
      w.outage.down = earlier.down;
      await sweeper.sweep();
    }
    const before = dumpTables(w.db);
    const touched = diffTables(w.db, world.tables, before);
    if (Object.keys(touched).length > 0) {
      throw new Error("an earlier sweep changed the tables; state them as the event finds them "
        + `and keep the sweeps for the engine's memory:\n${JSON.stringify(touched, null, 2)}`);
    }
    w.clock.now = new Date(world.clock);
    w.outage.down = world.provider.down;
    for (const name of Object.keys(w.calls)) delete w.calls[name];
    w.sent.length = 0;
    return { world: w, sweeper, before };
  } catch (err) {
    w.close();
    throw err;
  }
}

/** One request through the HTTP door. */
export async function runHttp(
  scenario: Pick<HttpScenario, "world" | "request">,
): Promise<HttpExpect> {
  return quietly(async () => {
    const { world: w, sweeper, before } = await open(scenario.world);
    try {
      const deps: Deps = {
        settings: w.settings,
        db: w.db,
        now: () => w.clock.now,
        newId: w.newId,
        sweeper: sweeper.health,
        provider: { ...w.provider, close: () => { /* nothing to hang up */ } },
        sources: w.sources,
      };
      const { method, path, headers, body } = scenario.request;
      const init: RequestInit = { method, headers: { ...headers } };
      if (body !== null) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      }
      const resp = await createApp(deps).request(path, init);
      const text = await resp.text();
      const json = (resp.headers.get("content-type") ?? "").includes("application/json");
      return {
        response: { status: resp.status, body: text === "" ? null : json ? JSON.parse(text) : text },
        rows: diffTables(w.db, before, dumpTables(w.db)),
        calls: ordered(w.calls),
      };
    } finally {
      w.close();
    }
  });
}

/** One Telegram update through the bot door, answered through a fake Telegram API. */
export async function runBot(scenario: Pick<BotScenario, "world" | "update">): Promise<BotExpect> {
  return quietly(async () => {
    const { world: w, sweeper, before } = await open(scenario.world);
    try {
      const replies: Record<string, string>[] = [];
      const bot = new TelegramBot({
        db: w.db,
        settings: w.settings,
        api: async (method, params) => {
          if (method === "sendMessage") replies.push(params);
          return {};
        },
        fetchQuotes: w.provider.fetchQuotes,
        sweeper: sweeper.health,
        now: () => w.clock.now,
        newId: w.newId,
      });
      await bot.handleUpdate(scenario.update);
      if (replies.length > 1) throw new Error("the bot answered one message twice");
      const sent = replies[0];
      return {
        reply: sent === undefined ? null : {
          chat_id: sent.chat_id!, text: sent.text!, parse_mode: sent.parse_mode ?? null,
        },
        rows: diffTables(w.db, before, dumpTables(w.db)),
        calls: ordered(w.calls),
      };
    } finally {
      w.close();
    }
  });
}

/** One tick of the sweep, at the world's clock. */
export async function runSweep(scenario: Pick<SweepScenario, "world">): Promise<SweepExpect> {
  return quietly(async () => {
    const { world: w, sweeper, before } = await open(scenario.world);
    try {
      await sweeper.sweep();
      return {
        messages: [...w.sent],
        rows: diffTables(w.db, before, dumpTables(w.db)),
        calls: ordered(w.calls),
      };
    } finally {
      w.close();
    }
  });
}

/** The commands the bot ANNOUNCES — the "/" menu it publishes to Telegram on start — which is the
 *  bot door's own account of itself, as `/openapi.json` is the HTTP door's. The coverage guard
 *  reads this rather than importing the list, so it holds the door to what it tells the world. */
export async function announcedCommands(world: World): Promise<string[]> {
  const w = openWorld(world);
  try {
    let menu = "[]";
    const bot = new TelegramBot({
      db: w.db, settings: w.settings, fetchQuotes: w.provider.fetchQuotes,
      api: async (method, params) => {
        if (method === "setMyCommands") menu = params.commands ?? "[]";
        return [];
      },
    });
    await quietly(() => bot.start());
    return (JSON.parse(menu) as { command: string }[]).map((c) => c.command);
  } finally {
    w.close();
  }
}
