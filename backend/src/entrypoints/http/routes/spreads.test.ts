/** `POST /spreads` — a spread and its Monitors in one step, all of it or none (#293, ADR 0023).
 *
 *  The door scenarios hold what both backends answer; this holds the parts a scenario reads only
 *  in passing — that a refusal is decided before the Provider is asked, that the probe is ONE
 *  call, and that the links and scopes come out as the two older routes would have left them.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "optionality/domain/contract";
import {
  type Harness, body, daysFromNow, harness, json, poisonable,
} from "../../../../testing/harness.ts";
import type { QuoteFetcher } from "optionality/quotes";

let h: Harness;
afterEach(() => h?.close());

const EXPIRY = daysFromNow(40);
const PUTS = [
  { side: "short", option_type: "PUT", strike: 7150 },
  { side: "long", option_type: "PUT", strike: 7100 },
];
const CALLS = [
  { side: "short", option_type: "CALL", strike: 7700 },
  { side: "long", option_type: "CALL", strike: 7750 },
];

/** Six legs on one expiry: the most one spread may have (#334). */
const SIX = [
  ...PUTS, ...CALLS,
  { side: "long", option_type: "PUT", strike: 7050 }, { side: "long", option_type: "CALL", strike: 7800 },
];

const heldSpread = (name: string, legs: unknown[], entry: number, short: { option_type: string; strike: number }) => ({
  name, legs, held: true, entry, opened_at: "2026-10-01",
  monitors: [
    { threshold: entry * 2 },
    { ...short, threshold: 0.3 },
  ],
});
const condor = () => ({
  strike_date: EXPIRY,
  spreads: [
    heldSpread("p", PUTS, 1.5, { option_type: "PUT", strike: 7150 }),
    heldSpread("c", CALLS, 1.25, { option_type: "CALL", strike: 7700 }),
  ],
});

/** Every code each probe asked for, in order. */
function counting(inner: QuoteFetcher = (codes) => Promise.resolve({ records: codes.map((code) => ({ code })), unknown: [] })) {
  const asked: string[][] = [];
  const fetch: QuoteFetcher = (codes) => { asked.push([...codes]); return inner(codes); };
  return { asked, fetch };
}

