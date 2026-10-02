/** The Telegram bot. Ported from tests/test_telegram_bot.py (ADR 0009, phase 7).
 *
 *  Driven through `handleUpdate` with a fake API, exactly as the Python's tests are — and for a reason
 *  that is not convenience: the token allows ONE getUpdates consumer, the Python service is holding it,
 *  and a test that reached the real API would either fail or steal the owner's updates. The real thing
 *  is first exercised at cutover (ADR 0009, phase 9).
 *
 *  Replies are asserted character for character where the formatting is the point. They are read on a
 *  phone, and a column that wraps is a table that cannot be read at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "../domain/contract.ts";
import { createDatabase } from "../db/open.ts";
import { toSqliteJson } from "../db/values.ts";
import { settingsFor, type Settings } from "../env.ts";
import type { QuoteFetcher, QuoteRecord } from "../quotes.ts";
import { TelegramBot } from "./bot.ts";

/** Fixed, so a date-relative expectation cannot drift into a different market day overnight. */
const NOW = new Date("2026-10-02T05:00:00Z");
const FUTURE = "2026-11-01";
const YYMMDD = "261101";
const FAR = "2026-11-11";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let sent: string[];
let calls: [string, Record<string, string>][];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-bot-"));
  db = createDatabase(join(dir, "test.db"));
  sent = [];
  calls = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const echo: QuoteFetcher = (codes) => Promise.resolve(codes.map((code) => ({ code })));

function bot(fetchQuotes: QuoteFetcher = echo, over: Partial<Settings> = {}, extra = {}) {
  return new TelegramBot({
    db,
    settings: settingsFor({ telegramBotToken: "t", telegramChatId: "42", ...over }),
    api: async (method, params) => {
      calls.push([method, params]);
      if (method === "sendMessage") {
        sent.push(params.text!);
        return {};
      }
      return [];
    },
    fetchQuotes,
    now: () => NOW,
    ...extra,
  });
}

const update = (text: string, chatId: number | string = 42) =>
  ({ update_id: 1, message: { chat: { id: chatId }, text } });

const last = () => sent.at(-1) ?? "";
const lastParams = () => calls.at(-1)?.[1] ?? {};
const monitors = () => db.prepare("select * from monitors").all() as {
  id: string; code: string; strike_date: string; field: string; threshold: number;
  direction: string; compare: string; legs: string | null;
}[];

describe("who may command it", () => {
  it("ignores a message from any other chat, without replying", async () => {
    // a reply would confirm the bot exists to whoever found it
    await bot().handleUpdate(update("/monitors", 999));
    expect(sent).toEqual([]);
  });

  it("ignores a message with no text", async () => {
    await bot().handleUpdate({ update_id: 1, message: { chat: { id: 42 } } });
    expect(sent).toEqual([]);
  });

  it("answers anything it does not recognise with the help", async () => {
    const b = bot();
    await b.handleUpdate(update("hello there"));
    expect(last()).toContain("/watch");
    await b.handleUpdate(update("/nonsense"));
    expect(last()).toContain("/watch");
  });

  it("takes a command addressed to it by name, as a group chat sends them", async () => {
    await bot().handleUpdate(update("/monitors@optionality_bot"));
    expect(last()).toContain("empty");
  });
});

