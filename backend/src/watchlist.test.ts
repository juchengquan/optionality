/** The watchlist entries the dashboard and the bot render.
 *  Ported from tests/test_monitor.py's watchlist_quotes group (ADR 0009, phase 5). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "./domain/contract.ts";
import { createDatabase } from "./db/open.ts";
import { toSqliteJson } from "./db/values.ts";
import type { QuoteFetcher, QuoteRecord } from "./quotes.ts";
import { watchlistQuotes } from "./monitors.ts";

const TZ = "Asia/Singapore";
const NOW = new Date("2026-08-10T03:35:32Z");
const EXPIRY = "2026-12-18";
const CODE = buildSpxCode(EXPIRY, "CALL", 6500);
const POISON = buildSpxCode(EXPIRY, "CALL", 99999);
const LEG_A = buildSpxCode(EXPIRY, "CALL", 8100);
const LEG_B = buildSpxCode(EXPIRY, "CALL", 8150);

let dir: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "optionality-watchlist-"));
  db = createDatabase(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const monitor = (over: Partial<{
  code: string; strike_date: string; option_type: string; strike: number; field: string;
  threshold: number; legs: unknown; enabled: number;
}> = {}) => {
  n += 1;
  const row = {
    id: `m${n}`.padEnd(32, "0"),
    code: CODE, strike_date: EXPIRY, option_type: "CALL", strike: 6500,
    field: "option_delta", threshold: 0.6, legs: null as unknown, enabled: 1, ...over,
  };
  db.prepare(
    `insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
       direction, compare, legs, enabled, triggered, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'above', 'abs', ?, ?, 0, '2026-08-01 00:00:00.000000')`,
  ).run(row.id, row.code, row.strike_date, row.option_type, row.strike, row.field, row.threshold,
    row.legs === null ? null : toSqliteJson(row.legs), row.enabled);
  return row.id;
};

const combo = (over: Record<string, unknown> = {}) => monitor({
  code: "sep-condor", option_type: "CMB", strike: 0, field: "mid_price", threshold: 10,
  legs: [
    { sign: 1, option_type: "CALL", strike: 8100 },
    { sign: -1, option_type: "CALL", strike: 8150 },
  ],
  ...over,
});

const quoting = (byCode: Record<string, QuoteRecord>): QuoteFetcher =>
  (codes) => Promise.resolve(codes.filter((c) => c in byCode).map((c) => ({ code: c, ...byCode[c] })));

/** the shipped defaults, so these tests and `.env.example` cannot drift apart */
const POLICY = { takeFraction: 0.5, stopMultiple: 2, manageByDte: 21 };

const run = (fetch: QuoteFetcher, includeCombos = false) =>
  watchlistQuotes(db, TZ, fetch, { includeCombos, now: NOW, policy: POLICY });