const start = (fetch?: QuoteFetcher) => (h = harness(fetch ? { fetchQuotes: (codes) => fetch(codes) } : {}));
const post = (payload: unknown) => h.call("/spreads", json(payload));
const count = (table: string) =>
  (h.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
const nothingWritten = () => {
  expect([count("positions"), count("monitors"), count("monitor_positions")]).toEqual([0, 0, 0]);
};

describe("adding spreads with their Monitors", () => {
  it("records a condor as two holdings and four Monitors, probing every leg in ONE call", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const resp = await post(condor());
    const added = await body(resp);
    expect(resp.status, JSON.stringify(added)).toBe(201);
    expect(added.positions.map((p: { name: string }) => p.name)).toEqual(["p", "c"]);
    expect(added.monitors.map((m: { code: string; field: string }) => [m.code, m.field])).toEqual([
      ["p", "mid_price"],
      [buildSpxCode(EXPIRY, "PUT", 7150), "option_delta"],
      ["c", "mid_price"],
      [buildSpxCode(EXPIRY, "CALL", 7700), "option_delta"],
    ]);
    expect(asked).toEqual([[...PUTS, ...CALLS].map((l) => buildSpxCode(EXPIRY, l.option_type as "CALL" | "PUT", l.strike)).sort()]);

    const positions = h.db.prepare("select name, entry, opened_at, contracts, legs from positions order by name")
      .all() as { name: string; entry: number; opened_at: string; contracts: number; legs: string }[];
    expect(positions.map((p) => [p.name, p.entry, p.opened_at, p.contracts])).toEqual([
      ["c", 1.25, "2026-10-01", 1], ["p", 1.5, "2026-10-01", 1],
    ]);
    // the value rule is a combo over the spread's legs, minus for short (ADR 0013), at 2x entry,
    // and both rules belong to the holding: the combo all of it, the delta rule one leg
    const value = h.db.prepare("select * from monitors where code = 'p'").get() as Record<string, unknown>;
    expect([value.option_type, value.threshold, value.direction, value.compare, value.scope])
      .toEqual(["CMB", 3, "above", "abs", "all"]);
    expect(JSON.parse(value.legs as string)).toEqual([
      { sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 },
    ]);
    const delta = h.db.prepare("select * from monitors where field = 'option_delta' and option_type = 'PUT'")
      .get() as Record<string, unknown>;
    expect([delta.threshold, delta.scope, delta.strike]).toEqual([0.3, "leg", 7150]);
    expect(count("monitor_positions")).toBe(4);
  });

  it("records a watched spread's Monitors and no holding", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "w", legs: PUTS, held: false, monitors: [
        { threshold: 1.8 }, { option_type: "PUT", strike: 7150, threshold: 0.15 },
      ] }],
    });
    expect(resp.status).toBe(201);
    expect(await body(resp)).toMatchObject({ positions: [] });
    expect([count("positions"), count("monitors"), count("monitor_positions")]).toEqual([0, 2, 0]);
  });

  it("creates only the Monitors it was sent: a default switched off is simply not there", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "p", legs: PUTS, held: true, entry: 1.5, monitors: [{ threshold: 3 }] }],
    });
    expect(resp.status).toBe(201);
    expect([count("positions"), count("monitors")]).toEqual([1, 1]);
  });

  it("writes nothing when one leg is refused by the Provider", async () => {
    const { asked, fetch } = counting(poisonable("C7750"));
    start(fetch);
    const resp = await post(condor());
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/C7750000.*does not exist|does not exist.*C7750000/);
    expect(asked).toHaveLength(1);
    nothingWritten();
  });

  it("writes nothing, and asks the Provider nothing, when one Monitor is invalid", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const bad = condor();
    bad.spreads[1]!.monitors[1] = { option_type: "CALL", strike: 7700, threshold: 0 };
    const resp = await post(bad);
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe(
      "threshold must be positive when compare='abs' (values are compared as absolutes)",
    );
    expect(asked).toEqual([]);
    nothingWritten();
  });

  it("refuses a leg rule on a contract that is not one of the spread's legs", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "p", legs: PUTS, held: false, monitors: [
        { option_type: "PUT", strike: 7000, threshold: 0.2 },
      ] }],
    });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("monitor 1 of 'p' watches PUT 7000, which is not one of its legs");
    nothingWritten();
  });

  it("refuses a rule that names a leg by half", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "p", legs: PUTS, held: false, monitors: [{ strike: 7150, threshold: 0.2 }] }],
    });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("monitor 1 of 'p' names a leg: give both its option_type and its strike");
  });

  it("refuses an entry, a count or an Opened on a spread that is only watched", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "w", legs: PUTS, held: false, entry: 1.5, monitors: [{ threshold: 2 }] }],
    });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe(
      "'w' is watched, not held: an entry, a count and an Opened belong to a holding",
    );
  });

  it("refuses a spread that would record nothing at all", async () => {
    start();
    const resp = await post({ strike_date: EXPIRY, spreads: [{ name: "w", legs: PUTS, held: false, monitors: [] }] });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("'w' is neither held nor watched: nothing would be recorded");
  });

  it("refuses the value of a single leg, which is that contract's own", async () => {
    start();
    const resp = await post({
      strike_date: EXPIRY,
      spreads: [{ name: "s", legs: [PUTS[0]], held: false, monitors: [{ threshold: 2 }] }],
    });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe(
      "'s' has one leg, so its value is that contract's: watch the leg instead",
    );
  });

  it("refuses two spreads of one name, and one rule given twice", async () => {
    start();
    const twice = await post({ strike_date: EXPIRY, spreads: [
      { name: "x", legs: PUTS, held: false, monitors: [{ threshold: 2 }] },
      { name: "x", legs: CALLS, held: false, monitors: [{ threshold: 2 }] },
    ] });
    expect(twice.status).toBe(422);
    expect((await body(twice)).detail).toBe("'x' is named twice");
    const rule = await post({ strike_date: EXPIRY, spreads: [
      { name: "x", legs: PUTS, held: false, monitors: [
        { option_type: "PUT", strike: 7150, threshold: 0.2 }, { option_type: "PUT", strike: 7150, threshold: 0.3 },
      ] },
    ] });
    expect(rule.status).toBe(422);
    expect((await body(rule)).detail).toBe(
      `the monitor for (${buildSpxCode(EXPIRY, "PUT", 7150)}, option_delta) is given twice`,
    );
    nothingWritten();
  });

  it("refuses a name already held, and a Monitor already there, without asking the Provider", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    expect((await post(condor())).status).toBe(201);
    asked.length = 0;

    const held = await post({ strike_date: EXPIRY, spreads: [heldSpread("p", PUTS, 1, { option_type: "PUT", strike: 7150 })] });
    expect(held.status).toBe(409);
    expect((await body(held)).detail).toBe("position 'p' already exists");

    const watched = await post({ strike_date: EXPIRY, spreads: [
      { name: "other", legs: PUTS, held: false, monitors: [{ option_type: "PUT", strike: 7150, threshold: 0.2 }] },
    ] });
    expect(watched.status).toBe(409);
    expect((await body(watched)).detail).toBe(
      `monitor for (${buildSpxCode(EXPIRY, "PUT", 7150)}, option_delta) already exists`,
    );
    expect(asked).toEqual([]);
    expect([count("positions"), count("monitors")]).toEqual([2, 4]);
  });

  it("adopts a rule that was already watching what the new holding holds", async () => {
    start();
    const before = await h.call("/monitors", json({
      strike_date: EXPIRY, option_type: "PUT", strike: 7100, threshold: 0.1,
    }));
    const id = (await body(before)).id as string;
    expect((await post({
      strike_date: EXPIRY, spreads: [{ name: "p", legs: PUTS, held: true, entry: 1.5, monitors: [] }],
    })).status).toBe(201);
    expect(h.db.prepare("select scope from monitors where id = ?").get(id)).toEqual({ scope: "leg" });
  });

  it("refuses an empty request and an unreadable expiry in zod's words", async () => {
    start();
    const empty = await post({ strike_date: EXPIRY, spreads: [] });
    expect(empty.status).toBe(422);
    expect((await body(empty)).detail).toBe("✖ Too small: expected array to have >=1 items\n  → at spreads");
    const date = await post({ ...condor(), strike_date: "next friday" });
    expect(date.status).toBe(422);
    expect((await body(date)).detail).toMatch(/invalid strike_date 'next friday'/);
  });
});

