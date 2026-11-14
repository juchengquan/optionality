/** `/positions`. Ported from tests/test_positions_api.py (ADR 0009, phase 5).
 *
 *  The total-entry group landed with `applyTotalEntry` in 5b; what is here is the holding itself,
 *  its live figures, and the linkage in both directions.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildSpxCode, parseSpxCode } from "optionality/domain/contract";
import {
  type FakeProvider, type Harness, body, harness, json, pricedFetcher,
} from "../../../../testing/harness.ts";

let h: Harness;
afterEach(() => h?.close());

const EXPIRY = "2026-12-18";
const CONDOR_LEGS = [
  { side: "short", option_type: "CALL", strike: 8050 },
  { side: "long", option_type: "CALL", strike: 8075 },
  { side: "short", option_type: "PUT", strike: 7100 },
  { side: "long", option_type: "PUT", strike: 7075 },
];
const condor = (over: Record<string, unknown> = {}) => ({
  name: "1016_IC", strategy: "iron_condor", strike_date: EXPIRY, contracts: 1, entry: 3.0,
  legs: CONDOR_LEGS, ...over,
});

const start = (fetchQuotes: FakeProvider = pricedFetcher) => (h = harness({ fetchQuotes }));
const post = (payload: unknown) => h.call("/positions", json(payload));
const patch = (id: string, payload: unknown) =>
  h.call(`/positions/${id}`, { ...json(payload), method: "PATCH" });

/** The links a monitor has, and the scope it was given. */
const links = (monitorId: string): [string[], string | null] => {
  const ids = (h.db.prepare("select position_id from monitor_positions where monitor_id = ? order by position_id")
    .all(monitorId) as { position_id: string }[]).map((r) => r.position_id);
  const row = h.db.prepare("select scope from monitors where id = ?").get(monitorId) as
    { scope: string | null } | undefined;
  return [ids, row?.scope ?? null];
};

/** A response body can only be read once, so it is read once and used for both the assertion and
 *  its failure message — vitest evaluates that message eagerly. */
const created201 = async (resp: Response): Promise<string> => {
  const data = await body(resp);
  expect(resp.status, JSON.stringify(data)).toBe(201);
  return data.id as string;
};

const makeMonitor = (over: Record<string, unknown>) =>
  h.call("/monitors", json({ field: "option_delta", threshold: 0.2, direction: "above", ...over }))
    .then(created201);

const makePosition = (name: string, strikeDate: string, legs: unknown[]) =>
  post({ name, strike_date: strikeDate, legs }).then(created201);

describe("what vol did to a holding, over its own samples", () => {
  /** The route reads history, which no other route does: every figure elsewhere comes from one
   *  live batch. It is a separate request from `/quotes` on purpose — the dashboard polls that
   *  every 15 seconds per open tab, and this changes once a market day (ADR 0011). */
  const sample = (
    id: string, on: string, dte: number,
    iv: Record<string, number> | null, vega: Record<string, number> | null,
  ) => {
    h.db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
       values (?, ?, ?, 3.0, ?, ?)`,
    ).run(id, on, dte, iv === null ? null : JSON.stringify(iv), vega === null ? null : JSON.stringify(vega));
  };
  const legCodes = () => CONDOR_LEGS.map((l) => buildSpxCode(EXPIRY, l.option_type as "CALL" | "PUT", l.strike));
  const flat = (v: number) => Object.fromEntries(legCodes().map((c) => [c, v]));

  it("measures the vol move from the day it was opened", async () => {
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    const [sc] = legCodes();
    sample(id, "2026-10-06", 45, flat(10), flat(4));
    sample(id, "2026-10-07", 44, { ...flat(10), [sc!]: 11 }, flat(4));

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status).toBe(200);
    // the 8050 call is SOLD, so a point on its vol costs its vega to buy back
    // and the gap it splits, at that same close (#333): 3.00 to close against 3.00 × √(44 ÷ 73)
    // on pace, so the rest is what is left of it once vol's 4 is taken out
    const gap = 3.0 - 3.0 * Math.sqrt(44 / 73);
    expect(await body(resp)).toEqual({
      vol: 4, from: "2026-10-06", to: "2026-10-07", days: 1, reason: null,
      // a row with no observed time is said as one, never claimed as the close
      at: "2026-10-07", timing: "unrecorded", gap, gap_reason: null, rest: gap - 4,
      // the legs' flat vegas cancel: no cover, and why
      vega: 0, cover: null, cover_reason: "its legs' vegas cancel out, so no move in vol would cover the gap",
    });
  });

  it("says so plainly when there is no baseline, rather than guessing one", async () => {
    // the live condor's case, and the shape every Position declared after the fact is in
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    sample(id, "2026-10-12", 39, flat(10), flat(4));
    sample(id, "2026-10-13", 38, flat(11), flat(4));

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status).toBe(200);
    expect(await body(resp)).toMatchObject({
      vol: null, from: null, to: null, days: null, rest: null,
      // and says why, in the service's words, for the dashboard to say as they are (#333)
      reason: "its samples begin on 12 Oct, not on 6 Oct when it was Opened: "
        + "the vol it was sold at was never recorded",
      at: "2026-10-13",
    });
  });

  it("survives a sample whose stored reading is not a number", async () => {
    // The route's own comment promises "a corrupt map costs the figure, never the request", and
    // only unparseable TEXT was covered. A map that parses but holds a string gave vol: NaN, and
    // the output schema REJECTS NaN — so the request answered 500 instead of a null figure. Found
    // by a code review; the 500 path had no test at all.
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    const [sc] = legCodes();
    h.db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
       values (?, '2026-10-06', 45, 3.0, ?, ?)`,
    ).run(id, JSON.stringify({ ...flat(10), [sc!]: "not a number" }), JSON.stringify(flat(4)));

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status, "a figure it cannot compute is not a server error").toBe(200);
    expect((await body(resp)).vol).toBeNull();
  });

  it("survives a sample whose stored reading is a JSON null", async () => {
    // how a bad OpenD field actually lands: Number() of it is NaN, and JSON.stringify writes NaN
    // as null. The writer now rejects it, so this is the reader holding the line for rows already
    // stored that way.
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    const [sc] = legCodes();
    h.db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
       values (?, '2026-10-06', 45, 3.0, ?, ?)`,
    ).run(id, JSON.stringify({ ...flat(10), [sc!]: null }), JSON.stringify(flat(4)));

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status).toBe(200);
    expect((await body(resp)).vol).toBeNull();
  });

  it("is 404 for a Position that does not exist", async () => {
    start();
    expect((await h.call("/positions/nope/vol")).status).toBe(404);
  });

  it("survives a sample whose stored JSON will not parse", async () => {
    // the maps are written by the sweeper and read here; a corrupt one should cost the figure,
    // never the request. Nothing else on the dashboard would load if this threw.
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    h.db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
       values (?, '2026-10-06', 45, 3.0, '{not json', null)`,
    ).run(id);

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status).toBe(200);
    expect((await body(resp)).vol).toBeNull();
  });
});