describe("which monitors appear", () => {
  it("leaves combos out of the single-leg tables", async () => {
    // the bot's tables are ~40 monospace characters and four columns; a signed sum does not fit
    monitor();
    combo();
    const quotes = await run(quoting({ [CODE]: { option_delta: 0.1 } }));
    expect(quotes.map((q) => q.code)).toEqual([CODE]);
  });

  it("makes no call at all when nothing is enabled", async () => {
    let calls = 0;
    const counting: QuoteFetcher = (codes) => {
      calls += 1;
      return Promise.resolve(codes.map((code) => ({ code })));
    };
    expect(await run(counting)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("excludes a disabled monitor", async () => {
    monitor({ enabled: 0 });
    expect(await run(quoting({}))).toEqual([]);
  });

  it("groups by expiry, then calls before puts", async () => {
    const near = "2026-10-16";
    const far = "2026-11-20";
    monitor({ code: "P-NEAR", option_type: "PUT", strike_date: near });
    monitor({ code: "C-FAR", option_type: "CALL", strike_date: far });
    monitor({ code: "C-NEAR", option_type: "CALL", strike_date: near });
    const quotes = await run(quoting({}));
    expect(quotes.map((q) => q.code)).toEqual(["C-NEAR", "P-NEAR", "C-FAR"]);
  });
});

describe("a single-leg entry", () => {
  it("merges the monitor's own fields with the contract's snapshot", async () => {
    monitor();
    const quotes = await run(quoting({
      [CODE]: { name: "SPXW TEST", option_delta: 0.91, bid_price: 1365.6 },
    }));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.code).toBe(CODE);
    expect(quotes[0]!.threshold).toBe(0.6);
    expect(quotes[0]!.snapshot!.option_delta).toBe(0.91);
    // the call-time stamp: the honest "data as-of"
    expect(quotes[0]!.snapshot!.fetched_at).toBe("2026-08-10 11:35:32+08:00");
  });

  it("converts the market timestamp to the display zone", async () => {
    monitor();
    const quotes = await run(quoting({ [CODE]: { update_time: "2026-08-09 20:15:00", option_delta: 0.1 } }));
    expect(quotes[0]!.snapshot!.update_time).toBe("2026-08-10 08:15:00+08:00");
  });

  it("carries how long the contract has left", async () => {
    monitor();
    const quotes = await run(quoting({}));
    // from the market date, not the display zone: 2026-08-09 in New York at this instant
    expect(quotes[0]!.dte).toBe(131);
  });

  it("fills toward the threshold from the watched field", async () => {
    monitor({ threshold: 0.6 });
    const quotes = await run(quoting({ [CODE]: { option_delta: 0.3 } }));
    expect(quotes[0]!.fill).toBe(50);
  });
});

describe("a combo entry", () => {
  it("carries its signed sum and no per-contract snapshot, in one call", async () => {
    monitor();
    combo();
    const calls: string[][] = [];
    const fetch: QuoteFetcher = (codes) => {
      calls.push(codes);
      const prices: Record<string, number> = { [CODE]: 26.4, [LEG_A]: 26.4, [LEG_B]: 19.25 };
      return Promise.resolve(
        codes.filter((c) => c in prices).map((c) => ({ code: c, mid_price: prices[c], option_delta: 0.1 })),
      );
    };
    const quotes = await run(fetch, true);
    // still ONE snapshot call for the single legs and the combo's legs together
    expect(calls).toHaveLength(1);
    const c = quotes.find((q) => q.code === "sep-condor")!;
    expect(c.combo_value).toBeCloseTo(7.15, 10); // 26.4 - 19.25
    expect(c.snapshot).toBeNull();
    expect(quotes.find((q) => q.code === CODE)!.snapshot!.mid_price).toBe(26.4);
  });

  it("reports greeks as signed sums, never an IV, and nothing where a leg is missing", async () => {
    combo();
    const legs: Record<string, QuoteRecord> = {
      [LEG_A]: { option_delta: 0.166, option_gamma: 0.0002, option_theta: -1.1 },
      [LEG_B]: { option_delta: 0.129, option_gamma: 0.0001, option_theta: -0.95 },
    };
    const fetch: QuoteFetcher = (codes) => Promise.resolve(
      codes.map((c) => ({ code: c, mid_price: 1.0, option_implied_volatility: 22.0, ...legs[c] })),
    );
    const greeks = (await run(fetch, true))[0]!.combo_greeks!;
    expect(greeks.option_delta).toBeCloseTo(0.037, 10); // +0.166 − 0.129: the delta OF the value
    expect(greeks.option_gamma).toBeCloseTo(0.0001, 10);
    expect(greeks.option_theta).toBeCloseTo(-0.15, 10);
    expect(greeks.option_implied_volatility).toBeUndefined(); // IVs do not add
    expect(greeks.option_vega).toBeNull(); // absent on the legs: null, never a partial sum
  });

  it("never sums implied volatility, even for a row that predates the rule", async () => {
    // both legs report 20.0; the old behaviour returned 40.0
    combo({ code: "legacy-iv", field: "option_implied_volatility" });
    const fetch: QuoteFetcher = (codes) =>
      Promise.resolve(codes.map((c) => ({ code: c, option_implied_volatility: 20.0 })));
    const quotes = await run(fetch, true);
    expect(quotes[0]!.combo_value).toBeNull();
  });
});

describe("an unknown contract", () => {
  it("marks the poisoned entry and leaves the rest priced", async () => {
    monitor();
    monitor({ code: POISON, strike: 99999 });
    const fetch: QuoteFetcher = (codes) => {
      if (codes.includes(POISON)) {
        return Promise.reject(new Error(`snapshot API failed: Unknown stock. ${POISON.slice(3)}`));
      }
      return Promise.resolve(codes.map((code) => ({ code, option_delta: 0.7 })));
    };
    const quotes = await run(fetch, true);
    expect(quotes.find((q) => q.code === CODE)!.snapshot!.option_delta).toBe(0.7);
    const poisoned = quotes.find((q) => q.code === POISON)!;
    expect(poisoned.snapshot).toBeNull();
    expect(poisoned.error).toBe("unknown contract");
  });
});

describe("the holdings a rule watches", () => {
  const position = (id: string, name: string, entry: number | null, legs: unknown[]) =>
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, ?, 'credit_spread', ?, 1, ?, ?, '2026-08-01 00:00:00.000000')`,
    ).run(id, name, EXPIRY, entry, toSqliteJson(legs));

  const link = (monitorId: string, positionId: string, scope: string) => {
    db.prepare("insert into monitor_positions values (?, ?)").run(monitorId, positionId);
    db.prepare("update monitors set scope = ? where id = ?").run(scope, monitorId);
  };

  it("reports cost to close, entry and P&L for a rule covering whole positions", async () => {
    const pid = "p".repeat(32);
    position(pid, "spread", 2.5, [
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]);
    const mid = combo();
    link(mid, pid, "all");

    const quotes = await run(quoting({
      [LEG_A]: { mid_price: 1.2, option_contract_size: 100 },
      [LEG_B]: { mid_price: 0.4, option_contract_size: 100 },
    }), true);
    const entry = quotes[0]!;
    expect(entry.positions).toEqual([{ id: pid, name: "spread" }]);
    expect(entry.cost_to_close).toBeCloseTo(0.8, 10); // 1.2 sold back − 0.4 returned
    expect(entry.entry).toBe(2.5);
    expect(entry.pnl).toBe(170); // (2.5 − 0.8) × 1 × 100
  });

  it("measures a position-backed rule on its cost to close, always above and absolute", async () => {
    // cost to close cannot be negative, so the comparison ignores the rule's own mode — matching
    // what the dashboard has shown since the sign reconciliation
    const pid = "p".repeat(32);
    position(pid, "spread", 2.5, [
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]);
    const mid = combo({ threshold: 1.6 });
    link(mid, pid, "all");
    const quotes = await run(quoting({
      [LEG_A]: { mid_price: 1.2, option_contract_size: 100 },
      [LEG_B]: { mid_price: 0.4, option_contract_size: 100 },
    }), true);
    // 0.8 of a 1.6 threshold, counted upward even though the rule says direction "above"/"abs"
    expect(quotes[0]!.fill).toBe(50);
  });

  it("offers no entry or P&L for a rule watching only part of a structure", async () => {
    // a leg rule's P&L would be a fraction of someone else's credit
    const pid = "p".repeat(32);
    position(pid, "spread", 2.5, [
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]);
    const mid = monitor({ code: LEG_A, strike: 8100, field: "mid_price", threshold: 2 });
    link(mid, pid, "leg");
    const quotes = await run(quoting({
      [LEG_A]: { mid_price: 1.2, option_contract_size: 100 },
      [LEG_B]: { mid_price: 0.4, option_contract_size: 100 },
    }));
    expect(quotes[0]!.scope).toBe("leg");
    expect(quotes[0]!.entry).toBeNull();
    expect(quotes[0]!.pnl).toBeNull();
    // and no cost to close either. A Monitor watches CONTRACTS, never a Position (CONTEXT.md):
    // the holding is found afterwards so the row can show what you took in, which does not make
    // a row about one option into a row about the condor it happens to sit inside. This used to
    // report 0.8 — the whole spread's — which is the figure that made the model look muddled.
    // Nothing is lost: it is still on the holding's own row, where it means something.
    expect(quotes[0]!.cost_to_close).toBeNull();
  });

  it("fetches the position's other legs even when no monitor names them", async () => {
    // without them the cost to close would be a partial sum
    const pid = "p".repeat(32);
    position(pid, "spread", 2.5, [
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]);
    const mid = monitor({ code: LEG_A, strike: 8100, field: "mid_price", threshold: 2 });
    link(mid, pid, "leg");
    const asked: string[][] = [];
    await watchlistQuotes(db, TZ, (codes) => {
      asked.push(codes);
      return Promise.resolve(codes.map((code) => ({ code })));
    }, { now: NOW, policy: POLICY });
    expect(asked[0]).toEqual([LEG_A, LEG_B].sort());
  });
});

describe("guards that are easy to lose", () => {
  it("gives a combo no per-contract snapshot even if its name matches a quoted code", async () => {
    // Contrived — a combo's code is a name the trader chose, so it normally cannot collide with a
    // contract. The guard is still load-bearing: without it the check is `byCode[m.code]`, and the
    // only thing stopping a combo from presenting one contract's figures as its own is that the
    // lookup happens to miss. Combo figures are signed sums; a single leg's snapshot beside them
    // would read as the combo's.
    combo({ code: "sep-condor" });
    const fetch: QuoteFetcher = (codes) => Promise.resolve([
      ...codes.map((code) => ({ code, mid_price: 1 })),
      { code: "sep-condor", mid_price: 99 },
    ]);
    const quotes = await run(fetch, true);
    expect(quotes[0]!.snapshot).toBeNull();
  });

  it("measures a position-backed rule under the rule's OWN mode, bar and bell together", async () => {
    // Was "counts a position-backed rule's fill upward even when the rule says below and signed":
    // the comparison was forced to above/abs because cost to close cannot be negative, and this
    // asserted 50%. The stated fear was an inverted bar calling a nearly-safe position nearly
    // breached.
    //
    // The rule's own verdict on 0.80 against "below 1.60, signed" is BREACHED — isBreached gives
    // 0.80 <= 1.60 — which is what a profit-taking alarm is for, and the sweep fires it. So the old
    // bar read "halfway there" beside no bell while Telegram had already sent: the drift ADR 0010
    // forbids, in the one case that asserted the bar and never the bell. The bar now follows the
    // rule it belongs to, and the bell with it.
    const pid = "p".repeat(32);
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, 'spread', 'credit_spread', ?, 1, 2.5, ?, '2026-08-01 00:00:00.000000')`,
    ).run(pid, EXPIRY, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]));
    const mid = combo({ threshold: 1.6 });
    db.prepare("update monitors set direction = 'below', compare = 'signed' where id = ?").run(mid);
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'all' where id = ?").run(mid);

    const quotes = await run(quoting({
      [LEG_A]: { mid_price: 1.2, option_contract_size: 100 },
      [LEG_B]: { mid_price: 0.4, option_contract_size: 100 },
    }), true);
    // 1.6/0.8 under the rule's own below/signed mode, capped at 100 — the target is met, not
    // half-met, which is the same thing the bell now says.
    expect(quotes[0]!.fill).toBe(100);
    expect(quotes[0]!.triggered, "0.80 is below 1.60: the sweep rings this").toBe(true);
  });
});