/** The rows a monitor links to, and its scope. */
const linksOf = (monitorId: string): [string[], string | null] => [
  (h.db.prepare("select position_id from monitor_positions where monitor_id = ? order by position_id")
    .all(monitorId) as { position_id: string }[]).map((r) => r.position_id),
  (h.db.prepare("select scope from monitors where id = ?").get(monitorId) as { scope: string | null }).scope,
];
const created = async (resp: Response) => {
  const data = await body(resp);
  expect(resp.status, JSON.stringify(data)).toBe(201);
  return data;
};
const holding = (name: string, legs: unknown[]) =>
  h.call("/positions", json({ name, strike_date: EXPIRY, legs, entry: 1 })).then(created);

describe("linking a new holding's own Monitors", () => {
  /** A holding that shares a contract with another one was the case positionsHolding calls
   *  ambiguous against the whole book: its own stop and delta rule came out linked to nothing. */
  it("links them to the holding they were made for when another holding shares a leg", async () => {
    start();
    await holding("first", [
      { side: "short", option_type: "PUT", strike: 7100 }, { side: "long", option_type: "PUT", strike: 7050 },
    ]);
    const added = await created(await post({ strike_date: EXPIRY, spreads: [heldSpread("second", PUTS, 1.5, { option_type: "PUT", strike: 7150 })] }));
    const second = added.positions[0].id as string;
    expect(added.monitors.map((m: { id: string }) => linksOf(m.id))).toEqual([[[second], "all"], [[second], "leg"]]);
  });

  it("links them to the new holding when it scales in on the same strikes", async () => {
    start();
    await holding("first", PUTS);
    const added = await created(await post({ strike_date: EXPIRY, spreads: [heldSpread("second", PUTS, 1.5, { option_type: "PUT", strike: 7150 })] }));
    const second = added.positions[0].id as string;
    expect(added.monitors.map((m: { id: string }) => linksOf(m.id))).toEqual([[[second], "all"], [[second], "leg"]]);
  });
});