describe("/watch", () => {
  it("creates a monitor, and says so if one already exists", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    expect(last().toLowerCase()).toContain("watching");
    expect(monitors()).toHaveLength(1);
    expect(monitors()[0]!.code).toMatch(/C6500000$/);
    expect(monitors()[0]!.threshold).toBe(0.6);

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.7`));
    expect(last().toLowerCase()).toContain("already");
    expect(monitors()[0]!.threshold).toBe(0.6);
  });

  it("normalises a compact date", async () => {
    await bot().handleUpdate(update(`/watch ${FUTURE.replaceAll("-", "")} CALL 6500 0.6`));
    expect(monitors()[0]!.strike_date).toBe(FUTURE);
  });

  it("takes a field, a direction and the signed keyword in any order", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 30 mid_price below`));
    expect(last()).toContain("≤");
    expect(monitors()[0]!.direction).toBe("below");
    expect(monitors()[0]!.field).toBe("mid_price");

    await b.handleUpdate(update("/monitors"));
    expect(last()).toContain("≤30.0"); // the threshold cell carries the direction
  });

  it("replies with usage for anything it cannot read", async () => {
    const b = bot();
    for (const text of [
      "/watch nope", "/watch", `/watch ${FUTURE} SIDEWAYS 6500 0.6`,
      `/watch ${FUTURE} CALL six 0.6`, `/watch ${FUTURE} CALL 6500 lots`,
      "/watch 18-12-2026 CALL 6500 0.6",
    ]) {
      await b.handleUpdate(update(text));
      expect(last().toLowerCase(), text).toContain("usage");
    }
    expect(monitors()).toEqual([]);
  });

  it("refuses a contract moomoo does not have, and creates nothing", async () => {
    const poison: QuoteFetcher = (codes) =>
      Promise.reject(new Error(`snapshot API failed: Unknown stock. ${codes[0]!.slice(3)}`));
    await bot(poison).handleUpdate(update(`/watch ${FUTURE} CALL 99999 0.5`));
    expect(last()).toContain("does not exist");
    expect(monitors()).toEqual([]);
  });

  it("refuses a non-positive threshold, with the advice that fixes it", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 -0.5`));
    expect(last().toLowerCase()).toContain("positive");
    expect(last()).toContain("signed"); // the wording tells you what to add
    expect(monitors()).toEqual([]);
  });
});

describe("/watchcombo", () => {
  const prices = (values: Record<string, number>): QuoteFetcher =>
    (codes) => Promise.resolve(
      codes.filter((c) => c in values).map((c) => ({ code: c, mid_price: values[c] })),
    );

  it("creates a combo and shows its per-leg breakdown", async () => {
    const a = buildSpxCode(FUTURE, "CALL", 8100);
    const c = buildSpxCode(FUTURE, "CALL", 8150);
    const b = bot(prices({ [a]: 26.4, [c]: 19.25 }));

    await b.handleUpdate(update(`/watchcombo sep-condor ${FUTURE} +C8100 -C8150 10 below`));
    expect(last()).toContain("sep-condor");
    expect(last()).toContain("≤");
    const m = monitors()[0]!;
    expect(m.code).toBe("sep-condor");
    expect(m.field).toBe("mid_price"); // the combo default
    expect(m.direction).toBe("below");
    expect(JSON.parse(m.legs!).map((l: { sign: number }) => l.sign)).toEqual([1, -1]);

    await b.handleUpdate(update("/combo sep-condor"));
    const reply = last();
    expect(reply.startsWith("<pre>")).toBe(true);
    expect(reply).toContain("26.4");
    expect(reply).toContain("19.25");
    expect(reply).toContain("total");
    expect(reply).toContain("7.15"); // 26.4 − 19.25

    await b.handleUpdate(update("/monitors"));
    expect(last()).toContain("sep-condor");

    await b.handleUpdate(update("/unwatch sep-condor"));
    expect(last().toLowerCase()).toContain("removed");
    expect(monitors()).toEqual([]);
  });

  it("needs two legs to be a combo", async () => {
    const b = bot();
    // four arguments is caught by the arity guard before the legs are even counted
    await b.handleUpdate(update(`/watchcombo broken ${FUTURE} +C8100 10`));
    expect(last().toLowerCase()).toContain("usage");
    // five, with one leg, is what reaches the leg count — a one-leg "combo" is a single-leg monitor
    // wearing a name, and its signed sum would be the leg itself
    await b.handleUpdate(update(`/watchcombo broken ${FUTURE} +C8100 10 mid_price`));
    expect(last().toLowerCase()).toContain("usage");
    expect(monitors()).toEqual([]);
  });

  it("takes the signed keyword, and a negative threshold with it", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo bear-cs ${FUTURE} -C8100 +C8150 -4.05 signed below`));
    expect(last()).toContain("-4.05");
    const m = monitors()[0]!;
    expect(m.compare).toBe("signed");
    expect(m.threshold).toBe(-4.05);
    expect(m.direction).toBe("below");
  });

  it("refuses a negative threshold without it", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo x ${FUTURE} +C8100 -C8150 -4.05`));
    expect(last().toLowerCase()).toContain("positive");
    expect(monitors()).toEqual([]);
  });

  it("refuses implied volatility, because it does not add", async () => {
    const b = bot();
    await b.handleUpdate(update(
      `/watchcombo iv-x ${FUTURE} +C8100 +C8150 10 option_implied_volatility`,
    ));
    expect(last()).toContain("option_implied_volatility");
    expect(last()).toContain("not additive");
    expect(monitors()).toEqual([]);
  });

  it("shows an incomplete total rather than a part sum", async () => {
    // no partial sums, ever: a combo missing a leg has no value, and 26.4 alone is not one.
    // Both legs must exist at creation — the gate demands it — so one is dropped afterwards.
    const a = buildSpxCode(FUTURE, "CALL", 8100);
    const c = buildSpxCode(FUTURE, "CALL", 8150);
    let complete = true;
    const b = bot((codes) => Promise.resolve(
      codes.filter((x) => complete || x !== c)
        .map((x) => ({ code: x, mid_price: x === a ? 26.4 : 19.25 })),
    ));
    await b.handleUpdate(update(`/watchcombo half ${FUTURE} +C8100 -C8150 10 below`));
    expect(last().toLowerCase()).toContain("watching");
    complete = false;
    await b.handleUpdate(update("/combo half"));
    expect(last()).toContain("incomplete");
    expect(last()).toContain("26.4"); // the priced leg still shows; only the total refuses
    expect(last()).toContain("—"); // and the missing one says so
  });

  it("says so for a combo that does not exist", async () => {
    await bot().handleUpdate(update("/combo ghost"));
    expect(last()).toBe("No combo named 'ghost'.");
  });
});

describe("/monitors", () => {
  it("is a table, parsed as HTML, with short contract labels", async () => {
    const b = bot();
    await b.handleUpdate(update("/monitors"));
    expect(last().toLowerCase()).toContain("empty");

    await b.handleUpdate(update(`/watch ${FUTURE} PUT 6425 0.5`));
    await b.handleUpdate(update("/monitors"));
    const reply = last();
    expect(reply.startsWith("<pre>")).toBe(true);
    expect(reply.endsWith("</pre>")).toBe(true);
    expect(reply).toContain(`${YYMMDD} P6425`); // not the full moomoo code
    expect(reply).toContain("armed");
    expect(lastParams().parse_mode).toBe("HTML");
  });

  it("groups by expiry, then calls before puts", async () => {
    // so a condor's legs stay together instead of splitting across CALL and PUT blocks
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} PUT 6425 0.5`));
    await b.handleUpdate(update(`/watch ${FAR} CALL 8100 0.6`));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update("/monitors"));
    const reply = last();
    expect(reply.indexOf("C6500")).toBeLessThan(reply.indexOf("P6425"));
    expect(reply.indexOf("P6425")).toBeLessThan(reply.indexOf("C8100"));
  });

  it("shows the bell, and that a disabled monitor is off", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    const id = monitors()[0]!.id;
    db.prepare("update monitors set triggered = 1, last_value = 0.7123 where id = ?").run(id);
    await b.handleUpdate(update("/monitors"));
    expect(last()).toContain("🔔");
    expect(last()).toContain("0.712"); // three places for a delta

    db.prepare("update monitors set enabled = 0 where id = ?").run(id);
    await b.handleUpdate(update("/monitors"));
    expect(last()).toContain("off");
  });

  it("shows four places for a field with no format of its own", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 30 mid_price`));
    db.prepare("update monitors set last_value = 26.41235").run();
    await b.handleUpdate(update("/monitors"));
    // four places, rounded on the stored double exactly as Python's .4f does — checked against it
    // across a range of values by make diff-api
    expect(last()).toContain("26.4123");
  });

  it("shows an em dash for a monitor that has never been swept", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update("/monitors"));
    expect(last()).toContain("—");
  });
});

describe("the live tables", () => {
  const quoting = (fields: QuoteRecord): QuoteFetcher =>
    (codes) => Promise.resolve(codes.map((code) => ({ code, ...fields })));

  it("/quotes is a pure price view", async () => {
    const b = bot(quoting({
      name: "NAME", option_delta: 0.42, bid_price: 1.0, ask_price: 2.0, mid_price: 1.5,
    }));
    await b.handleUpdate(update("/quotes"));
    expect(last().toLowerCase()).toContain("empty");

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update("/quotes"));
    const reply = last();
    expect(reply.startsWith("<pre>")).toBe(true);
    expect(reply).toContain(`${YYMMDD} C6500`);
    expect(reply).toContain("1.5");
    expect(reply).toContain("1.0/2.0"); // Python's str(1.0), not "1"
    expect(reply).not.toContain("0.42"); // delta lives in /greeks
    expect(lastParams().parse_mode).toBe("HTML");
  });

  it("/greeks shows delta, gamma and theta at the places each needs", async () => {
    const b = bot(quoting({
      option_delta: 0.166096, option_gamma: 0.000124194, option_theta: -1.117809,
      option_implied_volatility: 22.012,
    }));
    await b.handleUpdate(update("/greeks"));
    expect(last().toLowerCase()).toContain("empty");

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 0.6`));
    await b.handleUpdate(update("/greeks"));
    const reply = last();
    expect(reply).toContain("0.166"); // delta, three places
    expect(reply).toContain("0.00012"); // gamma, five — three would show every gamma as 0.000
    expect(reply).toContain("-1.12"); // theta, two
    expect(reply).not.toContain("22.012"); // IV moved to /vol
    expect(lastParams().parse_mode).toBe("HTML");
  });

  it("/vol shows IV and vega", async () => {
    const b = bot(quoting({ option_implied_volatility: 22.012345, option_vega: 5.89497 }));
    await b.handleUpdate(update("/vol"));
    expect(last().toLowerCase()).toContain("empty");

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 0.6`));
    await b.handleUpdate(update("/vol"));
    expect(last()).toContain("22.012");
    expect(last()).not.toContain("22.012345");
    expect(last()).toContain("5.89");
  });

  it("shows an em dash per missing field rather than failing the table", async () => {
    const b = bot(quoting({}));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 0.6`));
    for (const command of ["/quotes", "/greeks", "/vol"]) {
      await b.handleUpdate(update(command));
      expect(last(), command).toContain("—");
      expect(last().startsWith("<pre>"), command).toBe(true);
    }
  });

  it("says what failed when OpenD does, rather than nothing", async () => {
    const b = bot(() => Promise.reject(new Error("Client connection failed!")));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 8100 0.6`)); // refused, but try anyway
    db.prepare(
      `insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
         direction, compare, enabled, triggered, created_at)
       values ('m', 'US.SPXW261101C8100000', ?, 'CALL', 8100, 'option_delta', 0.6, 'above', 'abs', 1, 0,
         '2026-10-01 00:00:00.000000')`,
    ).run(FUTURE);
    for (const [command, label] of [["/quotes", "Quotes"], ["/greeks", "Greeks"], ["/vol", "Vol"]]) {
      await b.handleUpdate(update(command!));
      expect(last(), command).toBe(`${label} failed: Client connection failed!`);
      expect(lastParams().parse_mode, command).toBeUndefined(); // a plain reply, not HTML
    }
  });
});

describe("/threshold", () => {
  it("finds a monitor by combo name or by short contract", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo sep-condor ${FUTURE} +C8100 -C8150 10 below`));
    await b.handleUpdate(update("/threshold sep-condor 25"));
    expect(last()).toContain("25");
    expect(monitors().find((m) => m.code === "sep-condor")!.threshold).toBe(25);

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/threshold ${YYMMDD} C6500 0.5`));
    expect(last()).toContain("0.5");
    expect(monitors().find((m) => m.code !== "sep-condor")!.threshold).toBe(0.5);
  });

  it("says so when nothing matches, and refuses a value it cannot read", async () => {
    const b = bot();
    await b.handleUpdate(update("/threshold ghost 1"));
    expect(last().toLowerCase()).toContain("no monitor");
    await b.handleUpdate(update("/threshold ghost lots"));
    expect(last().toLowerCase()).toContain("usage");
    await b.handleUpdate(update("/threshold"));
    expect(last().toLowerCase()).toContain("usage");
  });

  it("refuses zero for a signed monitor, and leaves it unchanged", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo bear-cs ${FUTURE} -C8100 +C8150 -4.05 signed below`));
    await b.handleUpdate(update("/threshold bear-cs -5"));
    expect(monitors()[0]!.threshold).toBe(-5);
    await b.handleUpdate(update("/threshold bear-cs 0"));
    expect(last().toLowerCase()).toContain("signed");
    expect(monitors()[0]!.threshold).toBe(-5);
  });

  it("refuses a non-positive value for an abs monitor, and leaves it unchanged", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/threshold ${YYMMDD} C6500 0`));
    expect(last().toLowerCase()).toContain("positive");
    expect(monitors()[0]!.threshold).toBe(0.6);
  });

  it("refuses to guess between two matches", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.7 mid_price`));
    await b.handleUpdate(update(`/threshold ${YYMMDD} C6500 0.5`));
    expect(last()).toContain("Ambiguous");
    expect(monitors().map((m) => m.threshold).sort()).toEqual([0.6, 0.7]);
  });
});