describe("the bell and the value share an instant", () => {
  /** The dashboard's figures come from THIS call, so its bell has to come from it too.
   *
   *  It did not. The payload carried the sweeper's stored `triggered` column beside a value
   *  fetched a moment ago, so a row could show a figure past its threshold with no bell, or a
   *  bell beside a figure well inside it. The alarm ENGINE is untouched by this: what it has
   *  decided, when it last messaged, and its cooldowns are all still the sweep's business. This
   *  is only about the row agreeing with itself. See ADR 0010.
   */
  const setEngineState = (id: string, triggered: number, lastValue: number | null) =>
    db.prepare("update monitors set triggered = ?, last_value = ? where id = ?")
      .run(triggered, lastValue, id);

  it("rings on a breach the last sweep has not seen", async () => {
    const id = monitor({ threshold: 0.6 });
    setEngineState(id, 0, 0.1); // the engine's record says calm; the market has moved since
    const [entry] = await run(quoting({ [CODE]: { option_delta: 0.7 } }));

    expect(entry!.snapshot!.option_delta).toBe(0.7);
    expect(entry!.triggered, "the row shows 0.7 against a 0.6 threshold and no bell").toBe(true);
  });

  it("falls silent once the value is back inside, whatever the engine still holds", async () => {
    const id = monitor({ threshold: 0.6 });
    setEngineState(id, 1, 0.9);
    const [entry] = await run(quoting({ [CODE]: { option_delta: 0.1 } }));

    expect(entry!.triggered, "a bell beside a figure well inside the threshold").toBe(false);
  });

  it("rings AT the threshold exactly, with no band around it", async () => {
    // CLAUDE.md: the bell flips truthfully at the EXACT threshold — no value hysteresis
    monitor({ threshold: 0.6 });
    const at = await run(quoting({ [CODE]: { option_delta: 0.6 } }));
    expect(at[0]!.triggered).toBe(true);

    const under = await run(quoting({ [CODE]: { option_delta: 0.5999999999 } }));
    expect(under[0]!.triggered).toBe(false);
  });

  it("never rings on a row it could not price", async () => {
    // an unreadable value is not a calm one and not a breaching one. The row draws "—", and a
    // bell beside a dash would be the stored state leaking back in by another door.
    const id = monitor({ threshold: 0.6 });
    setEngineState(id, 1, 0.9);
    const [entry] = await run(quoting({}));

    expect(entry!.snapshot).toBeNull();
    expect(entry!.triggered).toBe(false);
    expect(entry!.fill).toBeNull();
  });

  it("measures a position-backed combo on the same cost to close its fill bar uses", async () => {
    const mid = combo({ threshold: 3 });
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, ?, null, ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000')`,
    ).run("p1".padEnd(32, "0"), "spread", EXPIRY, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]));
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, "p1".padEnd(32, "0"));
    db.prepare("update monitors set scope = 'all', triggered = 0 where id = ?").run(mid);

    // sold at 5.00, bought at 1.00: 4.00 to close, past a 3.00 stop
    const [entry] = await run(quoting({
      [LEG_A]: { mid_price: 5.0 }, [LEG_B]: { mid_price: 1.0 },
    }), true);
    expect(entry!.cost_to_close).toBe(4);
    expect(entry!.triggered).toBe(true);
  });

  it("rings only on rows whose fill bar is full, since both read one figure", async () => {
    // the bar and the bell are the same claim drawn twice; they must not be able to disagree.
    // Only this direction is asserted: fill rounds, so 0.599 draws a full-looking bar at 99.83%
    // without breaching, and that is the bar being imprecise rather than the bell being wrong.
    monitor({ threshold: 0.6 });
    let checked = 0;
    for (const delta of [0.1, 0.3, 0.5, 0.59, 0.6, 0.61, 0.9, 2]) {
      const [entry] = await run(quoting({ [CODE]: { option_delta: delta } }));
      if (entry!.triggered) {
        expect(entry!.fill, `delta ${delta} rings with a fill of ${entry!.fill}`).toBe(100);
      }
      checked++;
    }
    expect(checked).toBe(8);
  });
});