describe("all of it or none of it, when the write itself fails", () => {
  /** A probe that writes behind the checks' backs: what a second save landing between this one's
   *  checks and its transaction looks like. */
  const racing = (sql: string) => (codes: string[]) => {
    h.db.exec(sql);
    return Promise.resolve({ records: codes.map((code) => ({ code })), unknown: [] });
  };

  it("leaves nothing behind when a Monitor clashes after the holdings were written, and says so as a 409", async () => {
    start(racing(`insert into monitors (id, code, strike_date, option_type, strike, field, threshold, direction,
      compare, enabled, triggered, created_at) values ('race', 'c', '${EXPIRY}', 'CMB', 0, 'mid_price', 9,
      'above', 'abs', 1, 0, '2026-10-02 00:00:00.000000')`));
    const resp = await post(condor());
    expect(resp.status).toBe(409);
    expect((await body(resp)).detail).toBe("monitor for (c, mid_price) already exists");
    expect([count("positions"), count("monitors"), count("monitor_positions")]).toEqual([0, 1, 0]);
  });

  it("leaves nothing behind when a holding's name is taken after the checks, and says so as a 409", async () => {
    start(racing(`insert into positions (id, name, strike_date, contracts, legs, created_at)
      values ('race', 'c', '${EXPIRY}', 1, '[]', '2026-10-02 00:00:00.000000')`));
    const resp = await post(condor());
    expect(resp.status).toBe(409);
    expect((await body(resp)).detail).toBe("position 'c' already exists");
    expect([count("positions"), count("monitors"), count("monitor_positions")]).toEqual([1, 0, 0]);
  });
});

describe("a spread of six legs (#334)", () => {
  it("is recorded with its value and every short leg's delta, probing all six in ONE call", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const spread = {
      name: "six", legs: SIX, held: true, entry: 3, opened_at: "2026-10-01",
      monitors: [
        { threshold: 6 },
        { option_type: "PUT", strike: 7150, threshold: 0.3 }, { option_type: "CALL", strike: 7700, threshold: 0.3 },
      ],
    };
    const resp = await post({ strike_date: EXPIRY, spreads: [spread] });
    expect(resp.status, JSON.stringify(await body(resp))).toBe(201);
    expect(asked).toEqual([SIX.map((l) => buildSpxCode(EXPIRY, l.option_type as "CALL" | "PUT", l.strike)).sort()]);
    const stored = h.db.prepare("select legs from positions").get() as { legs: string };
    expect(JSON.parse(stored.legs)).toHaveLength(6);
    const value = h.db.prepare("select legs from monitors where field = 'mid_price'").get() as { legs: string };
    expect(JSON.parse(value.legs).map((l: { sign: number }) => l.sign)).toEqual([-1, 1, -1, 1, 1, 1]);
  });
});