describe("/rename", () => {
  it("renames a combo and keeps its state", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo old-name ${FUTURE} +C8100 -C8150 10 below`));
    const id = monitors()[0]!.id;
    db.prepare("update monitors set triggered = 1, last_value = 7.15 where id = ?").run(id);

    await b.handleUpdate(update("/rename old-name new-name"));
    expect(last()).toContain("new-name");
    const m = db.prepare("select * from monitors where id = ?").get(id) as
      { code: string; triggered: number; last_value: number };
    expect(m.code).toBe("new-name");
    expect(m.triggered).toBe(1); // recreating it would have lost this
    expect(m.last_value).toBe(7.15);
  });

  it("refuses a name already taken, a combo that is not there, and bad arguments", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watchcombo a ${FUTURE} +C8100 -C8150 10 below`));
    await b.handleUpdate(update(`/watchcombo c ${FUTURE} +C8200 -C8250 10 below`));
    await b.handleUpdate(update("/rename c a"));
    expect(last()).toBe("'a' is already taken.");
    await b.handleUpdate(update("/rename ghost whatever"));
    expect(last().toLowerCase()).toContain("no combo");
    await b.handleUpdate(update("/rename only-one"));
    expect(last().toLowerCase()).toContain("usage");
  });

  it("refuses a single-leg monitor, whose code is its contract", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    const code = monitors()[0]!.code;
    await b.handleUpdate(update(`/rename ${code} something`));
    expect(last().toLowerCase()).toContain("no combo");
  });
});