describe("a holding's daily samples, served for the burndown and the IV chart (#295)", () => {
  /** Stored history and nothing live: the Provider here throws on any call, so a samples route that
   *  asked it anything would fail rather than pass. */
  const refusing: FakeProvider = async () => { throw new Error("the samples asked the Provider"); };
  const legCodes = () => CONDOR_LEGS.map((l) => buildSpxCode(EXPIRY, l.option_type as "CALL" | "PUT", l.strike));
  const flat = (v: number) => JSON.stringify(Object.fromEntries(legCodes().map((c) => [c, v])));
  const sample = (
    id: string, on: string, dte: number, cost: number, observedAt: string | null,
    maps: { iv?: string | null; vega?: string | null; delta?: string | null; spx?: number | null } = {},
  ) => {
    h.db.prepare(
      `insert into position_samples
         (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega, legs_delta, observed_at, spx)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, on, dte, cost, maps.iv ?? null, maps.vega ?? null, maps.delta ?? null, observedAt,
      maps.spx ?? null);
  };
  /** A holding made while the Provider still answers its creation probe, which then refuses. */
  const made = async (over: Record<string, unknown> = {}) => {
    let open = true;
    start(async (codes) => {
      if (!open) return refusing(codes);
      return codes.map((code) => ({ code }));
    });
    const id = await created201(await post(condor(over)));
    open = false;
    return id;
  };

  it("serves each day's figures, its on-pace from the exit schedule and whether it was a close", async () => {
    // opened at 73 DTE for a 3.00 credit, under the default policy: take half, stop at twice
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    // 16:00 EDT, the close
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000",
      { iv: flat(14.5), vega: flat(4.25), delta: flat(0.2), spx: 6612.5 });
    // 20:30 EDT: a missed session, filled that evening
    sample(id, "2026-10-07", 72, 2.75, "2026-10-08 00:30:00.000000");
    // written before observed_at existed
    sample(id, "2026-10-08", 71, 2.5, null);

    const resp = await h.call(`/positions/${id}/samples`);
    expect(resp.status).toBe(200);
    const data = await body(resp);
    expect(data.levels).toEqual({ dte_at_open: 73, target: 1.5, stop: 6, target_dte: 18, manage_by_dte: 21 });
    expect(data.samples).toEqual([
      {
        observed_on: "2026-10-06", observed_at: "2026-10-07 04:00:00+08:00", timing: "close", dte: 73,
        cost_to_close: 2.9, on_pace: 3, spx: 6612.5, before_correction: false,
        legs_iv: JSON.parse(flat(14.5)), legs_vega: JSON.parse(flat(4.25)), legs_delta: JSON.parse(flat(0.2)),
      },
      {
        observed_on: "2026-10-07", observed_at: "2026-10-08 08:30:00+08:00", timing: "after-close", dte: 72,
        cost_to_close: 2.75, on_pace: 3 * Math.sqrt(72 / 73), spx: null, before_correction: false,
        legs_iv: null, legs_vega: null, legs_delta: null,
      },
      {
        observed_on: "2026-10-08", observed_at: null, timing: "unrecorded", dte: 71,
        cost_to_close: 2.5, on_pace: 3 * Math.sqrt(71 / 73), spx: null, before_correction: false,
        legs_iv: null, legs_vega: null, legs_delta: null,
      },
    ]);
  });

  it("serves the planned decay at every DTE from the open to expiry, as the domain computes it", async () => {
    // the line is the service's figure, so the browser draws points and computes no curve
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    const { plan } = await body(await h.call(`/positions/${id}/samples`));
    expect(plan).toHaveLength(74);
    expect(plan[0]).toEqual({ dte: 73, on_pace: 3 });
    expect(plan[73 - 21]).toEqual({ dte: 21, on_pace: 3 * Math.sqrt(21 / 73) });
    expect(plan[73]).toEqual({ dte: 0, on_pace: 0 });
  });

  it("serves no schedule and no plan for a holding whose Opened nobody recorded", async () => {
    const id = await made({ entry: 3 });
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000");
    const data = await body(await h.call(`/positions/${id}/samples`));
    expect(data.levels).toBeNull();
    expect(data.plan).toEqual([]);
    expect(data.samples[0].on_pace).toBeNull();
    expect(data.samples[0].cost_to_close).toBe(2.9);
  });

  it("serves a debit's schedule with no Target or Stop, and its signed decay", async () => {
    const id = await made({ opened_at: "2026-10-06", entry: -2 });
    const data = await body(await h.call(`/positions/${id}/samples`));
    expect(data.levels).toEqual({ dte_at_open: 73, target: null, stop: null, target_dte: null, manage_by_dte: 21 });
    expect(data.plan[0]).toEqual({ dte: 73, on_pace: -2 });
  });

  it("serves nothing after a backdated close, and deletes nothing (ADR 0022)", async () => {
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000");
    sample(id, "2026-10-07", 72, 2.8, "2026-10-07 20:00:00.000000");
    h.db.prepare("update positions set closed_on = '2026-10-06', exit = 2.9 where id = ?").run(id);
    const data = await body(await h.call(`/positions/${id}/samples`));
    expect(data.samples.map((s: { observed_on: string }) => s.observed_on)).toEqual(["2026-10-06"]);
    expect(h.db.prepare("select count(*) as n from position_samples").get()).toEqual({ n: 2 });
  });

  it("costs a corrupt map its own figure, never the request", async () => {
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    const [sc] = legCodes();
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000", {
      iv: "{not json",
      vega: JSON.stringify({ ...JSON.parse(flat(4)), [sc!]: "four" }),
      delta: JSON.stringify([0.2]),
    });
    const resp = await h.call(`/positions/${id}/samples`);
    expect(resp.status).toBe(200);
    const [s] = (await body(resp)).samples;
    expect([s.legs_iv, s.legs_vega, s.legs_delta]).toEqual([null, null, null]);
  });

  it("costs a stamp it cannot read its own timing, never the request", async () => {
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06T20:00:00Z");
    sample(id, "2026-10-07", 72, 2.8, "garbage");
    const resp = await h.call(`/positions/${id}/samples`);
    expect(resp.status).toBe(200);
    expect((await body(resp)).samples.map((s: { timing: string; observed_at: string | null }) =>
      [s.timing, s.observed_at])).toEqual([["unrecorded", null], ["unrecorded", null]]);
  });

  it("costs a reading too large for a double its map, never the request", async () => {
    // JSON.parse reads 1e400 as Infinity; the Python reads an integer that long exactly
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    const [sc] = legCodes();
    sample(id, "2026-10-06", 73, 2.9, "2026-10-06 20:00:00.000000", { iv: `{"${sc}": 1${"0".repeat(400)}}` });
    const resp = await h.call(`/positions/${id}/samples`);
    expect(resp.status).toBe(200);
    expect((await body(resp)).samples[0].legs_iv).toBeNull();
  });

  it("answers an empty history for a holding never sampled", async () => {
    const id = await made({ opened_at: "2026-10-06", entry: 3 });
    expect((await body(await h.call(`/positions/${id}/samples`))).samples).toEqual([]);
  });

  it("is 404 for a holding that does not exist", async () => {
    start(refusing);
    expect((await h.call("/positions/nope/samples")).status).toBe(404);
  });
});

describe("the payoff at expiry (#291)", () => {
  /** At expiry only, so it needs the legs, the Entry and the count and nothing else (ADR 0023):
   *  neither form may ask the Provider anything. The Provider here prices what a creation probe
   *  asks, and is then told to refuse, so a payoff that reached it would fail rather than pass. */
  let asked: string[][] = [];
  let open = true;
  const watching: FakeProvider = async (codes) => {
    if (!open) asked.push(codes);
    if (!open) throw new Error("the payoff asked the Provider");
    return codes.map((code) => ({ code }));
  };
  const startWatching = () => { asked = []; open = true; start(watching); };
  const PUT_SPREAD = [
    { side: "short", option_type: "PUT", strike: 7100 }, { side: "long", option_type: "PUT", strike: 7075 },
  ];

  it("draws a holding's from its legs, its Entry and its count, asking the Provider nothing", async () => {
    startWatching();
    const id = await created201(await post(condor({ entry: 3, contracts: 2 })));
    open = false;
    const resp = await h.call(`/positions/${id}/payoff`);
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({
      at_strikes: [
        { spx: 7075, pnl: -44 }, { spx: 7100, pnl: 6 }, { spx: 8050, pnl: 6 }, { spx: 8075, pnl: -44 },
      ],
      slope_below: 0, slope_above: 0, breakevens: [7097, 8053], max_profit: 6, max_loss: -44,
    });
    expect(asked).toEqual([]);
  });

  it("draws a closed holding's too: its legs and its Entry are kept (ADR 0022)", async () => {
    startWatching();
    const id = await created201(await post(condor()));
    expect((await h.call(`/positions/${id}/close`, json({ exit: 1 }))).status).toBe(200);
    open = false;
    expect((await h.call(`/positions/${id}/payoff`)).status).toBe(200);
  });

  it("is 404 for a holding that does not exist", async () => {
    startWatching();
    const resp = await h.call("/positions/nope/payoff");
    expect(resp.status).toBe(404);
  });

  it("refuses a holding with no Entry, rather than drawing a curve at a credit nobody took", async () => {
    startWatching();
    const id = await created201(await post(condor({ name: "1016_IC", entry: null })));
    open = false;
    const resp = await h.call(`/positions/${id}/payoff`);
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("position '1016_IC' has no entry: record what was taken in to draw its payoff");
  });

  it("draws draft legs for an Entry, writing nothing and asking the Provider nothing", async () => {
    startWatching();
    open = false;
    const before = h.db.prepare("select count(*) as n from positions").get() as { n: number };
    const resp = await h.call("/positions/payoff", json({ legs: PUT_SPREAD, entry: 1.5 }));
    expect(resp.status).toBe(200);
    // one contract when the count is not given, as a holding is
    expect(await body(resp)).toEqual({
      at_strikes: [{ spx: 7075, pnl: -23.5 }, { spx: 7100, pnl: 1.5 }],
      slope_below: 0, slope_above: 0, breakevens: [7098.5], max_profit: 1.5, max_loss: -23.5,
    });
    expect(h.db.prepare("select count(*) as n from positions").get()).toEqual(before);
    expect(asked).toEqual([]);
  });

  it("counts draft legs across the contracts given", async () => {
    startWatching();
    const resp = await h.call("/positions/payoff", json({ legs: PUT_SPREAD, entry: 1.5, contracts: 3 }));
    expect((await body(resp)).max_profit).toBe(4.5);
  });

  it("refuses a draft leg whose strike is not above zero, in zod's words", async () => {
    startWatching();
    for (const strike of [0, -7100]) {
      const resp = await h.call("/positions/payoff", json({
        legs: [{ side: "short", option_type: "PUT", strike }], entry: 1,
      }));
      expect(resp.status).toBe(422);
      expect((await body(resp)).detail).toBe("✖ Too small: expected number to be >0\n  → at legs[0].strike");
    }
  });

  it("refuses draft legs with no Entry, or none at all", async () => {
    startWatching();
    expect((await h.call("/positions/payoff", json({ legs: PUT_SPREAD }))).status).toBe(422);
    expect((await h.call("/positions/payoff", json({ legs: [], entry: 1 }))).status).toBe(422);
    expect((await h.call("/positions/payoff", json({
      legs: [{ side: "sold", option_type: "PUT", strike: 7100 }], entry: 1,
    }))).status).toBe(422);
  });
});

describe("deleting a holding frees the rules its contracts were blocking", () => {
  /** Reported from the live dashboard: adding an entry answered `409 position '1120_BS_7100'
   *  already exists`, on a rule whose row showed no positions at all beside a holding that had
   *  an entry and an opened date.
   *
   *  The chain, as the live database recorded it. A condor held the two strikes, so the rule was
   *  linked to the condor with scope "leg". A put spread at those same strikes was added later
   *  and changed nothing, because only ORPHANS are considered. The condor was then deleted, and
   *  deleting a holding clears its links — so the rule lost the only one it had. Nothing
   *  recomputes a link outside a create, so it stayed orphaned, invisible to the holding that was
   *  now the unambiguous owner of its contracts. The dashboard then offered to create a holding
   *  whose name was already taken, and the 409 was the server catching it.
   *
   *  Re-adopting after a delete is safe by adoptOrphanMonitors's own design: it looks only at
   *  monitors with no link and only ever adds. "What you already have cannot be taken away by
   *  something you subsequently hold" — nor by something you subsequently drop.
   */
  const holdingOf = (name: string, legs: unknown[], entry: number) =>
    post(condor({ name, legs, entry }));

  const spreadRule = async () => (await body(await h.call("/monitors", json({
    name: "spread_rule", strike_date: EXPIRY, field: "mid_price", threshold: 1,
    direction: "above", legs: [
      { sign: -1, option_type: "PUT", strike: 7100 },
      { sign: 1, option_type: "PUT", strike: 7075 },
    ],
  })))).id as string;

  it("adopts the holding left behind, which the delete had orphaned it from", async () => {
    start();
    const wide = await created201(await holdingOf("wide", CONDOR_LEGS, 3.0));
    const rid = await spreadRule();
    // the condor holds these strikes among others, so the rule watches part of it
    expect(links(rid), "linked to the wider holding").toEqual([[wide], "leg"]);

    // the narrower holding arrives later and changes nothing: only orphans are considered
    const narrow = await created201(await holdingOf("narrow", [
      { side: "short", option_type: "PUT", strike: 7100 },
      { side: "long", option_type: "PUT", strike: 7075 },
    ], 1.2));
    expect(links(rid), "still the wider one").toEqual([[wide], "leg"]);

    // deleting the wider holding clears that link. Without re-adoption the rule is orphaned for
    // ever, beside a holding that now covers its contracts exactly.
    expect((await h.call(`/positions/${wide}`, { method: "DELETE" })).status).toBe(204);
    expect(links(rid)).toEqual([[narrow], "all"]);
  });

  it("reports the holding's entry afterwards, which is what the owner could not see", async () => {
    start();
    const wide = await created201(await holdingOf("wide", CONDOR_LEGS, 3.0));
    const rid = await spreadRule();
    await created201(await holdingOf("narrow", [
      { side: "short", option_type: "PUT", strike: 7100 },
      { side: "long", option_type: "PUT", strike: 7075 },
    ], 1.2));
    await h.call(`/positions/${wide}`, { method: "DELETE" });

    const rows = await body(await h.call("/quotes")) as { id: string; entry: number | null }[];
    expect(rows.find((r) => r.id === rid)?.entry, "the entry the rule could not see").toBe(1.2);
  });

  it("clears the scope of a rule left holding nothing, so it stops claiming one", async () => {
    // A rule's scope says HOW it covers its holding — "all" the whole thing, "leg" part of it.
    // Deleting the holding cleared the link and left the scope behind, so the live
    // US.SPXW261120C8200000 read scope "leg" while holding nothing at all. No figure derives
    // from it (every one guards on positions being non-empty), so this is truthfulness rather
    // than a wrong number — but a rule that says it watches part of something, beside an empty
    // list of what, is a thing a reader has to explain away.
    start();
    const only = await created201(await holdingOf("only", CONDOR_LEGS, 3.0));
    const rid = (await body(await h.call("/monitors", json({
      field: "option_delta", threshold: 0.2, strike_date: EXPIRY,
      option_type: "CALL", strike: 8050, direction: "above",
    })))).id as string;
    // one leg of the condor, so it covers part of it
    expect(links(rid)).toEqual([[only], "leg"]);

    expect((await h.call(`/positions/${only}`, { method: "DELETE" })).status).toBe(204);
    expect(links(rid), "no holding, and no claim to one").toEqual([[], null]);
  });

  it("leaves the scope of a rule that still HAS a holding", async () => {
    // only the link-less are cleared: a rule whose holding survives must keep saying how it
    // covers it, or the next sweep reads a whole-position rule as a leg rule
    start();
    const keep = await created201(await holdingOf("keep", CONDOR_LEGS, 3.0));
    const rid = (await body(await h.call("/monitors", json({
      field: "option_delta", threshold: 0.2, strike_date: EXPIRY,
      option_type: "CALL", strike: 8050, direction: "above",
    })))).id as string;
    const other = await created201(await holdingOf("other", [
      { side: "short", option_type: "PUT", strike: 6000 },
      { side: "long", option_type: "PUT", strike: 5950 },
    ], 0.5));

    expect((await h.call(`/positions/${other}`, { method: "DELETE" })).status).toBe(204);
    expect(links(rid), "untouched").toEqual([[keep], "leg"]);
  });

  it("keeps the scope adoption worked out, rather than clearing it straight after", async () => {
    // The clearing sits beside adoption in the same transaction, and this is what says the two do
    // not fight. Order-independent, which the first version of the comment beside the code denied:
    // clearing skips anything with a link and adoption always sets a scope on what it places, so
    // each only touches rows the other leaves alone. A mutation sweep swapped them and nothing
    // failed, which is how that was found.
    start();
    const wide = await created201(await holdingOf("wide", CONDOR_LEGS, 3.0));
    const rid = await spreadRule();
    const narrow = await created201(await holdingOf("narrow", [
      { side: "short", option_type: "PUT", strike: 7100 },
      { side: "long", option_type: "PUT", strike: 7075 },
    ], 1.2));

    await h.call(`/positions/${wide}`, { method: "DELETE" });
    expect(links(rid), "adopted, and its new scope kept").toEqual([[narrow], "all"]);
  });

  it("leaves a rule that already has a link alone", async () => {
    // only orphans are considered, so a rule that has worked for weeks cannot lose its holding
    // because of something that happened to another one
    start();
    const keep = await created201(await holdingOf("keep", CONDOR_LEGS, 3.0));
    const rid = (await body(await h.call("/monitors", json({
      name: "whole_rule", strike_date: EXPIRY, field: "mid_price", threshold: 1,
      direction: "above", legs: CONDOR_LEGS.map((l) => ({
        sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike,
      })),
    })))).id as string;
    expect(links(rid)).toEqual([[keep], "all"]);

    const other = await created201(await holdingOf("other", [
      { side: "short", option_type: "PUT", strike: 6000 },
      { side: "long", option_type: "PUT", strike: 5950 },
    ], 0.5));
    expect((await h.call(`/positions/${other}`, { method: "DELETE" })).status).toBe(204);
    expect(links(rid), "untouched by an unrelated delete").toEqual([[keep], "all"]);
  });

  it("adopts nothing when the delete leaves nothing to adopt", async () => {
    start();
    const only = await created201(await holdingOf("only", CONDOR_LEGS, 3.0));
    const rid = (await body(await h.call("/monitors", json({
      name: "whole_rule", strike_date: EXPIRY, field: "mid_price", threshold: 1,
      direction: "above", legs: CONDOR_LEGS.map((l) => ({
        sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike,
      })),
    })))).id as string;
    await h.call(`/positions/${only}`, { method: "DELETE" });
    // and no scope either: it covered a holding that is gone
    expect(links(rid), "nothing holds these contracts now").toEqual([[], null]);
  });
});

describe("the round trip", () => {
  it("creates, lists and deletes", async () => {
    start();
    const created = await post(condor());
    expect(created.status).toBe(201);
    const data = await body(created);
    expect(data.id).toHaveLength(32);
    expect(data.name).toBe("1016_IC");
    expect(data.strategy).toBe("iron_condor");
    expect(data.legs).toHaveLength(4);

    expect((await post(condor())).status).toBe(409); // name taken

    expect((await body(await h.call("/positions"))).map((p: { name: string }) => p.name))
      .toEqual(["1016_IC"]);

    expect((await h.call(`/positions/${data.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await body(await h.call("/positions"))).toEqual([]);
  });

  it("accepts a single held option as a position", async () => {
    start();
    expect((await post(condor({ name: "one", legs: [CONDOR_LEGS[0]] }))).status).toBe(201);
  });

  it("refuses a position with no legs at all", async () => {
    start();
    expect((await post(condor({ name: "none", legs: [] }))).status).toBe(422);
  });

  it("refuses a side that is neither long nor short, including the old sold/bought", async () => {
    // ADR 0013 renamed Side. A caller still sending the old word gets a 422 naming the field,
    // not a holding whose legs every figure then reads as bought
    start();
    for (const side of ["sold", "bought", "buy"]) {
      expect((await post(condor({ legs: [{ side, option_type: "CALL", strike: 8050 }] })))
        .status).toBe(422);
    }
  });

  it("normalises a compact date, and refuses an impossible one", async () => {
    start();
    const created = await post(condor({ name: "compact", strike_date: "20261218" }));
    expect((await body(created)).strike_date).toBe(EXPIRY);
    expect((await post(condor({ name: "bad", strike_date: "2026-02-30" }))).status).toBe(422);
  });

  it("is a 404 for a position that was never there", async () => {
    start();
    expect((await patch("nope", { entry: 1.0 })).status).toBe(404);
    expect((await h.call("/positions/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("defaults contracts to one, and refuses zero", async () => {
    start();
    const created = await body(await post({ name: "d", strike_date: EXPIRY, legs: [CONDOR_LEGS[0]] }));
    expect(created.contracts).toBe(1);
    expect(created.entry).toBeNull();
    expect((await post(condor({ name: "z", contracts: 0 }))).status).toBe(422);
  });
});

describe("the creation gate", () => {
  it("refuses while any leg does not exist, and persists nothing", async () => {
    // the same strict gate as monitors: nothing enters the table unverified
    start(async (codes) => {
      const unknown = codes.filter((c) => c.endsWith("C8050000"));
      const { records } = await pricedFetcher(codes.filter((c) => !unknown.includes(c)));
      return { records, unknown };
    });
    const resp = await post(condor());
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/does not exist/);
    expect(await body(await h.call("/positions"))).toEqual([]);
  });

  it("refuses when the probe threw", async () => {
    start(() => Promise.reject(new Error("Client connection failed!")));
    const resp = await post(condor());
    expect(resp.status).toBe(422);
    // the Provider's own sentence, which is what says whether it could not be reached or answered
    // and declined the security (ADR 0018)
    expect((await body(resp)).detail).toBe(
      "cannot verify contract: the Provider did not confirm it — Client connection failed!",
    );
  });
});

describe("/positions/values", () => {
  it("reports cost to close, P&L, the contract size and the greeks", async () => {
    start();
    await post(condor({ entry: 3.0, contracts: 2 }));
    const values = await body(await h.call("/positions/values"));
    expect(values).toHaveLength(1);
    const v = values[0];
    expect(v.cost_to_close).toBe(4.5); // (5.0 + 3.0) sold back − (2.0 + 1.5) returned
    expect(v.pnl).toBe((3.0 - 4.5) * 2 * 100); // sold at 3.00, costs 4.50 to close
    expect(v.contract_size).toBe(100.0);
    // exposure-signed, not cost-signed: two short legs against two long at 0.2 each
    expect(v.greeks.option_delta).toBe(0);
    expect(v.fetched_at).toMatch(/\+08:00$/);
  });

  it("takes the contract size from the quotes rather than assuming 100", async () => {
    // every other test prices at 100, so a route answering a constant 100 passed them all; only a
    // size no constant would guess tells the quotes' figure from an assumption
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return records.map((r) => ({ ...r, option_contract_size: 10 }));
    });
    await post(condor({ entry: 3.0, contracts: 2 }));
    const v = (await body(await h.call("/positions/values")))[0];
    expect(v.contract_size).toBe(10);
    expect(v.pnl).toBe((3.0 - 4.5) * 2 * 10);
  });

  it("reports no contract size, and so no P&L, when no quote carries one", async () => {
    // the cost to close is points and needs no size; P&L is money and is never priced at a guess
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return records.map((r) => {
        const unsized = { ...r };
        delete unsized.option_contract_size;
        return unsized;
      });
    });
    await post(condor({ entry: 3.0, contracts: 2 }));
    const v = (await body(await h.call("/positions/values")))[0];
    expect(v.cost_to_close).toBe(4.5);
    expect(v.contract_size).toBeNull();
    expect(v.pnl).toBeNull();
  });

  it("reports the share of a credit captured so far, and none for a debit", async () => {
    // what the redesigned page shows beside the P&L (ADR 0023), decided here rather than divided
    // out in the browser (ADR 0005) — and named in the reply schema, which strips what it does not
    start();
    await post(condor({ entry: 9.0 }));
    await post({
      name: "1016_C8050", strike_date: EXPIRY, entry: -6.0,
      legs: [{ side: "long", option_type: "CALL", strike: 8050 }],
    });
    const values = await body(await h.call("/positions/values"));
    const share = Object.fromEntries(
      values.map((v: { name: string; captured: unknown }) => [v.name, v.captured]),
    );
    // sold for 9.00 and 4.50 to close: half of it kept
    expect(share["1016_IC"]).toBe(0.5);
    // bought for 6.00: a debit has no credit to keep a share of, as it has no Target
    expect(share["1016_C8050"]).toBeNull();
  });

  it("reports each leg's own delta, which the position's greeks sum away (#318)", async () => {
    // the short leg's delta is the risk this book is managed by; `greeks` is a signed sum over the
    // legs and is not it. Per leg, keyed by contract, from the same batch as the cost to close
    let short: unknown = -0.31;
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return records.map((r) => String(r.code).endsWith("P7100000") ? { ...r, option_delta: short } : r);
    });
    await post(condor());
    const v = (await body(await h.call("/positions/values")))[0];
    const legs = v.legs_delta as Record<string, number>;
    expect(Object.keys(legs).sort()).toEqual(CONDOR_LEGS.map((l) =>
      buildSpxCode(EXPIRY, l.option_type, l.strike)).sort());
    expect(legs[buildSpxCode(EXPIRY, "PUT", 7100)]).toBe(-0.31);
    expect(legs[buildSpxCode(EXPIRY, "CALL", 8050)]).toBe(0.2);
    // all or nothing, as the sample's map is: a map over three legs of four is not served
    short = null;
    expect((await body(await h.call("/positions/values")))[0].legs_delta).toBeNull();
  });

  it("reports SPX's price from its own batch's premiums, and why not where there are none", async () => {
    // every leg's premium is set so that it inverts to 7000, whatever its side: the figure is the
    // index the holdings were valued against (ADR 0024), on each holding as the contract size is
    let premiums = true;
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return records.map((r) => {
        const c = parseSpxCode(String(r.code))!;
        const premium = c.option_type === "CALL" ? ((c.strike + 10) / 7000 - 1) * 100
          : (1 - (c.strike - 10) / 7000) * 100;
        return premiums ? { ...r, last_price: 10, option_premium: premium } : r;
      });
    });
    await post(condor());
    const v = (await body(await h.call("/positions/values")))[0];
    expect(v.spx).toBe(7000);
    expect(v.spx_reason).toBeNull();
    premiums = false;
    const bare = (await body(await h.call("/positions/values")))[0];
    expect(bare.spx).toBeNull();
    expect(bare.spx_reason).toBe("the Provider gives no option premium to derive it from");
  });

  it("places each short strike against that SPX, in points and σ, and only the strikes without it (#297)", async () => {
    let premiums = true;
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return records.map((r) => {
        const c = parseSpxCode(String(r.code))!;
        const premium = c.option_type === "CALL" ? ((c.strike + 10) / 7000 - 1) * 100
          : (1 - (c.strike - 10) / 7000) * 100;
        const figures = { ...r, option_delta: c.option_type === "CALL" ? 0.2 : -0.25, option_implied_volatility: 20 };
        return premiums ? { ...figures, last_price: 10, option_premium: premium } : figures;
      });
    });
    await post(condor());
    const v = (await body(await h.call("/positions/values")))[0];
    const sigma = (points: number) => Number((points / (7000 * 0.2 * Math.sqrt(Number(v.dte) / 365))).toFixed(2));
    // one σ of SPX to expiry from each short leg's own IV, the price map's band (#298)
    const width = Number((7000 * 0.2 * Math.sqrt(Number(v.dte) / 365)).toFixed(2));
    // the SHORT legs only, in the holding's own order: the call at 8050 and the put at 7100
    expect(v.short_strikes).toEqual([
      { code: buildSpxCode(EXPIRY, "CALL", 8050), option_type: "CALL", strike: 8050, delta: 0.2,
        points: 1050, sigma: sigma(1050), one_sigma: width },
      { code: buildSpxCode(EXPIRY, "PUT", 7100), option_type: "PUT", strike: 7100, delta: -0.25,
        points: -100, sigma: sigma(-100), one_sigma: width },
    ]);
    premiums = false;
    const bare = (await body(await h.call("/positions/values")))[0];
    expect((bare.short_strikes as { points: unknown; sigma: unknown; delta: unknown; one_sigma: unknown }[])
      .map((s) => [s.delta, s.points, s.sigma, s.one_sigma])).toEqual([[0.2, null, null, null], [-0.25, null, null, null]]);
  });

  it("reports nothing rather than something wrong when a leg goes unpriced", async () => {
    // full quotes while creating, since the gate demands every leg exists; one dropped afterwards
    let complete = true;
    start(async (codes) => {
      const { records } = await pricedFetcher(codes);
      return complete ? records : records.slice(0, -1);
    });
    expect((await post(condor())).status).toBe(201);
    complete = false;
    const v = (await body(await h.call("/positions/values")))[0];
    expect(v.cost_to_close).toBeNull();
    expect(v.pnl).toBeNull();
    expect(v.captured).toBeNull();
  });

  it("is an empty list with nothing held, and makes no call", async () => {
    let calls = 0;
    start((codes) => { calls += 1; return pricedFetcher(codes); });
    expect(await body(await h.call("/positions/values"))).toEqual([]);
    expect(calls).toBe(0);
  });

  it("answers 502 rather than 500 when the Provider call fails, and names it", async () => {
    // one sentence for both market-data routes, from the Provider's own name: this read "OpenD
    // call failed" in two places whatever was actually answering (`errors.providerFailed`)
    let first = true;
    start(async (codes) => {
      if (first) { first = false; return pricedFetcher(codes); }
      throw new Error("quota exceeded");
    });
    await post(condor());
    // in the session, where the batch is the price (#387: out of it, see below)
    h.now = new Date("2026-10-01T15:00:00Z"); // Thursday 11:00 New York
    const resp = await h.call("/positions/values");
    expect(resp.status).toBe(502);
    const detail = (await body(resp)).detail as string;
    expect(detail).toBe("moomoo call failed: quota exceeded");
    expect(detail).not.toMatch(/OpenD/);
  });

  it("out of the session dashes a holding the failed call would have priced, with the 502's words (#387)", async () => {
    let first = true;
    start(async (codes) => {
      if (first) { first = false; return pricedFetcher(codes); }
      throw new Error("quota exceeded");
    });
    await post(condor());
    // 01:26 New York on a Friday: out of the session, and the holding has no close to be valued from
    const resp = await h.call("/positions/values");
    expect(resp.status).toBe(200);
    const [v] = await body(resp);
    expect(v).toMatchObject({
      cost_to_close: null, pnl: null, fetched_at: null, valued_from: "live",
      valued_reason: "moomoo call failed: quota exceeded",
    });
  });
});