describe("what a spread may not say", () => {
  const refused = async (payload: unknown) => {
    const resp = await post(payload);
    expect(resp.status).toBe(422);
    return (await body(resp)).detail as string;
  };
  const one = (over: object) => ({ strike_date: EXPIRY, spreads: [{ name: "w", legs: PUTS, held: false, monitors: [{ threshold: 2 }], ...over }] });

  it("a blank name", async () => {
    start();
    expect(await refused(one({ name: "" }))).toBe("✖ Too small: expected string to have >=1 characters\n  → at spreads[0].name");
  });

  it("one contract twice, on one side or on both", async () => {
    start();
    expect(await refused(one({ legs: [PUTS[0], PUTS[0]] })))
      .toBe("'w' names PUT 7150 twice: give the one leg a quantity");
    expect(await refused(one({ legs: [PUTS[0], { ...PUTS[0], side: "long" }] }))).toBe("'w' is both short and long PUT 7150");
    nothingWritten();
  });

  it("more than eight spreads, or more than six legs to one, so the one probe stays small", async () => {
    start();
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `w${i}`, legs: PUTS, held: false, monitors: [{ threshold: 2 }] }));
    expect(await refused({ strike_date: EXPIRY, spreads: nine })).toBe("✖ Too big: expected array to have <=8 items\n  → at spreads");
    const seven = [...SIX, { side: "long", option_type: "CALL", strike: 7850 }];
    expect(await refused(one({ legs: seven }))).toBe("✖ Too big: expected array to have <=6 items\n  → at spreads[0].legs");
  });

  it("more than 32 legs in all, before the Provider is asked: the probe's bound #322 set", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, legs: SIX, held: false, monitors: [{ threshold: 2 }] }));
    expect(await refused({ strike_date: EXPIRY, spreads: six }))
      .toBe("this request has 36 legs: at most 32 in one request");
    expect(asked).toEqual([]);
    nothingWritten();
    // decided FIRST in the request's own checks: a name given twice, which is refused in step 1
    // too, is not what a request this size is told
    const twice = six.map((sp, i) => ({ ...sp, name: `w${i % 2}` }));
    expect(await refused({ strike_date: EXPIRY, spreads: twice }))
      .toBe("this request has 36 legs: at most 32 in one request");
    // 32 exactly is within it
    const legs32 = [...six.slice(0, 5), { ...six[5]!, legs: SIX.slice(0, 2) }];
    expect((await post({ strike_date: EXPIRY, spreads: legs32 })).status).toBe(201);
  });
});