describe("/unwatch", () => {
  it("finds a monitor by short label, full code, or id prefix", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/unwatch ${YYMMDD} C6500`));
    expect(last().toLowerCase()).toContain("removed");
    expect(monitors()).toEqual([]);

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    const code = monitors()[0]!.code;
    await b.handleUpdate(update(`/unwatch ${code}`));
    expect(monitors()).toEqual([]);

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/unwatch ${monitors()[0]!.id.slice(0, 8)}`));
    expect(monitors()).toEqual([]);
  });

  it("says so when nothing matches, and refuses to guess between two", async () => {
    const b = bot();
    await b.handleUpdate(update("/unwatch nothere"));
    expect(last().toLowerCase()).toContain("no monitor");
    await b.handleUpdate(update("/unwatch"));
    expect(last().toLowerCase()).toContain("usage");

    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.7 mid_price`));
    await b.handleUpdate(update(`/unwatch ${YYMMDD} C6500`));
    expect(last()).toContain("Ambiguous");
    expect(monitors()).toHaveLength(2);
  });

  it("takes the position links with it, and leaves the position", async () => {
    // the links go first or the foreign key refuses the delete, and every monitor in the live
    // database is linked (#70). A Position is a holding — it exists whether or not anything watches it.
    const b = bot();
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'held', 'credit_spread', ?, 1, 2.0, ?, '2026-10-01 00:00:00.000000')`,
    ).run("p".repeat(32), FUTURE, toSqliteJson([{ side: "sold", option_type: "CALL", strike: 6500 }]));
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    const id = monitors()[0]!.id;
    expect(db.prepare("select count(*) n from monitor_positions").get()).toMatchObject({ n: 1 });

    await b.handleUpdate(update(`/unwatch ${id.slice(0, 8)}`));
    expect(last().toLowerCase()).toContain("removed");
    expect(db.prepare("select count(*) n from monitor_positions").get()).toMatchObject({ n: 0 });
    expect(db.prepare("select name from positions").get()).toMatchObject({ name: "held" });
  });
});