describe("recording a credit after the fact", () => {
  it("fills in an entry that was unknown at creation", async () => {
    start();
    const id = (await body(await post(condor({ entry: null })))).id;
    expect((await body(await h.call("/positions/values")))[0].pnl).toBeNull();

    const patched = await patch(id, { entry: 3.0 });
    expect(patched.status).toBe(200);
    expect((await body(patched)).entry).toBe(3.0);
    // cost to close is 4.5, so sold at 3.00 is down 1.50 a contract
    expect((await body(await h.call("/positions/values")))[0].pnl).toBe(-150.0);
  });

  it("refuses an empty patch rather than reporting a change it did not make", async () => {
    start();
    const id = (await body(await post(condor()))).id;
    const resp = await patch(id, {});
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("nothing to update");
  });

  it("never edits the legs into another structure — a different structure is a different holding", async () => {
    start();
    const id = (await body(await post(condor()))).id;
    const refused = await patch(id, { legs: [CONDOR_LEGS[0]], contracts: 3 });
    expect(refused.status).toBe(422);
    expect((await body(refused)).detail).toMatch(/a different structure is a different holding$/);
    const [listed] = await body(await h.call("/positions"));
    expect([listed.legs.length, listed.contracts], "and nothing was written").toEqual([4, 1]);
  });
});