describe("a quantity per leg (#351)", () => {
  /** a put butterfly, 1×2×1, the middle sold twice over */
  const FLY = [
    { side: "long", option_type: "PUT", strike: 7100 },
    { side: "short", option_type: "PUT", strike: 7150, qty: 2 },
    { side: "long", option_type: "PUT", strike: 7200 },
  ];
  const fly = (over: object = {}) => ({ strike_date: EXPIRY, spreads: [{
    name: "fly", legs: FLY, held: true, entry: -1.2, opened_at: "2026-10-01",
    monitors: [{ threshold: 2.4 }, { option_type: "PUT", strike: 7150, threshold: 0.3 }], ...over,
  }] });
  const refused = async (payload: unknown) => {
    const resp = await post(payload);
    expect(resp.status).toBe(422);
    return (await body(resp)).detail as string;
  };

  it("records a butterfly as ONE leg per contract, the middle's quantity on the holding and its rule", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const resp = await post(fly());
    expect(resp.status, JSON.stringify(await body(resp))).toBe(201);
    // three contracts asked, once each: a quantity adds nothing to the probe
    expect(asked).toEqual([FLY.map((l) => buildSpxCode(EXPIRY, l.option_type as "PUT", l.strike)).sort()]);
    const held = h.db.prepare("select legs from positions").get() as { legs: string };
    expect(JSON.parse(held.legs)).toEqual([
      { side: "long", option_type: "PUT", strike: 7100 },
      { side: "short", option_type: "PUT", strike: 7150, qty: 2 },
      { side: "long", option_type: "PUT", strike: 7200 },
    ]);
    const value = h.db.prepare("select legs, scope from monitors where code = 'fly'").get() as { legs: string; scope: string };
    expect(JSON.parse(value.legs)).toEqual([
      { sign: 1, option_type: "PUT", strike: 7100 },
      { sign: -1, option_type: "PUT", strike: 7150, qty: 2 },
      { sign: 1, option_type: "PUT", strike: 7200 },
    ]);
    expect(value.scope).toBe("all");
    // the short leg's |Δ| is one contract's, so one rule on it whatever its quantity
    expect(count("monitors")).toBe(2);
  });

  it("stores a quantity of one as no quantity, as every leg before it was stored", async () => {
    start();
    const ones = FLY.map((l) => ({ ...l, qty: 1 }));
    expect((await post(fly({ legs: ones }))).status).toBe(201);
    const held = h.db.prepare("select legs from positions").get() as { legs: string };
    expect(JSON.parse(held.legs).some((l: object) => "qty" in l)).toBe(false);
    const value = h.db.prepare("select legs from monitors where code = 'fly'").get() as { legs: string };
    expect(JSON.parse(value.legs).some((l: object) => "qty" in l)).toBe(false);
  });

  it("serves the quantity back on the holding and on the rule", async () => {
    start();
    expect((await post(fly())).status).toBe(201);
    const [position] = await body(await h.call("/positions"));
    expect(position.legs[1]).toEqual({ side: "short", option_type: "PUT", strike: 7150, qty: 2 });
    expect(position.legs[0]).not.toHaveProperty("qty");
    const monitors = await body(await h.call("/monitors"));
    const value = monitors.find((m: { code: string }) => m.code === "fly");
    expect(value.legs[1]).toEqual({ sign: -1, option_type: "PUT", strike: 7150, qty: 2 });
    expect(value.legs[0]).not.toHaveProperty("qty");
  });

  it("refuses a quantity of none, of more than ten, or of a part, before the Provider is asked", async () => {
    const { asked, fetch } = counting();
    start(fetch);
    const at = (qty: unknown) => fly({ legs: [FLY[0], { ...FLY[1], qty }, FLY[2]] });
    expect(await refused(at(0))).toBe("✖ Too small: expected number to be >=1\n  → at spreads[0].legs[1].qty");
    expect(await refused(at(11))).toBe("✖ Too big: expected number to be <=10\n  → at spreads[0].legs[1].qty");
    expect(await refused(at(1.5))).toBe("✖ Invalid input: expected int, received number\n  → at spreads[0].legs[1].qty");
    expect(asked).toEqual([]);
    nothingWritten();
  });

  it("counts legs, not contracts times quantity, against the probe's bound", async () => {
    start();
    const tens = SIX.map((l) => ({ ...l, qty: 10 }));
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `w${i}`, legs: tens, held: false, monitors: [{ threshold: 2 }] }));
    // 30 legs, 300 contracts: 30 codes at most are asked
    expect((await post({ strike_date: EXPIRY, spreads: many })).status).toBe(201);
  });
});