describe("the exit schedule on a watchlist entry", () => {
  /** It rides on THIS payload rather than being fetched beside it, so `pace_gap` is the gap
   *  against the very Cost to close the row shows. Joining /positions/values on the dashboard
   *  would compute it against a different fetch's figure and put the row back to describing two
   *  instants, which is the thing ADR 0010 settled. */
  const declare = (positionId: string, openedAt: string) =>
    db.prepare("update positions set opened_at = ? where id = ?").run(openedAt, positionId);

  const spreadOf = (mid: Record<string, number>) => quoting(
    Object.fromEntries(Object.entries(mid).map(([k, v]) => [k, { mid_price: v }])),
  );

  const heldCombo = (entry: number) => {
    const mid = combo({ threshold: 3 });
    const pid = "p1".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'spread', null, ?, 1, ?, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(pid, EXPIRY, entry, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]));
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'all' where id = ?").run(mid);
    return { mid, pid };
  };

  it("is null until the Position's Opened is declared", async () => {
    heldCombo(2.0);
    const [e] = await run(spreadOf({ [LEG_A]: 5.0, [LEG_B]: 1.0 }), true);
    expect(e!.schedule).toBeNull();
  });

  it("names the holding it is FOR, so no client has to infer it from `positions`", async () => {
    // The detail sheet fetches this holding's own vol history by that id. `positions[0]` is the
    // same Position today, because a schedule needs scope "all" and exactly one holding — but a
    // client relying on that would follow the next change to either condition onto the wrong
    // trade in silence. A mutation sweep found nothing could tell a wrong id from the right one.
    const { pid } = heldCombo(2.0);
    declare(pid, "2026-07-11");
    const [e] = await run(spreadOf({ [LEG_A]: 5.0, [LEG_B]: 1.0 }), true);
    expect(e!.schedule!.position_id).toBe(pid);
  });

  it("rides on the same payload as the value, so the gap is against THAT cost", async () => {
    const { pid } = heldCombo(2.0);
    // Opened long before NOW, because an Opened in the future reads as unknown by design.
    declare(pid, "2026-07-11");
    const [e] = await run(spreadOf({ [LEG_A]: 5.0, [LEG_B]: 1.0 }), true);
    const s = e!.schedule!;

    expect(e!.cost_to_close).toBe(4);
    expect(s.dte_at_open).toBe(160);
    // taken from the entry rather than written out: NOW is 03:35 UTC, which is still the previous
    // evening in New York, so `dte` is 131 and not the 132 the calendar date suggests. Hardcoding
    // it is how this test first failed, and `dte` being market-reckoned is the whole point of it.
    expect(e!.dte).toBe(131);
    expect(s.on_pace).toBeCloseTo(2.0 * Math.sqrt(e!.dte / 160), 6);
    // the gap is computed from the cost in THIS entry, not from another fetch
    expect(s.pace_gap).toBeCloseTo(4 - s.on_pace!, 6);
    expect(s.target).toBeCloseTo(1.0, 6);
    expect(s.stop).toBeCloseTo(4.0, 6);
    expect(s.manage_by_dte).toBe(21);
  });

  it("is null for a rule that only watches part of a holding", async () => {
    // scope 'leg' means the rule covers a fraction of someone else's credit, and a schedule
    // built on it would be a schedule for a trade nobody put on
    const { mid, pid } = heldCombo(2.0);
    declare(pid, "2026-07-11");
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);
    const [e] = await run(spreadOf({ [LEG_A]: 5.0, [LEG_B]: 1.0 }), true);
    expect(e!.schedule).toBeNull();
  });

  it("is null for a rule spanning two Positions, which have no single Opened", async () => {
    // two Positions put on different days have no one DTE at entry, and a blended pace line
    // would hide that rather than say it. ADR 0004 allows the span; this declines to guess.
    const { mid, pid } = heldCombo(2.0);
    declare(pid, "2026-07-11");
    const other = "p2".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'other', null, ?, 1, 1.0, ?, '2026-08-01 00:00:00.000000', '2026-08-01', null)`,
    ).run(other, EXPIRY, toSqliteJson([{ side: "sold", option_type: "PUT", strike: 7100 }]));
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, other);

    const [e] = await run(spreadOf({ [LEG_A]: 5.0, [LEG_B]: 1.0 }), true);
    expect(e!.positions).toHaveLength(2);
    expect(e!.schedule).toBeNull();
  });
});

describe("a rule that watches only PART of a holding", () => {
  /** It reports the WHOLE holding's Cost to close, and that is deliberate.
   *
   *  It reads oddly — a row about one leg of a condor showing 6.40, the condor's cost — and I set
   *  out to "fix" it before finding the intent written down in two places: the watchlist fetches a
   *  Position's other legs even when no Monitor names them, "without them the cost to close would
   *  be a partial sum", and the sweep widens its batch for the same reason. The other legs are
   *  fetched PRECISELY so this figure can be whole.
   *
   *  So the question a leg rule answers is "what would it cost to buy back the thing this leg
   *  belongs to", which is the number you act on when a short strike starts moving. Entry and P&L
   *  are still withheld, because those would be a fraction of someone else's credit — the asymmetry
   *  is the point, and nothing said so until now.
   */
  const condorPosition = () => {
    const pid = "p9".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'condor', 'iron_condor', ?, 1, 6.86, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(pid, EXPIRY, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
    ]));
    return pid;
  };

  it("reports no holding cost on a row about ONE Contract", async () => {
    const mid = monitor({ strike: 8100, code: LEG_A, field: "option_delta", threshold: 0.18 });
    const pid = condorPosition();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(quoting({
      [LEG_A]: { mid_price: 5.0, option_delta: 0.11, option_contract_size: 100 },
      [LEG_B]: { mid_price: 1.0, option_delta: 0.05, option_contract_size: 100 },
    }));
    expect(e!.scope).toBe("leg");
    // the row shows the CONTRACT's own figures — its mid is 5.00 — and nothing about the spread
    // it sits inside. The spread's 4.00 belongs on the spread's row.
    expect(e!.snapshot!.mid_price).toBe(5);
    expect(e!.cost_to_close).toBeNull();
    expect(e!.entry).toBeNull();
    expect(e!.pnl).toBeNull();
  });

  it("DOES report it when that one Contract is the whole holding", async () => {
    // a lone held option is a Position too, and then the Contract and the holding are the same
    // thing — so all three figures appear. Found by a mutation sweep: nothing covered this case,
    // so removing the scope check broke nothing.
    const pid = "p8".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'lone call', null, ?, 1, 5.0, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(pid, EXPIRY, toSqliteJson([{ side: "sold", option_type: "CALL", strike: 8100 }]));
    const mid = monitor({ strike: 8100, code: LEG_A, field: "option_delta", threshold: 0.18 });
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'all' where id = ?").run(mid);

    const [e] = await run(quoting({
      [LEG_A]: { mid_price: 3.0, option_delta: 0.11, option_contract_size: 100 },
    }));
    expect(e!.scope).toBe("all");
    expect(e!.cost_to_close).toBe(3);
    expect(e!.entry).toBe(5);
    expect(e!.pnl).toBe(200);
  });

  it("alarms on its own field regardless, so the whole-holding cost cannot mislead it", async () => {
    // the figure is informational on a single-leg row: the rule compares option_delta, so a
    // 4.00 cost to close beside it can never move the bell
    const mid = monitor({ strike: 8100, code: LEG_A, field: "option_delta", threshold: 0.18 });
    const pid = condorPosition();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [calm] = await run(quoting({
      [LEG_A]: { mid_price: 5.0, option_delta: 0.11 },
      [LEG_B]: { mid_price: 1.0, option_delta: 0.05 },
    }));
    expect(calm!.triggered, "a delta of 0.11 against 0.18 must not ring").toBe(false);

    const [ringing] = await run(quoting({
      [LEG_A]: { mid_price: 5.0, option_delta: 0.19 },
      [LEG_B]: { mid_price: 1.0, option_delta: 0.05 },
    }));
    expect(ringing!.triggered).toBe(true);
  });
});

describe("a combo that covers only part of a holding", () => {
  /** It is measured on the cost of buying back the Contracts IT names, not the holding's.
   *
   *  An alarm written about the call side of a condor was compared against the whole condor's
   *  cost: you named two options and it fired on four. The original choice is sound — a
   *  position-backed combo is measured on a buy-back cost because that is positive, and a combo's
   *  own signed sum is negative for a credit structure — it simply did not notice an alarm
   *  covering part of a holding. So the figure narrows to the alarm's own Contracts, which for an
   *  alarm covering the whole holding is the same number it always gave.
   *
   *  Cost to close is widened to match (CONTEXT.md): what it costs to buy back the options in
   *  question, whether those are a Position's Legs or the Contracts a Monitor names.
   */
  const PUT_A = buildSpxCode(EXPIRY, "PUT", 7100);
  const PUT_B = buildSpxCode(EXPIRY, "PUT", 7050);

  /** the whole condor, as ONE holding */
  const condorHeld = () => {
    const pid = "pc".padEnd(32, "0");
    db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                              opened_at, manage_notified_at)
       values (?, 'condor', 'iron_condor', ?, 1, 6.86, ?, '2026-08-01 00:00:00.000000', null, null)`,
    ).run(pid, EXPIRY, toSqliteJson([
      { side: "sold", option_type: "CALL", strike: 8100 },
      { side: "bought", option_type: "CALL", strike: 8150 },
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7050 },
    ]));
    return pid;
  };

  /** sold 8100 at 5.00 / bought 8150 at 1.00  -> the call side costs 4.00 to buy back
   *  sold 7100 at 3.00 / bought 7050 at 1.00  -> the put side costs 2.00
   *  so the whole condor costs 6.00 */
  const priced = quoting({
    [LEG_A]: { mid_price: 5.0, option_delta: 0.30, option_contract_size: 100 },
    [LEG_B]: { mid_price: 1.0, option_delta: 0.20, option_contract_size: 100 },
    [PUT_A]: { mid_price: 3.0, option_delta: -0.25, option_contract_size: 100 },
    [PUT_B]: { mid_price: 1.0, option_delta: -0.15, option_contract_size: 100 },
  });

  /** an alarm naming only the two calls — minus is short, per the canonical convention */
  const callSide = (over: Record<string, unknown> = {}) => combo({
    code: "call-side", legs: [
      { sign: -1, option_type: "CALL", strike: 8100 },
      { sign: 1, option_type: "CALL", strike: 8150 },
    ], ...over,
  });

  it("costs what ITS contracts cost, not what the holding costs", async () => {
    const mid = callSide({ threshold: 3 });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(priced, true);
    expect(e!.scope).toBe("leg");
    expect(e!.cost_to_close, "it was reporting 6.00, the whole condor's").toBe(4);
  });

  it("alarms on its own cost, so a threshold means what it says", async () => {
    // 4.00 for the call side against a 5.00 threshold: calm. Measured on the condor's 6.00 it
    // would have been breached, which is the fault in one assertion.
    const mid = callSide({ threshold: 5 });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(priced, true);
    expect(e!.cost_to_close).toBe(4);
    expect(e!.triggered, "the condor's 6.00 would have rung this").toBe(false);
    expect(e!.fill).toBe(80);
  });

  it("uses the MID to cost it, whatever field the alarm watches", async () => {
    // the subtle one: a combo's own figure is the signed sum of ITS field, so an alarm on delta
    // has a delta sum, not a price. Negating that would have made the cost to close -(-0.10).
    const mid = callSide({ field: "option_delta", threshold: 0.5 });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(priced, true);
    // -0.30 + 0.20 under its signs
    expect(e!.combo_value).toBeCloseTo(-0.1, 10);
    // and the cost to close is still priced from the mids: 5.00 - 1.00
    expect(e!.cost_to_close).toBe(4);
    void mid;
  });

  it("rings what the ENGINE rings, whatever field a held combo watches", async () => {
    // The bell and the fill were measured on cost_to_close for ANY held combo — a price — with
    // direction and compare forced to above/abs, discarding the rule's own. So this delta rule
    // rang permanently off the condor's 4.00 while the sweep, comparing the delta sum through
    // monitorValue, stayed silent. ADR 0010: the bell "cannot drift from how an alarm is decided",
    // and the claim sat three lines under the code that broke it.
    //
    // The price cases above are unaffected: under compare 'abs' the sign washes out, so |-4.00|
    // and 4.00 give the same bell and the same 80% bar.
    const mid = callSide({ field: "option_delta", threshold: 0.5 });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(priced, true);
    expect(e!.cost_to_close, "the column is unchanged: still priced from the mids").toBe(4);
    expect(e!.combo_value).toBeCloseTo(-0.1, 10);
    expect(e!.triggered, "0.10 of a 0.50 threshold is calm, and the sweep agrees").toBe(false);
    expect(e!.fill, "|-0.10| / 0.50").toBe(20);
  });

  it("gives an alarm covering the WHOLE holding the same number as before", async () => {
    const mid = combo({
      code: "whole-condor", threshold: 7,
      legs: [
        { sign: -1, option_type: "CALL", strike: 8100 },
        { sign: 1, option_type: "CALL", strike: 8150 },
        { sign: -1, option_type: "PUT", strike: 7100 },
        { sign: 1, option_type: "PUT", strike: 7050 },
      ],
    });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'all' where id = ?").run(mid);

    const [e] = await run(priced, true);
    expect(e!.scope).toBe("all");
    expect(e!.cost_to_close).toBe(6);
    expect(e!.entry).toBe(6.86);
    expect(e!.pnl).not.toBeNull();
  });

  it("costs the same whichever leg convention the alarm was written in", async () => {
    // The point of costing from the holding's sides. Two alarms naming the SAME two contracts,
    // one written "-1 on sold" (what the dashboard says) and one "+1 on sold" (what the schema
    // said until #97). Their own signed sums are exact opposites; what it costs to buy those two
    // options back is one number, because that is a fact about the holding and not about signs.
    const pid = condorHeld();
    const canonical = callSide({ code: "minus-short", threshold: 9 });
    const inverted = combo({
      code: "plus-short", threshold: 9, legs: [
        { sign: 1, option_type: "CALL", strike: 8100 },
        { sign: -1, option_type: "CALL", strike: 8150 },
      ],
    });
    for (const mid of [canonical, inverted]) {
      db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
      db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);
    }

    const entries = await run(priced, true);
    const a = entries.find((e) => e.code === "minus-short")!;
    const b = entries.find((e) => e.code === "plus-short")!;

    expect(a.combo_value).toBe(-4);
    expect(b.combo_value).toBe(4);
    expect(a.cost_to_close, "one fact about the holding").toBe(4);
    expect(b.cost_to_close, "and the same fact, written the other way round").toBe(4);
  });

  it("still offers no entry or P&L for the part, which would be a fraction of a credit", async () => {
    const mid = callSide({ threshold: 3 });
    const pid = condorHeld();
    db.prepare("insert into monitor_positions values (?, ?)").run(mid, pid);
    db.prepare("update monitors set scope = 'leg' where id = ?").run(mid);

    const [e] = await run(priced, true);
    expect(e!.entry).toBeNull();
    expect(e!.pnl).toBeNull();
    expect(e!.schedule).toBeNull();
  });

  it("leaves a combo you do not hold exactly as it was", async () => {
    // no holding, so no buy-back cost: the row shows its own signed sum and is measured on it
    // under its own direction and compare
    callSide({ threshold: 3, direction: "below", compare: "signed" });
    const [e] = await run(priced, true);
    expect(e!.cost_to_close).toBeNull();
    // -1 x 5.00 + 1 x 1.00 under the canonical signs: its own figure is NEGATIVE for a credit
    // structure, which is exactly why a buy-back cost was introduced for the ones you hold
    expect(e!.combo_value).toBe(-4);
  });
});
