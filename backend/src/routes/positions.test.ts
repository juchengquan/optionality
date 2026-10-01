/** `/positions`. Ported from tests/test_positions_api.py (ADR 0009, phase 5).
 *
 *  The total-entry group landed with `applyTotalEntry` in 5b; what is here is the holding itself,
 *  its live figures, and the linkage in both directions.
 */
import { afterEach, describe, expect, it } from "vitest";

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
    // was watching, and would be adopted again if the holding came back.
    expect(h.db.prepare("select id from monitors where id = ?").get(mid)).toBeTruthy();
    expect(links(mid)).toEqual([[], "leg"]);
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

  it("leaves a stale scope alone on a monitor it cannot find a holding for", async () => {
    // after the holding goes the monitor keeps the scope it had, with no links. Adoption that
    // cleared it would be taking something away, which is the one thing it must never do.
    start();
    const pid = await makePosition("held", "2026-10-16", [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ]);
    const mid = await makeMonitor({ strike_date: "2026-10-16", option_type: "CALL", strike: 8050 });
    await h.call(`/positions/${pid}`, { method: "DELETE" });
    expect(links(mid)).toEqual([[], "leg"]);

    await makePosition("elsewhere", "2026-11-20", [
      { side: "sold", option_type: "CALL", strike: 9000 },
    ]);
    expect(links(mid)).toEqual([[], "leg"]);
  });
});