describe("a held spread replacing the watch rules it clashes with", () => {
  const watch = (monitors: unknown[]) => post({ strike_date: EXPIRY, spreads: [{ name: "p", legs: PUTS, held: false, monitors }] }).then(created);
  const ids = () => (h.db.prepare("select id from monitors order by id").all() as { id: string }[]).map((r) => r.id);

  it("deletes the clashing watch rules and makes the holding's in their place, saying which", async () => {
    start();
    const watched = await watch([{ threshold: 1.8 }, { option_type: "PUT", strike: 7150, threshold: 0.15 }]);
    const added = await created(await post({ strike_date: EXPIRY, spreads: [heldSpread("p", PUTS, 1.5, { option_type: "PUT", strike: 7150 })] }));
    expect(added.replaced).toEqual(watched.monitors);
    const now = ids();
    expect(now).toHaveLength(2);
    for (const old of watched.monitors) expect(now).not.toContain(old.id);
    const id = added.positions[0].id as string;
    expect(added.monitors.map((m: { id: string }) => linksOf(m.id))).toEqual([[[id], "all"], [[id], "leg"]]);
    expect(h.db.prepare("select threshold from monitors where code = 'p'").get()).toEqual({ threshold: 3 });
  });

  it("leaves a watch rule alone when its default was switched off, and the holding adopts it", async () => {
    start();
    const watched = await watch([{ threshold: 1.8 }, { option_type: "PUT", strike: 7150, threshold: 0.15 }]);
    const added = await created(await post({ strike_date: EXPIRY, spreads: [{ ...heldSpread("p", PUTS, 1.5, { option_type: "PUT", strike: 7150 }), monitors: [{ threshold: 3 }] }] }));
    expect(added.replaced).toEqual([watched.monitors[0]]);
    const kept = watched.monitors[1].id as string;
    expect(ids()).toContain(kept);
    expect(h.db.prepare("select threshold from monitors where id = ?").get(kept)).toEqual({ threshold: 0.15 });
    expect(linksOf(kept)).toEqual([[added.positions[0].id], "leg"]);
  });

  it("refuses, writing nothing, a clash with a rule another holding owns", async () => {
    start();
    await holding("first", PUTS);
    const owned = await created(await h.call("/monitors", json({ strike_date: EXPIRY, option_type: "PUT", strike: 7150, threshold: 0.2 })));
    expect(linksOf(owned.id)[0]).toHaveLength(1);
    const resp = await post({ strike_date: EXPIRY, spreads: [heldSpread("second", PUTS, 1.5, { option_type: "PUT", strike: 7150 })] });
    expect(resp.status).toBe(409);
    expect([count("positions"), count("monitors")]).toEqual([1, 1]);
  });

  /** A watch rule on the 7150 put's delta, ringing since an alarm was sent, as the sweep left it. */
  async function ringing(over: { direction?: string; compare?: string; enabled?: boolean } = {}) {
    const watched = await watch([{ option_type: "PUT", strike: 7150, threshold: 0.15, ...over }]);
    const id = watched.monitors[0].id as string;
    h.db.prepare("update monitors set triggered = 1, last_alarm_at = '2026-11-09 15:00:00.000000', last_value = -0.21, "
      + "enabled = ? where id = ?").run(over.enabled === false ? 0 : 1, id);
    return id;
  }
  const state = (code: string) => h.db.prepare(
    "select triggered, last_alarm_at, last_value from monitors where code = ? and field = 'option_delta'",
  ).get(code);
  const holdPut = (rule: object) => post({ strike_date: EXPIRY, spreads: [{
    name: "p7150", legs: [PUTS[0]], held: true, entry: 2, monitors: [{ option_type: "PUT", strike: 7150, ...rule }],
  }] }).then(created);
  const P7150 = buildSpxCode(EXPIRY, "PUT", 7150);

  it("carries a ringing rule's alarm over to the holding's rule that watches it the same way (#336)", async () => {
    // the threshold may move, as a PATCH moving it alone keeps the state (#292): no second "crossed"
    start();
    await ringing();
    const added = await holdPut({ field: "option_delta", threshold: 0.25 });
    expect(added.replaced).toHaveLength(1);
    expect(state(P7150)).toEqual({ triggered: 1, last_alarm_at: "2026-11-09 15:00:00.000000", last_value: -0.21 });
  });

  it("starts the alarm afresh where the holding's rule watches another way", async () => {
    start();
    await ringing();
    await holdPut({ field: "option_delta", threshold: 0.25, direction: "below" });
    expect(state(P7150)).toEqual({ triggered: 0, last_alarm_at: null, last_value: null });
  });

  it("starts the alarm afresh where the watch rule was switched off, as switching it back on would", async () => {
    start();
    await ringing({ enabled: false });
    await holdPut({ field: "option_delta", threshold: 0.15 });
    expect(state(P7150)).toEqual({ triggered: 0, last_alarm_at: null, last_value: null });
  });

  it("never deletes for a spread that is only watched", async () => {
    start();
    await watch([{ threshold: 1.8 }]);
    const resp = await post({ strike_date: EXPIRY, spreads: [{ name: "p", legs: PUTS, held: false, monitors: [{ threshold: 2 }] }] });
    expect(resp.status).toBe(409);
    expect(count("monitors")).toBe(1);
  });
});