describe("a monitor finding the position that holds it", () => {
  it("links a leg rule to the position holding that contract", async () => {
    // creating a monitor linked it to nothing, so everything the Position work built — entry, P&L,
    // the derived total — silently applied only to monitors predating the backfill migration
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);
  });

  it("calls it the whole position when the rule covers it exactly", async () => {
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({
      name: "1016_bs", strike_date: "2026-10-16", field: "mid_price", threshold: 9,
      legs: [
        { sign: 1, option_type: "CALL", strike: 8050 },
        { sign: -1, option_type: "CALL", strike: 8075 },
      ],
    });
    expect(links(mid)).toEqual([[pid], "all"]);
  });

  it("spans both spreads of a condor, which is not ambiguity", async () => {
    // a combined stop over two credit spreads belongs to neither alone (ADR 0004)
    start();
    const calls = await makePosition("calls", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const puts = await makePosition("puts", "2026-10-16", [
      { side: "short", option_type: "PUT", strike: 7100 },
      { side: "long", option_type: "PUT", strike: 7075 },
    ]);
    const mid = await makeMonitor({
      name: "condor_stop", strike_date: "2026-10-16", field: "mid_price", threshold: 9,
      legs: [
        { sign: 1, option_type: "CALL", strike: 8050 },
        { sign: -1, option_type: "CALL", strike: 8075 },
        { sign: 1, option_type: "PUT", strike: 7100 },
        { sign: -1, option_type: "PUT", strike: 7075 },
      ],
    });
    const [ids, scope] = links(mid);
    expect(ids.sort()).toEqual([calls, puts].sort());
    expect(scope).toBe("all");
  });

  it("links nothing for a strike nothing holds", async () => {
    // watching a strike you have no position in is legitimate; it has no entry and no P&L
    start();
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[], null]);
  });

  it("links nothing for a contract two positions hold", async () => {
    start();
    await makePosition("old_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("new_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[], null]);
  });
});