describe("linking, which the Python's bot does not do", () => {
  it("attaches a monitor created from the phone to the position holding its contract", async () => {
    // The Python's /watch writes the Monitor and nothing else, so a monitor created from the phone has
    // no entry and no P&L while the same monitor created from the dashboard has both. The linkage is a
    // lookup rather than a guess (see positionsHolding), so there is no reason the two doors should
    // differ. A deliberate correction, recorded in ADR 0009.
    const b = bot();
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'spread', 'credit_spread', ?, 1, 2.5, ?, '2026-10-01 00:00:00.000000')`,
    ).run("p".repeat(32), FUTURE, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]));

    await b.handleUpdate(update(`/watchcombo spread ${FUTURE} +C8100 -C8150 10 below`));
    const row = db.prepare("select scope from monitors").get() as { scope: string | null };
    expect(row.scope).toBe("all"); // the rule covers the holding exactly
    expect(db.prepare("select count(*) n from monitor_positions").get()).toMatchObject({ n: 1 });
  });

  it("links nothing when no position holds the contract", async () => {
    const b = bot();
    await b.handleUpdate(update(`/watch ${FUTURE} CALL 6500 0.6`));
    expect(db.prepare("select count(*) n from monitor_positions").get()).toMatchObject({ n: 0 });
    expect((db.prepare("select scope from monitors").get() as { scope: null }).scope).toBeNull();
  });
});

describe("/snapshot", () => {
  it("shows the fields that matter, at the places they deserve", async () => {
    const b = bot((codes) => Promise.resolve([{
      code: codes[0]!, name: "SPXW TEST", option_delta: 0.512345,
      option_implied_volatility: 21.45678, bid_price: 1.0, ask_price: 2.0,
    }]));
    await b.handleUpdate(update(`/snapshot ${FUTURE} CALL 6500`));
    const reply = last();
    expect(reply.startsWith("SPXW TEST\n")).toBe(true);
    expect(reply).toContain("option_delta: 0.512");
    expect(reply).not.toContain("0.512345");
    expect(reply).toContain("option_implied_volatility: 21.457");
    expect(reply).not.toContain("21.45678");
    expect(reply).toContain("bid_price: 1.0"); // Python's str(1.0)
    expect(lastParams().parse_mode).toBeUndefined();
  });

  it("says so when there is no data, and when the arguments are wrong", async () => {
    const b = bot(() => Promise.resolve([]));
    await b.handleUpdate(update(`/snapshot ${FUTURE} CALL 6500`));
    expect(last()).toMatch(/^No data for US\.SPXW/);
    for (const text of ["/snapshot", `/snapshot ${FUTURE} SIDEWAYS 6500`, "/snapshot 18-12-2026 CALL 6500"]) {
      await b.handleUpdate(update(text));
      expect(last().toLowerCase(), text).toContain("usage");
    }
  });

  it("says what failed when OpenD does", async () => {
    const b = bot(() => Promise.reject(new Error("Client connection failed!")));
    await b.handleUpdate(update(`/snapshot ${FUTURE} CALL 6500`));
    expect(last()).toBe("Snapshot failed: Client connection failed!");
  });
});

describe("/health", () => {
  it("reports the queue and the sweep, in the display zone", async () => {
    const b = bot(echo, { displayTz: "Asia/Singapore" }, {
      worker: { queueDepth: () => 3, submit: () => {} },
      sweeper: {
        lastSweepAt: () => new Date("2026-08-10T03:35:00Z"),
        lastFetchAt: () => null,
        lastSweepOk: () => true,
        consecutiveFailures: () => 0,
        alarmState: () => ({ label: "active", bad: false }),
      },
    });
    await b.handleUpdate(update("/health"));
    expect(last()).toBe("Service is up.\nqueue depth: 3\nalarms: active — last sweep 2026-08-10 11:35 +08");
  });

  it("says only that it is up when nothing else is wired", async () => {
    await bot().handleUpdate(update("/health"));
    expect(last()).toBe("Service is up.");
  });

  it("leaves out the sweep time before the first sweep", async () => {
    const b = bot(echo, {}, {
      sweeper: {
        lastSweepAt: () => null, lastFetchAt: () => null, lastSweepOk: () => true,
        consecutiveFailures: () => 0, alarmState: () => ({ label: "starting", bad: false }),
      },
    });
    await b.handleUpdate(update("/health"));
    expect(last()).toBe("Service is up.\nalarms: starting");
  });
});

describe("/help", () => {
  it("is plain text, never parsed as HTML", async () => {
    // a plain reply containing "<0.6" would lose it to a tag
    await bot().handleUpdate(update("/help"));
    expect(lastParams().parse_mode).toBeUndefined();
    expect(last()).toContain("/watchcombo");
  });
});

describe("the command menu", () => {
  it("publishes every command, each with a description", async () => {
    await bot().start();
    const call = calls.find(([method]) => method === "setMyCommands")!;
    const published = JSON.parse(call[1].commands!) as { command: string; description: string }[];
    expect(published.map((c) => c.command)).toEqual([
      "monitors", "quotes", "greeks", "vol", "watch", "watchcombo", "unwatch", "combo",
      "threshold", "rename", "snapshot", "health", "help",
    ]);
    expect(published.every((c) => c.description.length > 0)).toBe(true);
  });

  it("drains the backlog so a restart does not replay old commands", async () => {
    // an /unwatch sent while the service was down would otherwise be obeyed as if it were new
    const b = new TelegramBot({
      db,
      settings: settingsFor({ telegramBotToken: "t", telegramChatId: "42" }),
      api: async (method, params) => {
        calls.push([method, params]);
        if (method === "getUpdates" && params.offset === "-1") return [{ update_id: 77 }];
        return [];
      },
      fetchQuotes: echo,
      now: () => NOW,
    });
    await b.start();
    expect(b.nextOffset()).toBe(78); // one past the drained update
  });

  it("starts from nothing when there is no backlog", async () => {
    const b = bot();
    await b.start();
    expect(b.nextOffset()).toBe(0);
  });

  it("starts anyway when the menu or the drain fails", async () => {
    // neither is worth refusing to run for: the owner can still type a command they remember
    const b = new TelegramBot({
      db,
      settings: settingsFor({ telegramBotToken: "t", telegramChatId: "42" }),
      api: () => Promise.reject(new Error("telegram is down")),
      fetchQuotes: echo,
      now: () => NOW,
    });
    await expect(b.start()).resolves.toBeUndefined();
  });
});
