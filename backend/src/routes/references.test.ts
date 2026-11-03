/** `/references` — the three doors, and what each one refuses (ADR 0018).
 *
 *  The behaviour this file is mostly about is what does NOT happen: no route writes a Reference's
 *  state, nothing disables one, and GET declares no failure status at all. `references.test.ts`
 *  holds the degrade; this holds the surface.
 */
import { afterEach, describe, expect, it } from "vitest";

import { type Harness, body, harness, json, quoting } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const SPY = {
  code: "US.SPY", name: "SPDR S&P 500 ETF Trust",
  bid_price: 758.7, ask_price: 758.76, mid_price: 758.73,
  last_price: 755.72, prev_close_price: 755.72,
};

/** A Provider that quotes SPY and knows nothing else — which is what the live one does with an
 *  index code, give or take the sentence. */
const start = () => (h = harness({ fetchQuotes: (codes) => quoting({ "US.SPY": SPY })(codes) }));

const post = (payload: unknown) => h.call("/references", json(payload));

const created = async (payload: unknown): Promise<string> => {
  const resp = await post(payload);
  const data = await body(resp);
  expect(resp.status, JSON.stringify(data)).toBe(201);
  return data.id as string;
};

describe("keeping a Security on the page", () => {
  it("takes a raw code, a label and a scale", async () => {
    start();
    const resp = await post({ code: "US.SPY", label: "SPX", scale: 10 });
    expect(resp.status).toBe(201);
    expect(await body(resp)).toMatchObject({ code: "US.SPY", label: "SPX", scale: 10 });
  });

  it("takes a code on its own, where neither a name nor a scale would add anything", async () => {
    start();
    expect(await body(await post({ code: "US.SPY" })))
      .toMatchObject({ code: "US.SPY", label: null, scale: null });
  });

  it("upper-cases and trims the code, so one Security cannot become two rows", async () => {
    start();
    expect(await body(await post({ code: "  us.spy " }))).toMatchObject({ code: "US.SPY" });
    // and the duplicate check then sees it, which is the half that matters
    expect((await post({ code: "US.SPY" })).status).toBe(409);
  });

  it("refuses a second Reference on the same Security", async () => {
    start();
    await created({ code: "US.SPY" });
    const resp = await post({ code: "US.SPY", label: "SPX" });
    expect(resp.status).toBe(409);
    // two References on one Security would be two figures that cannot differ
    expect((await body(resp)).detail).toMatch(/already kept on the page/);
  });

  it("refuses a duplicate without spending a Provider call", async () => {
    // the order is the point, as it is in `create-monitor.ts`: everything free comes before
    // anything that costs a bounded call, and the database already knows the answer
    let calls = 0;
    h = harness({ fetchQuotes: (codes) => { calls += 1; return quoting({ "US.SPY": SPY })(codes); } });
    await created({ code: "US.SPY" });
    const spent = calls;
    expect((await post({ code: "US.SPY" })).status).toBe(409);
    expect(calls, "the duplicate reached the Provider").toBe(spent);
  });

  it("probes the Provider strictly, as monitor creation does", async () => {
    start();
    const resp = await post({ code: "US.NOPE" });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/does not exist/);
    // and nothing was written: a permanent dash is better found at creation than on the page
    expect(h.db.prepare("select count(*) as n from reference_securities").get())
      .toMatchObject({ n: 0 });
  });

  it("refuses an index the Provider answers about and declines, without calling it an outage", async () => {
    // the measurement ADR 0018 is built on: moomoo refuses every US stock index as a CLASS,
    // naming no culprit, so the containment loop re-throws and this is the path `US..SPX` takes.
    // The gateway is up; "unreachable" would send the owner to look at the wrong thing.
    h = harness({
      fetchQuotes: () => Promise.reject(new Error("snapshot API failed: US stock indices are not supported")),
    });
    const resp = await post({ code: "US..SPX", label: "SPX" });
    expect(resp.status).toBe(422);
    const detail = (await body(resp)).detail as string;
    expect(detail).toContain("US stock indices are not supported");
    expect(detail).not.toMatch(/unreachable/);
  });

  it("refuses a scale that would make every figure zero", async () => {
    start();
    expect((await post({ code: "US.SPY", scale: 0 })).status).toBe(422);
  });

  it("refuses a scale that would invert the market", async () => {
    start();
    expect((await post({ code: "US.SPY", scale: -10 })).status).toBe(422);
  });

  it("refuses an empty code", async () => {
    start();
    expect((await post({ code: "   " })).status).toBe(422);
  });
});

describe("reading them", () => {
  it("answers the figure, the field it came from and the day's move", async () => {
    start();
    await created({ code: "US.SPY", label: "SPX", scale: 10 });
    const rows = await body(await h.call("/references")) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "US.SPY", label: "SPX", scale: 10,
      name: "SPDR S&P 500 ETF Trust", figure: 7587.3, field: "mid_price", error: null,
    });
  });

  it("answers 200 with a dash while the Provider is wholly down", async () => {
    // the one surface here that cannot fail: the page it decorates must still draw, and a backdrop
    // that can 502 is a backdrop that can take the watchlist's screen with it
    h = harness({ fetchQuotes: () => Promise.reject(new Error("Client connection failed!")) });
    h.db.prepare(
      `insert into reference_securities (id, code, label, scale, created_at)
       values (?, 'US.SPY', 'SPX', 10, '2026-11-02 00:00:00.000000')`,
    ).run("r".repeat(32));
    const resp = await h.call("/references");
    expect(resp.status).toBe(200);
    const rows = await body(resp) as unknown as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ figure: null, field: null, change: null });
    expect(rows[0]!.error).toContain("Client connection failed!");
  });

  it("answers an empty list before anything is kept", async () => {
    start();
    expect(await body(await h.call("/references"))).toEqual([]);
  });
});

describe("removing one", () => {
  it("removes it, and says so with no body", async () => {
    start();
    const id = await created({ code: "US.SPY" });
    expect((await h.call(`/references/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await body(await h.call("/references"))).toEqual([]);
  });

  it("names the noun when there is nothing to remove", async () => {
    start();
    const resp = await h.call("/references/nope", { method: "DELETE" });
    expect(resp.status).toBe(404);
    expect((await body(resp)).detail).toBe("reference not found");
  });

  it("is the only way one ever goes — reading them never writes", async () => {
    start();
    await created({ code: "US.SPY", label: "SPX", scale: 10 });
    const before = h.db.prepare("select * from reference_securities").all();
    // a code the Provider cannot price, read twice: a Monitor would be quarantined for this and a
    // Reference is not, because quarantine is about a rule that cannot be EVALUATED
    h.db.prepare(
      `insert into reference_securities (id, code, label, scale, created_at)
       values (?, 'US.NOPE', null, null, '2026-11-02 00:00:01.000000')`,
    ).run("n".repeat(32));
    await h.call("/references");
    await h.call("/references");
    expect(h.db.prepare("select * from reference_securities where code = 'US.SPY'").all())
      .toEqual(before);
    expect(h.db.prepare("select count(*) as n from reference_securities").get())
      .toMatchObject({ n: 2 });
  });
});
