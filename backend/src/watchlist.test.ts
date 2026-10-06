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

const run = (fetch: QuoteFetcher, includeCombos = false) =>
  watchlistQuotes(db, TZ, fetch, { includeCombos, now: NOW });

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
    expect(quotes[0]!.cost_to_close).toBeCloseTo(0.8, 10);
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
    }, { now: NOW });
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

  it("counts a position-backed rule's fill upward even when the rule says below and signed", async () => {
    // cost to close cannot be negative, so the comparison is forced to above/abs. A rule written
    // "below, signed" would otherwise invert the bar and show a nearly-safe position as nearly
    // breached.
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
    // 0.8 of 1.6 counted upward. Under the rule's own below/signed mode it would be 1.6/0.8 -> 100.
    expect(quotes[0]!.fill).toBe(50);
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