describe("a position adopting the monitors already watching it", () => {
  it("works in the order monitor-then-position, not only position-then-monitor", async () => {
    // the link used to be worked out only when a monitor was created, so setting the alarm before
    // recording the holding left it orphaned for ever, with no entry and no P&L
    start();
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[], null]);

    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    expect(links(mid)).toEqual([[pid], "leg"]);
  });

  it("never takes a link away", async () => {
    // why this is not "recompute the links every sweep". Rolling a spread leaves the old and the new
    // sharing a strike for a day; a recomputing job would call that contract ambiguous and silently
    // unlink a monitor that had worked for weeks — the entry and P&L vanishing mid-session with
    // nothing to explain it.
    start();
    const first = await makePosition("old_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[first], "leg"]);

    await makePosition("new_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    expect(links(mid)).toEqual([[first], "leg"]);
  });

  it("does not resolve an ambiguity it cannot resolve", async () => {
    // an orphan created while two positions already share its strike stays an orphan, and a later
    // position does not talk adoption into guessing
    start();
    await makePosition("old_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("new_roll", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[], null]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "short", option_type: "CALL", strike: 9000 },
    ]);
    expect(links(mid)).toEqual([[], null]);
  });
});

describe("deleting a holding", () => {
  it("takes its links with it and leaves the rules alone", async () => {
    // the same foreign-key fault #70 fixed on the monitor side. Every Position in the live database
    // is linked, so deleting one was broken for all of them (#71).
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);

    expect((await h.call(`/positions/${pid}`, { method: "DELETE" })).status).toBe(204);
    // the rule survives: nothing here deletes one as a side effect. It simply stops knowing what it
    // was watching — links AND scope, since a scope says how it covers a holding it no longer has —
    // and would be adopted again if the holding came back.
    expect(h.db.prepare("select id from monitors where id = ?").get(mid)).toBeTruthy();
    expect(links(mid), "no links, and no scope claiming one").toEqual([[], null]);
  });

  it("re-adopts the rule if the holding comes back", async () => {
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    await h.call(`/positions/${pid}`, { method: "DELETE" });
    expect(links(mid)[0]).toEqual([]);

    const again = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    expect(links(mid)).toEqual([[again], "leg"]);
  });
});

