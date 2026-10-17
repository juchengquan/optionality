/** `/positions`. Ported from tests/test_positions_api.py (ADR 0009, phase 5).
 *
 *  The total-entry group landed with `applyTotalEntry` in 5b; what is here is the holding itself,
 *  its live figures, and the linkage in both directions.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildSpxCode } from "../domain/contract.ts";
import { type Harness, body, harness, json, pricedFetcher } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const EXPIRY = "2026-12-18";
const CONDOR_LEGS = [
  { side: "sold", option_type: "CALL", strike: 8050 },
  { side: "bought", option_type: "CALL", strike: 8075 },
  { side: "sold", option_type: "PUT", strike: 7100 },
  { side: "bought", option_type: "PUT", strike: 7075 },
];
const condor = (over: Record<string, unknown> = {}) => ({
  name: "1016_IC", strategy: "iron_condor", strike_date: EXPIRY, contracts: 1, entry: 3.0,
  legs: CONDOR_LEGS, ...over,
});

const start = (fetchQuotes = pricedFetcher) => (h = harness({ fetchQuotes }));
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
    expect(await body(resp)).toEqual({ vol: 4, from: "2026-10-06", to: "2026-10-07", days: 1 });
  });

  it("says so plainly when there is no baseline, rather than guessing one", async () => {
    // the live condor's case, and the shape every Position declared after the fact is in
    start();
    const id = await created201(await post(condor({ opened_at: "2026-10-06" })));
    sample(id, "2026-10-12", 39, flat(10), flat(4));
    sample(id, "2026-10-13", 38, flat(11), flat(4));

    const resp = await h.call(`/positions/${id}/vol`);
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({ vol: null, from: null, to: null, days: null });
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
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7075 },
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
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7075 },
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
      { side: "sold", option_type: "PUT", strike: 6000 },
      { side: "bought", option_type: "PUT", strike: 5950 },
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
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7075 },
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
        sign: l.side === "sold" ? -1 : 1, option_type: l.option_type, strike: l.strike,
      })),
    })))).id as string;
    expect(links(rid)).toEqual([[keep], "all"]);

    const other = await created201(await holdingOf("other", [
      { side: "sold", option_type: "PUT", strike: 6000 },
      { side: "bought", option_type: "PUT", strike: 5950 },
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
        sign: l.side === "sold" ? -1 : 1, option_type: l.option_type, strike: l.strike,
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

  it("refuses a side that is neither sold nor bought", async () => {
    start();
    expect((await post(condor({ legs: [{ side: "long", option_type: "CALL", strike: 8050 }] })))
      .status).toBe(422);
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
    start((codes) => {
      const bad = codes.filter((c) => c.endsWith("C8050000"));
      if (bad.length > 0) {
        return Promise.reject(new Error(`snapshot API failed: Unknown stock. ${bad[0]!.replace(/^US\./, "")}`));
      }
      return pricedFetcher(codes);
    });
    const resp = await post(condor());
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/does not exist/);
    expect(await body(await h.call("/positions"))).toEqual([]);
  });

  it("refuses while OpenD is unreachable", async () => {
    start(() => Promise.reject(new Error("Client connection failed!")));
    const resp = await post(condor());
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/unreachable/);
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
    // exposure-signed, not cost-signed: two sold legs against two bought at 0.2 each
    expect(v.greeks.option_delta).toBe(0);
    expect(v.fetched_at).toMatch(/\+08:00$/);
  });

  it("reports nothing rather than something wrong when a leg goes unpriced", async () => {
    // full quotes while creating, since the gate demands every leg exists; one dropped afterwards
    let complete = true;
    start(async (codes) => {
      const priced = await pricedFetcher(codes);
      return complete ? priced : priced.slice(0, -1);
    });
    expect((await post(condor())).status).toBe(201);
    complete = false;
    const v = (await body(await h.call("/positions/values")))[0];
    expect(v.cost_to_close).toBeNull();
    expect(v.pnl).toBeNull();
  });

  it("is an empty list with nothing held, and makes no call", async () => {
    let calls = 0;
    start((codes) => { calls += 1; return pricedFetcher(codes); });
    expect(await body(await h.call("/positions/values"))).toEqual([]);
    expect(calls).toBe(0);
  });

  it("answers 502 rather than 500 when the OpenD call fails", async () => {
    let first = true;
    start(async (codes) => {
      if (first) { first = false; return pricedFetcher(codes); }
      throw new Error("quota exceeded");
    });
    await post(condor());
    const resp = await h.call("/positions/values");
    expect(resp.status).toBe(502);
    expect((await body(resp)).detail).toMatch(/OpenD call failed/);
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

  it("never edits the legs — a different structure is a different holding", async () => {
    start();
    const id = (await body(await post(condor()))).id;
    const patched = await patch(id, { legs: [CONDOR_LEGS[0]], contracts: 3 });
    expect(patched.status).toBe(200);
    const data = await body(patched);
    expect(data.legs).toHaveLength(4);
    expect(data.contracts).toBe(3);
  });
});

describe("a monitor finding the position that holds it", () => {
  it("links a leg rule to the position holding that contract", async () => {
    // creating a monitor linked it to nothing, so everything the Position work built — entry, P&L,
    // the derived total — silently applied only to monitors predating the backfill migration
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);
  });

  it("calls it the whole position when the rule covers it exactly", async () => {
    start();
    const pid = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const puts = await makePosition("puts", "2026-10-16", [
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("new_roll", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8100 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[first], "leg"]);

    await makePosition("new_roll", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8100 },
    ]);
    expect(links(mid)).toEqual([[first], "leg"]);
  });

  it("does not resolve an ambiguity it cannot resolve", async () => {
    // an orphan created while two positions already share its strike stays an orphan, and a later
    // position does not talk adoption into guessing
    start();
    await makePosition("old_roll", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("new_roll", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8100 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[], null]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "sold", option_type: "CALL", strike: 9000 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    await h.call(`/positions/${pid}`, { method: "DELETE" });
    expect(links(mid)[0]).toEqual([]);

    const again = await makePosition("1016_bs_8050", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    await makePosition("b", EXPIRY, [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8100 },
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);

    const other = await post({
      name: "elsewhere", strike_date: "2026-11-20",
      legs: [{ side: "sold", option_type: "CALL", strike: 9000 }],
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
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    await h.call(`/positions/${pid}`, { method: "DELETE" });
    expect(links(mid), "the delete clears it").toEqual([[], null]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "sold", option_type: "CALL", strike: 9000 },
    ]);
    expect(links(mid), "and adoption leaves it exactly as it was").toEqual([[], null]);
  });

  it("adoption leaves a scope it cannot place ALONE, rather than clearing it", async () => {
    // the original concern, as its own test: a monitor whose holding is still there keeps its
    // scope when an unrelated holding is created, and POST /positions must never reach for it.
    // Set up by hand, because the only route that clears a scope is the delete.
    start();
    const pid = await makePosition("held", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    expect(links(mid)).toEqual([[pid], "leg"]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "sold", option_type: "CALL", strike: 9000 },
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