describe("gaps the single-position tests cannot show", () => {
  it("lists by expiry, then by name", async () => {
    start();
    await makePosition("zulu", "2026-10-16", [CONDOR_LEGS[0]]);
    await makePosition("alpha", "2026-11-20", [CONDOR_LEGS[1]]);
    await makePosition("mike", "2026-10-16", [CONDOR_LEGS[2]]);
    expect((await body(await h.call("/positions"))).map((p: { name: string }) => p.name))
      .toEqual(["mike", "zulu", "alpha"]);
  });

  it("asks for a shared contract once, not once per position holding it", async () => {
    // two positions can hold the same strike — a vertical and a condor wing, or a roll in progress.
    // Without deduping, the batch sends it twice and the whole point of one call per sweep is lost.
    const asked: string[][] = [];
    start((codes) => { asked.push(codes); return pricedFetcher(codes); });
    await makePosition("a", EXPIRY, [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("b", EXPIRY, [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    asked.length = 0;
    await h.call("/positions/values");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual([...new Set(asked[0])]);
    expect(asked[0]).toHaveLength(3); // 8050 once, plus 8075 and 8100
  });

  it("leaves an already-linked monitor alone when an unrelated holding arrives", async () => {
    // adoption looks ONLY at monitors with no link. Were it to reconsider every monitor, this
    // position would make it re-derive a link it already has — and writing the same link twice is a
    // primary-key violation, so the unrelated creation would fail outright.
    start();
    const pid = await makePosition("held", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);

    const other = await post({
      name: "elsewhere", strike_date: "2026-11-20",
      legs: [{ side: "short", option_type: "CALL", strike: 9000 }],
    });
    expect(other.status).toBe(201);
    expect(links(mid)).toEqual([[pid], "leg"]);
  });

  it("ADOPTION never clears a scope — the delete does, and nothing else", async () => {
    // This asserted the opposite until 2026-10-15, and the reason it gave was narrower than the
    // behaviour it pinned: "adoption that cleared it would be taking something away, which is the
    // one thing it must never do". That constraint is on ADOPTION, and it still holds — the
    // clearing lives in clearScopeOfOrphans, called from the delete route after adoption has had
    // its turn. Keeping the scope after the holding went was what fell out, not what was chosen,
    // and it left the live US.SPXW261120C8200000 reading scope "leg" while holding nothing.
    //
    // Both halves are here: the delete clears, and a LATER unrelated holding appearing does not
    // touch the monitor at all, which is the original concern made explicit.
    start();
    const pid = await makePosition("held", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    await h.call(`/positions/${pid}`, { method: "DELETE" });
    expect(links(mid), "the delete clears it").toEqual([[], null]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "short", option_type: "CALL", strike: 9000 },
    ]);
    expect(links(mid), "and adoption leaves it exactly as it was").toEqual([[], null]);
  });

  it("adoption leaves a scope it cannot place ALONE, rather than clearing it", async () => {
    // the original concern, as its own test: a monitor whose holding is still there keeps its
    // scope when an unrelated holding is created, and POST /positions must never reach for it.
    // Set up by hand, because the only route that clears a scope is the delete.
    start();
    const pid = await makePosition("held", "2026-10-16", [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "short", option_type: "CALL", strike: 9000 },
    ]);
    expect(links(mid), "untouched by someone else's holding").toEqual([[pid], "leg"]);
  });
});

describe("the exit schedule", () => {
  /** ADR 0011. The schedule is a REFERENCE: no alarm is raised from it, and `opened_at` is the
   *  opt-in because nothing is inferred from `created_at`, which is the day a Position was
   *  RECORDED rather than put on.
   *
   *  Its own expiry, not the suite's: the harness clock is 2026-10-02, and a 45-DTE-at-open
   *  scenario against the suite's December expiry would put the Opened in the FUTURE — which the
   *  guard correctly reports as unknown, and which is how the first version of these passed
   *  every assertion except the one that looked at the pace.
   */
  const SCHED_EXPIRY = "2026-10-30";   // 28 DTE at the harness clock
  const OPENED = "2026-09-15";         // 45 DTE at open
  const spread = (over: Record<string, unknown> = {}) => ({
    name: "1030_IC", strategy: "iron_condor", strike_date: SCHED_EXPIRY, contracts: 1,
    entry: 6.86, legs: CONDOR_LEGS, ...over,
  });
  const values = async () => {
    const data = await body(await h.call("/positions/values"));
    return data as unknown as {
      name: string; dte: number; opened_at: string | null; cost_to_close: number;
      schedule: Record<string, number | null> | null;
    }[];
  };

  it("is null for a Position whose Opened nobody declared", async () => {
    start();
    await created201(await post(spread()));
    const [p] = await values();
    expect(p!.opened_at).toBeNull();
    expect(p!.schedule, "nothing is inferred from created_at").toBeNull();
    expect(p!.dte, "the DTE is still reported, schedule or not").toBe(28);
  });

  it("is computed once an Opened is declared on creation", async () => {
    start();
    await created201(await post(spread({ opened_at: OPENED })));
    const [p] = await values();
    const s = p!.schedule!;

    expect(p!.opened_at).toBe(OPENED);
    expect(s.dte_at_open).toBe(45);
    expect(s.target).toBeCloseTo(3.43, 2);
    expect(s.stop).toBeCloseTo(13.72, 2);
    // a 50% Target is not reached by decay ALONE until ~11 DTE, which is the headline finding:
    // hitting it at 21 came from an IV drop or a move, not from waiting
    expect(s.target_dte).toBe(11);
    expect(s.manage_by_dte).toBe(21);
    // 6.86 × √(28/45)
    expect(s.on_pace).toBeCloseTo(6.86 * Math.sqrt(28 / 45), 6);
  });

  it("carries whether a Level is reached, which the schema would otherwise strip", async () => {
    // The hazard is not the arithmetic — exit.test.ts has that — it is zod. `ScheduleOut.parse`
    // DROPS keys it does not name, silently, with the compiler happy and the suite green, so a
    // field computed in the domain and never listed here reaches the dashboard as undefined.
    start();
    await created201(await post(spread({ opened_at: OPENED })));
    const [p] = await values();
    const s = p!.schedule!;

    // 28 DTE against a 21-DTE deadline, and no cost to close in this fixture
    expect(s.reached, "nothing to compare, so nothing reached").toBeNull();
    expect(s.manage_by_due, "28 DTE is a week outside the deadline").toBe(false);
    expect("reached" in s, "the key survives the schema").toBe(true);
    expect("manage_by_due" in s).toBe(true);
  });

  it("can be declared after the fact, which is the only way the existing five get one", async () => {
    start();
    const id = await created201(await post(spread()));
    expect((await values())[0]!.schedule).toBeNull();

    const resp = await patch(id, { opened_at: OPENED });
    expect(resp.status).toBe(200);
    expect((await values())[0]!.schedule!.dte_at_open).toBe(45);
  });

  it("accepts either spelling of the date, as every other date here does", async () => {
    start();
    await created201(await post(spread({ opened_at: "20260915" })));
    expect((await values())[0]!.opened_at).toBe(OPENED);
  });

  it("reports the gap to pace against the live Cost to close", async () => {
    start();
    await created201(await post(spread({ opened_at: OPENED })));
    const [p] = await values();
    const s = p!.schedule!;
    expect(s.on_pace).not.toBeNull();
    // behind is positive: costing MORE than it should is the direction that hurts
    expect(s.pace_gap!).toBeCloseTo(p!.cost_to_close - s.on_pace!, 6);
  });

  it("says unknown rather than a number when the Opened is in the future", async () => {
    // a DTE further out than the Opened one means the Opened is wrong, and a wrong Opened must
    // read as unknown rather than as a pace above Entry
    start();
    await created201(await post(spread({ opened_at: "2026-10-20" })));
    const s = (await values())[0]!.schedule!;
    expect(s.dte_at_open).toBe(10);
    expect(s.on_pace, "28 DTE today against 10 at open is not arithmetic, it is bad data")
      .toBeNull();
    expect(s.pace_gap).toBeNull();
  });

  it("refuses an Opened that is not a date", async () => {
    start();
    const resp = await post(spread({ opened_at: "last tuesday" }));
    expect(resp.status).toBe(422);
  });
});

describe("deleting a Position that has been sampled", () => {
  /** The third time this foreign key has bitten. monitor_positions did it in #71, the sweep's
   *  expiry path did it in #81, and `position_samples` did it the moment ADR 0011 added a child
   *  table without touching the delete path — which made DELETE refuse for EVERY Position, since
   *  the first sweep after that deploy gave all five a sample.
   *
   *  The samples go with the holding, unlike the Monitors: a Monitor survives and simply stops
   *  knowing what it watched, while a series of what-this-was-worth means nothing without it.
   */
  const sample = (positionId: string, on: string) =>
    h.db.prepare(
      `insert into position_samples (position_id, observed_on, dte, cost_to_close)
       values (?, ?, 30, 4.0)`,
    ).run(positionId, on);

  it("deletes it, and its samples with it", async () => {
    start();
    const id = await created201(await post(condor()));
    sample(id, "2026-10-11");
    sample(id, "2026-10-12");
    expect(h.db.prepare("select count(*) n from position_samples").get()).toEqual({ n: 2 });

    const resp = await h.call(`/positions/${id}`, { method: "DELETE" });
    expect(resp.status, await resp.text()).toBe(204);
    expect(h.db.prepare("select count(*) n from positions").get()).toEqual({ n: 0 });
    expect(h.db.prepare("select count(*) n from position_samples").get()).toEqual({ n: 0 });
  });

  it("leaves another Position's samples alone", async () => {
    start();
    const keep = await created201(await post(condor({ name: "keep" })));
    const drop = await created201(await post(condor({ name: "drop" })));
    sample(keep, "2026-10-12");
    sample(drop, "2026-10-12");

    expect((await h.call(`/positions/${drop}`, { method: "DELETE" })).status).toBe(204);
    const rows = h.db.prepare("select position_id from position_samples").all() as
      { position_id: string }[];
    expect(rows.map((r) => r.position_id)).toEqual([keep]);
  });

  it("still deletes one that has no samples at all", async () => {
    start();
    const id = await created201(await post(condor()));
    expect((await h.call(`/positions/${id}`, { method: "DELETE" })).status).toBe(204);
  });
});

describe("closing a holding keeps it (ADR 0022)", () => {
  // the harness's clock is 2026-10-02T05:26Z, which is still 2026-10-02 in New York
  const close = (id: string, payload: unknown = {}) =>
    h.call(`/positions/${id}/close`, json(payload));
  const monitorRow = (id: string) =>
    h.db.prepare("select enabled, disabled_reason from monitors where id = ?").get(id) as
      { enabled: number; disabled_reason: string | null } | undefined;
  const addSample = (positionId: string, observedOn: string) =>
    h.db.prepare(
      "insert into position_samples (position_id, observed_on, dte, cost_to_close) values (?, ?, 30, 2.5)",
    ).run(positionId, observedOn);
  const sampleCount = (positionId: string) =>
    (h.db.prepare("select count(*) as n from position_samples where position_id = ?")
      .get(positionId) as { n: number }).n;
  const legCode = buildSpxCode(EXPIRY, "CALL", 8050);

  it("records the day and the exit, and keeps the legs, the entry and the samples", async () => {
    start();
    const pid = await created201(await post(condor({ contracts: 2 })));
    addSample(pid, "2026-10-01");

    const resp = await close(pid, { exit: 0.4 });
    const data = await body(resp);
    expect(resp.status, JSON.stringify(data)).toBe(200);
    expect(data).toMatchObject({
      id: pid, closed_on: "2026-10-02", exit: 0.4, entry: 3.0, legs: CONDOR_LEGS,
      // Entry less Exit across the contracts held, in points: P&L is money and needs a quote
      realized_points: 5.2,
      disabled_monitors: [],
    });
    expect(sampleCount(pid), "the history survives the close").toBe(1);
  });

  it("closes without an exit, and then says nothing about what it made", async () => {
    start();
    const pid = await created201(await post(condor()));
    const data = await body(await close(pid));
    expect(data).toMatchObject({ closed_on: "2026-10-02", exit: null, realized_points: null });
  });

  it("takes the day it was closed when it is given, the way Opened is", async () => {
    start();
    const pid = await created201(await post(condor({ opened_at: "2026-09-01" })));
    const data = await body(await close(pid, { exit: 0.4, closed_on: "20260930" }));
    expect(data.closed_on).toBe("2026-09-30");
  });

  it("defaults to the expiry for a holding closed after it, since nothing is held past one", async () => {
    // an iron condor that expired worthless on 09-25 and was only told to the app today
    start();
    const pid = await created201(await post(condor({ strike_date: "2026-09-25" })));
    const data = await body(await close(pid, { exit: 0 }));
    expect(data).toMatchObject({ closed_on: "2026-09-25", exit: 0, realized_points: 3 });
  });

  it("refuses a day before it was opened, and a day after its expiry", async () => {
    start();
    const pid = await created201(await post(condor({ opened_at: "2026-09-01" })));
    const early = await close(pid, { closed_on: "2026-08-31" });
    expect(early.status).toBe(422);
    expect((await body(early)).detail).toMatch(/before it was opened/);
    const late = await close(pid, { closed_on: "2026-12-19" });
    expect(late.status).toBe(422);
    expect((await body(late)).detail).toMatch(/after its expiry/);
    const [listed] = await body(await h.call("/positions"));
    expect(listed.closed_on, "and nothing was written").toBeNull();
  });

  it("refuses an impossible date and an exit that is not a number", async () => {
    start();
    const pid = await created201(await post(condor()));
    expect((await close(pid, { closed_on: "2026-13-01" })).status).toBe(422);
    expect((await close(pid, { exit: "0.40" })).status).toBe(422);
  });

  it("is 409 for a holding already closed, and keeps what the first close said", async () => {
    start();
    const pid = await created201(await post(condor()));
    await close(pid, { exit: 0.4 });
    const again = await close(pid, { exit: 9 });
    expect(again.status).toBe(409);
    expect((await body(again)).detail).toBe("position '1016_IC' is already closed");
    const [listed] = await body(await h.call("/positions"));
    expect(listed.exit).toBe(0.4);
  });

  it("is a 404 for a holding that was never there", async () => {
    start();
    expect((await close("nope", { exit: 0.4 })).status).toBe(404);
  });

  it("disables the rules watching it, says which, and keeps them", async () => {
    start();
    const pid = await created201(await post(condor()));
    const leg = await makeMonitor({ strike_date: EXPIRY, option_type: "CALL", strike: 8050 });
    const data = await body(await close(pid, { exit: 0.4 }));
    expect(data.disabled_monitors).toEqual([{ id: leg, code: legCode }]);
    expect(monitorRow(leg)).toEqual({ enabled: 0, disabled_reason: "holding-closed" });
    // ...and it stops claiming the holding, so nothing alive is ever valued against a closed one
    expect(links(leg)).toEqual([[], null]);
  });

  it("leaves a rule already off as the owner left it, and does not claim to have disabled it", async () => {
    start();
    const pid = await created201(await post(condor()));
    const leg = await makeMonitor({ strike_date: EXPIRY, option_type: "CALL", strike: 8050 });
    await h.call(`/monitors/${leg}`, { ...json({ enabled: false }), method: "PATCH" });
    const data = await body(await close(pid, { exit: 0.4 }));
    expect(data.disabled_monitors).toEqual([]);
    expect(monitorRow(leg)).toEqual({ enabled: 0, disabled_reason: "manual" });
  });

  it("disables a rule spanning two holdings when EITHER closes, since it would value legs no longer held", async () => {
    start();
    const calls = await makePosition("1016_bs_8050", EXPIRY, CONDOR_LEGS.slice(0, 2));
    const puts = await makePosition("1016_bp_7100", EXPIRY, CONDOR_LEGS.slice(2));
    const both = await created201(await h.call("/monitors", json({
      name: "1016_IC", strike_date: EXPIRY, field: "option_delta", threshold: 0.2,
      direction: "above",
      legs: [
        { sign: -1, option_type: "CALL", strike: 8050 },
        { sign: -1, option_type: "PUT", strike: 7100 },
      ],
    })));
    expect(links(both)[0]).toEqual([calls, puts].sort());

    await close(puts, { exit: 0.1 });
    expect(monitorRow(both)).toEqual({ enabled: 0, disabled_reason: "holding-closed" });
    // the link to the holding still held is kept, as deleting the other spread would keep it
    expect(links(both)[0]).toEqual([calls]);
  });

  it("is listed with what it made, and left out of everything live", async () => {
    let calls = 0;
    start((codes) => { calls += 1; return pricedFetcher(codes); });
    const pid = await created201(await post(condor()));
    await close(pid, { exit: 0.4 });

    expect(await body(await h.call("/positions"))).toMatchObject([
      { id: pid, closed_on: "2026-10-02", exit: 0.4, realized_points: 2.6 },
    ]);
    calls = 0;
    expect(await body(await h.call("/positions/values")), "nothing open is valued").toEqual([]);
    expect(calls, "and the Provider is asked nothing").toBe(0);
  });

  it("never adopts a new rule onto a closed holding", async () => {
    start();
    const pid = await created201(await post(condor()));
    await close(pid, { exit: 0.4 });
    const leg = await makeMonitor({ strike_date: EXPIRY, option_type: "CALL", strike: 8050 });
    expect(links(leg)).toEqual([[], null]);
  });

  it("lets the same contracts be held again, and the new holding adopts the rules", async () => {
    start();
    const first = await created201(await post(condor()));
    await close(first, { exit: 0.4 });
    const leg = await makeMonitor({ strike_date: EXPIRY, option_type: "CALL", strike: 8050 });
    const again = await created201(await post(condor({ name: "1016_IC_again" })));
    expect(links(leg)).toEqual([[again], "leg"]);
  });

  it("can still be deleted, for a holding recorded by mistake, and its samples go with it", async () => {
    start();
    const pid = await created201(await post(condor()));
    addSample(pid, "2026-10-01");
    await close(pid, { exit: 0.4 });
    expect((await h.call(`/positions/${pid}`, { method: "DELETE" })).status).toBe(204);
    expect(sampleCount(pid)).toBe(0);
  });

  it("hands a rule to the holding that still holds its contract, and leaves it ON (a roll)", async () => {
    // Found in review: the close disabled the rule, unlinked it, and adoption then linked it to
    // the rolled holding — leaving the new trade's alarm OFF, as "holding-closed", with no notice.
    // A rule is switched off only when something it names is no longer held by anything open.
    start();
    const old = await created201(await post(condor()));
    const leg = await makeMonitor({ strike_date: EXPIRY, option_type: "CALL", strike: 8050 });
    // the roll: a new call spread sharing the short strike, recorded before the old one is closed
    const rolled = await makePosition("1016_bs_8050_rolled", EXPIRY, [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8100 },
    ]);
    expect(links(leg)[0], "linked to the old holding until it closes").toEqual([old]);

    const data = await body(await close(old, { exit: 0.4 }));
    expect(data.disabled_monitors).toEqual([]);
    expect(monitorRow(leg)).toEqual({ enabled: 1, disabled_reason: null });
    expect(links(leg)).toEqual([[rolled], "leg"]);
  });

  it("closes on the New York market day, not the UTC one", async () => {
    // 02:00 UTC on the 10th is 21:00 on the 9th in New York: every clock the suite used fell on
    // the same date in both, which is how a UTC date passed for a market one
    start();
    h.now = new Date("2026-11-10T02:00:00Z");
    const pid = await created201(await post(condor()));
    expect((await body(await close(pid, { exit: 0.4 }))).closed_on).toBe("2026-11-09");
  });

  it("refuses a day that has not come yet in New York", async () => {
    start();
    h.now = new Date("2026-11-10T02:00:00Z");
    const pid = await created201(await post(condor()));
    const early = await close(pid, { closed_on: "2026-11-10" });
    expect(early.status).toBe(422);
    expect((await body(early)).detail).toMatch(/after today/);
  });

  it("reads no sample after the day it closed, and deletes none, when the close is backdated", async () => {
    // the sweep sampled it on the 7th and 8th, then the owner recorded that it closed on the 6th:
    // what it was worth after it was sold is not its history, but nothing is thrown away either
    start();
    const pid = await created201(await post(condor({ opened_at: "2026-09-01" })));
    const codes = CONDOR_LEGS.map((l) => buildSpxCode(EXPIRY, l.option_type as "CALL" | "PUT", l.strike));
    const ivs = (v: number) => JSON.stringify(Object.fromEntries(codes.map((c) => [c, v])));
    for (const [on, dte, iv] of [["2026-09-01", 45, 10], ["2026-09-02", 44, 11], ["2026-09-03", 43, 15]] as const) {
      h.db.prepare(
        `insert into position_samples (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
         values (?, ?, ?, 3.0, ?, ?)`,
      ).run(pid, on, dte, ivs(iv), ivs(4));
    }
    await close(pid, { exit: 0.4, closed_on: "2026-09-02" });
    const vol = await body(await h.call(`/positions/${pid}/vol`));
    expect(vol.to, "measured to the close, not past it").toBe("2026-09-02");
    expect(sampleCount(pid), "and every sample is still stored").toBe(3);
  });

  it("corrects the exit and the day after the close, which a mistyped close needs", async () => {
    start();
    const pid = await created201(await post(condor({ opened_at: "2026-09-01" })));
    addSample(pid, "2026-09-02");
    await close(pid, { exit: 0.4 });
    const resp = await patch(pid, { exit: 0.45, closed_on: "2026-09-30" });
    expect(resp.status).toBe(200);
    expect(await body(resp)).toMatchObject({ exit: 0.45, closed_on: "2026-09-30", realized_points: 2.55 });
    expect(sampleCount(pid), "without losing the history a delete would").toBe(1);
  });

  it("clears an exit back to blank, as a close may leave it, and says nothing about what it made", async () => {
    start();
    const pid = await created201(await post(condor()));
    await close(pid, { exit: 0.4 });
    const resp = await patch(pid, { exit: null });
    expect(resp.status).toBe(200);
    expect(await body(resp)).toMatchObject({ exit: null, realized_points: null, closed_on: "2026-10-02" });
  });

  it("refuses an exit or a close day on a holding still held", async () => {
    start();
    const pid = await created201(await post(condor()));
    const resp = await patch(pid, { exit: 0.4 });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("position '1016_IC' is not closed: close it first");
    expect((await patch(pid, { closed_on: "2026-10-01" })).status).toBe(422);
  });

  it("holds a corrected day to the same three bounds as the close", async () => {
    start();
    const pid = await created201(await post(condor({ opened_at: "2026-09-01" })));
    await close(pid, { exit: 0.4 });
    expect((await body(await patch(pid, { closed_on: "2026-08-31" }))).detail).toMatch(/before it was opened/);
    expect((await body(await patch(pid, { closed_on: "2026-10-03" }))).detail).toMatch(/after today/);
    const [listed] = await body(await h.call("/positions"));
    expect(listed.closed_on, "and nothing was written").toBe("2026-10-02");
  });
});

describe("a quantity per leg (#351)", () => {
  const RATIO = [
    { side: "long", option_type: "PUT", strike: 7100 }, { side: "short", option_type: "PUT", strike: 7075, qty: 2 },
  ];

  it("records a leg's quantity, and a quantity of one as none", async () => {
    start();
    await created201(await post(condor({ name: "ratio", legs: RATIO })));
    await created201(await post(condor({ name: "ones", legs: RATIO.map((l) => ({ ...l, qty: 1 })) })));
    const stored = (name: string) =>
      JSON.parse((h.db.prepare("select legs from positions where name = ?").get(name) as { legs: string }).legs);
    expect(stored("ratio")).toEqual(RATIO);
    expect(stored("ones")).toEqual(RATIO.map(({ side, option_type, strike }) => ({ side, option_type, strike })));
  });

  it("draws a holding's payoff with its quantities", async () => {
    start();
    const id = await created201(await post(condor({ name: "ratio", legs: RATIO, entry: 0.5, contracts: 1 })));
    const payoff = await body(await h.call(`/positions/${id}/payoff`));
    // below the short strike two puts are owed against one held
    expect(payoff.slope_below).toBe(1);
    expect(payoff.at_strikes).toEqual([{ spx: 7075, pnl: 25.5 }, { spx: 7100, pnl: 0.5 }]);
  });
});

describe("correcting a held leg's quantity (#359)", () => {
  /** a 1×3 typed where a 1×2 was meant: one P7100 bought, the P7075 sold three times over */
  const TYPED = [
    { side: "long", option_type: "PUT", strike: 7100 }, { side: "short", option_type: "PUT", strike: 7075, qty: 3 },
  ];
  const MEANT = [
    { side: "long", option_type: "PUT", strike: 7100 }, { side: "short", option_type: "PUT", strike: 7075, qty: 2 },
  ];
  const SHORT = buildSpxCode(EXPIRY, "PUT", 7075);

  /** the holding recorded through the add form's route, with its value rule and its short leg's Δ */
  const held = async (legs: unknown[] = TYPED) => {
    const resp = await h.call("/spreads", json({ strike_date: EXPIRY, spreads: [{
      name: "ratio", legs, held: true, entry: 0.5, opened_at: "2026-10-01",
      monitors: [{ threshold: 1.0 }, { option_type: "PUT", strike: 7075, threshold: 0.3 }],
    }] }));
    expect(resp.status, JSON.stringify(await body(resp.clone()))).toBe(201);
    return (h.db.prepare("select id from positions where name = 'ratio'").get() as { id: string }).id;
  };
  const rule = (code: string) => h.db.prepare(
    "select id, legs, scope, triggered, last_alarm_at from monitors where code = ?",
  ).get(code) as { id: string; legs: string | null; scope: string | null; triggered: number; last_alarm_at: string | null };
  const stored = (id: string) => h.db.prepare("select legs, qty_corrected_at, entry from positions where id = ?")
    .get(id) as { legs: string; qty_corrected_at: string | null; entry: number };
  const ringing = (code: string) => h.db.prepare(
    "update monitors set triggered = 1, last_alarm_at = '2026-10-01 15:00:00.000000' where code = ?",
  ).run(code);
  const sampleOn = (id: string, on: string, dte: number, at: string | null, cost = 1.5) => h.db.prepare(
    `insert into position_samples (position_id, observed_on, dte, cost_to_close, observed_at)
     values (?, ?, ?, ?, ?)`,
  ).run(id, on, dte, cost, at);
  const refused = async (id: string, payload: unknown) => {
    const resp = await patch(id, payload);
    const data = await body(resp);
    expect(resp.status, JSON.stringify(data)).toBe(422);
    return data.detail as string;
  };

  it("corrects a 1×3 to a 1×2, keeping every sample and stamping when", async () => {
    start();
    const id = await held();
    sampleOn(id, "2026-10-01", 78, "2026-10-01 19:59:00.000000", 1.4);
    const resp = await patch(id, { legs: MEANT });
    const data = await body(resp);
    expect(resp.status, JSON.stringify(data)).toBe(200);
    expect(data.legs).toEqual(MEANT);
    expect(JSON.parse(stored(id).legs)).toEqual(MEANT);
    expect(stored(id).qty_corrected_at).toBe("2026-10-02 05:26:06.299000");
    // kept as it was: summed under the 1×3, and nothing stored can re-sum it
    expect(h.db.prepare("select observed_on, cost_to_close from position_samples where position_id = ?").all(id))
      .toEqual([{ observed_on: "2026-10-01", cost_to_close: 1.4 }]);
  });

  it("takes the legs in any order, and keeps them in the order they were recorded", async () => {
    start();
    const id = await held();
    expect((await patch(id, { legs: [...MEANT].reverse() })).status).toBe(200);
    expect(JSON.parse(stored(id).legs)).toEqual(MEANT);
  });

  it("stores a corrected quantity of one as none", async () => {
    start();
    const id = await held();
    expect((await patch(id, { legs: [TYPED[0], { ...TYPED[1], qty: 1 }] })).status).toBe(200);
    expect(JSON.parse(stored(id).legs)).toEqual([
      { side: "long", option_type: "PUT", strike: 7100 }, { side: "short", option_type: "PUT", strike: 7075 },
    ]);
  });

  it("takes its value rule with it, as a new rule: same name, the new quantities, unrung", async () => {
    start();
    const id = await held();
    ringing("ratio");
    ringing(SHORT);
    const answer = await body(await patch(id, { legs: MEANT }));
    const value = rule("ratio");
    // what happened, said by the service: the page words its account from this (#359's review)
    expect([answer.followed_monitors, answer.rescoped_monitors]).toEqual([[{ id: value.id, code: "ratio" }], []]);
    expect(JSON.parse(value.legs!)).toEqual([
      { sign: 1, option_type: "PUT", strike: 7100 }, { sign: -1, option_type: "PUT", strike: 7075, qty: 2 },
    ]);
    expect([value.scope, value.triggered, value.last_alarm_at]).toEqual(["all", 0, null]);
    // the short leg's Δ is one contract's whatever the quantity: nothing about it changed
    const delta = rule(SHORT);
    expect([delta.legs, delta.scope, delta.triggered, delta.last_alarm_at])
      .toEqual([null, "leg", 1, "2026-10-01 15:00:00.000000"]);
    expect(links(value.id)).toEqual([[id], "all"]);
  });

  it("gives a rule that watched other quantities the scope it now has", async () => {
    // a 1×1 watch rule on the same two contracts was `leg` of the 1×3; corrected to a 1×1, the
    // holding IS what it values. It is not re-quantified: it never valued the holding's structure
    start();
    const id = await held();
    const watch = await makeMonitor({
      name: "w11", strike_date: EXPIRY, field: "mid_price", threshold: 9,
      legs: [{ sign: 1, option_type: "PUT", strike: 7100 }, { sign: -1, option_type: "PUT", strike: 7075 }],
    });
    expect(links(watch)).toEqual([[id], "leg"]);
    ringing("w11");
    const answer = await body(await patch(id, { legs: [TYPED[0], { ...TYPED[1], qty: 1 }] }));
    expect(answer.rescoped_monitors).toEqual([{ id: watch, code: "w11", scope: "all" }]);
    expect(answer.followed_monitors.map((m: { code: string }) => m.code)).toEqual(["ratio"]);
    expect(links(watch)).toEqual([[id], "all"]);
    expect(JSON.parse(rule("w11").legs!)).toEqual([
      { sign: 1, option_type: "PUT", strike: 7100 }, { sign: -1, option_type: "PUT", strike: 7075 },
    ]);
    expect(rule("w11").triggered, "its figure means what it meant").toBe(1);
    // and the holding's own rule, which followed, is still all of it
    expect(links(rule("ratio").id)).toEqual([[id], "all"]);
  });

  it("takes a rule spanning two holdings with it, in the wing that was corrected", async () => {
    start();
    const calls = await makePosition("calls", EXPIRY, CONDOR_LEGS.slice(0, 2));
    const puts = await makePosition("puts", EXPIRY, CONDOR_LEGS.slice(2));
    const condorRule = await makeMonitor({
      name: "ic", strike_date: EXPIRY, field: "mid_price", threshold: 9,
      legs: CONDOR_LEGS.map((l) => ({ sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike })),
    });
    expect(links(condorRule)).toEqual([[calls, puts].sort(), "all"]);
    const resp = await patch(puts, { legs: [{ ...CONDOR_LEGS[2], qty: 2 }, CONDOR_LEGS[3]] });
    expect(resp.status, JSON.stringify(await body(resp.clone()))).toBe(200);
    expect(JSON.parse(rule("ic").legs!).map((l: { qty?: number }) => l.qty ?? 1)).toEqual([1, 1, 2, 1]);
    expect(links(condorRule)).toEqual([[calls, puts].sort(), "all"]);
  });

  it("leaves the legs of a rule that names a contract twice, and gives it the scope it now has", async () => {
    // a 1×3 written before #351 as three legs on one contract: no one leg can carry the quantity
    start();
    const id = await held();
    const legs = [{ sign: 1, option_type: "PUT", strike: 7100 }, ...Array(3).fill({ sign: -1, option_type: "PUT", strike: 7075 })];
    h.db.prepare(
      `insert into monitors (id, code, strike_date, option_type, strike, field, threshold, direction,
         compare, legs, scope, enabled, triggered, created_at)
       values ('old', 'old13', ?, 'CMB', 0, 'mid_price', 9, 'above', 'abs', ?, 'all', 1, 1, '2026-10-01 00:00:00.000000')`,
    ).run(EXPIRY, JSON.stringify(legs));
    h.db.prepare("insert into monitor_positions (monitor_id, position_id) values ('old', ?)").run(id);
    const answer = await body(await patch(id, { legs: MEANT }));
    expect([answer.followed_monitors.map((m: { code: string }) => m.code), answer.rescoped_monitors])
      .toEqual([["ratio"], [{ id: "old", code: "old13", scope: "leg" }]]);
    expect(JSON.parse(rule("old13").legs!)).toEqual(legs);
    expect([rule("old13").scope, rule("old13").triggered]).toEqual(["leg", 1]);
  });

  it("writes the legs and the rest of the patch together", async () => {
    start();
    const id = await held();
    expect((await patch(id, { legs: MEANT, entry: 0.75 })).status).toBe(200);
    expect([JSON.parse(stored(id).legs), stored(id).entry]).toEqual([MEANT, 0.75]);
  });

  it("stamps nothing and resets nothing when no quantity changed", async () => {
    start();
    const id = await held();
    ringing("ratio");
    const answer = await body(await patch(id, { legs: TYPED }));
    expect([answer.followed_monitors, answer.rescoped_monitors]).toEqual([[], []]);
    expect(stored(id).qty_corrected_at).toBeNull();
    expect(rule("ratio").triggered).toBe(1);
  });

  it("refuses anything but a quantity: a different structure is a different holding", async () => {
    start();
    const id = await held();
    const [long, short] = TYPED as unknown as [Record<string, unknown>, Record<string, unknown>];
    const tail = ": only a leg's quantity can be corrected — a different structure is a different holding";
    expect(await refused(id, { legs: [long] })).toBe(`'ratio' has 2 legs, not 1${tail}`);
    expect(await refused(id, { legs: [long, { ...short, strike: 7050 }] })).toBe(`'ratio' has no PUT 7050 leg${tail}`);
    expect(await refused(id, { legs: [long, { ...short, option_type: "CALL" }] })).toBe(`'ratio' has no CALL 7075 leg${tail}`);
    expect(await refused(id, { legs: [long, { ...short, side: "long" }] })).toBe(`'ratio' is short PUT 7075, not long${tail}`);
    expect(await refused(id, { legs: [long, long] })).toBe(`'ratio' is given PUT 7100 twice${tail}`);
    expect(JSON.parse(stored(id).legs), "and nothing was written").toEqual(TYPED);
    expect(stored(id).qty_corrected_at).toBeNull();
  });

  it("refuses a quantity of none, of more than ten, or of a part", async () => {
    start();
    const id = await held();
    for (const qty of [0, 11, 1.5]) {
      expect(await refused(id, { legs: [TYPED[0], { ...TYPED[1], qty }] })).toMatch(/legs\[1\]\.qty/);
    }
    expect(JSON.parse(stored(id).legs)).toEqual(TYPED);
  });

  it("refuses a closed holding: its quantities are part of the record it closed with", async () => {
    start();
    const id = await held();
    expect((await h.call(`/positions/${id}/close`, json({ exit: 0.2 }))).status).toBe(200);
    expect(await refused(id, { legs: MEANT }))
      .toBe("position 'ratio' is closed: a leg's quantity is corrected only while it is held");
    expect(JSON.parse(stored(id).legs)).toEqual(TYPED);
  });

  it("marks the samples observed before the correction, and says when it was", async () => {
    start();
    const id = await held();
    sampleOn(id, "2026-09-30", 79, null);
    sampleOn(id, "2026-10-01", 78, "2026-10-01 19:59:00.000000");
    expect((await patch(id, { legs: MEANT })).status).toBe(200);
    // the day's row, written by a sweep after the correction, is summed under the 1×2
    sampleOn(id, "2026-10-02", 77, "2026-10-02 05:30:00.000000");
    const data = await body(await h.call(`/positions/${id}/samples`));
    expect(data.qty_corrected_at).toBe("2026-10-02 13:26:06+08:00");
    expect(data.samples.map((s: { observed_on: string; before_correction: boolean }) =>
      [s.observed_on, s.before_correction])).toEqual([
      ["2026-09-30", true], ["2026-10-01", true], ["2026-10-02", false],
    ]);
  });

  it("marks no sample of a holding never corrected", async () => {
    start();
    const id = await held();
    sampleOn(id, "2026-10-01", 78, null);
    const data = await body(await h.call(`/positions/${id}/samples`));
    expect(data.qty_corrected_at).toBeNull();
    expect(data.samples[0].before_correction).toBe(false);
  });

  it("measures no gap from a Cost to close summed before the correction", async () => {
    start();
    const id = await held();
    sampleOn(id, "2026-10-01", 78, "2026-10-01 19:59:00.000000");
    const before = await body(await h.call(`/positions/${id}/vol`));
    expect(before.gap).not.toBeNull();
    expect((await patch(id, { legs: MEANT })).status).toBe(200);
    const after = await body(await h.call(`/positions/${id}/vol`));
    const why = "the Cost to close of 2026-10-01 was summed before a leg's quantity was corrected";
    expect([after.gap, after.gap_reason, after.rest, after.cover, after.cover_reason]).toEqual([null, why, null, null, why]);
  });
});
