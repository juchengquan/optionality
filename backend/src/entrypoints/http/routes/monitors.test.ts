/** `/monitors` and `/quotes`. Ported from tests/test_monitors_api.py (ADR 0009, phase 5).
 *
 *  Three of the Python's twenty-one do not come across as written:
 *  - `test_openapi_documents_both_monitor_shapes` reads /openapi.json, which Hono did not serve;
 *    it lives in openapi.test.ts now that it does.
 *  - `test_health_exposes_monitor_sweep_state` asserts a sweep has already run at startup; there is
 *    no sweeper or lifespan until phase 6.
 *  - `test_delete_removes_the_position_links_first` creates its Position through /positions, which
 *    arrives in phase 5c. The valuable half — that creation links and deletion unlinks — is kept,
 *    with the Position seeded directly.
 */
import { afterEach, describe, expect, it } from "vitest";

import { type Harness, body, daysFromNow, harness, json, poisonable, quoting } from "../../../../testing/harness.ts";

let h: Harness;
afterEach(() => h?.close());

// relative to the HARNESS's clock, not the real one — see NOW in testing/harness.ts
const daysAhead = daysFromNow;
const future = () => daysAhead(30);

const single = (over: Record<string, unknown> = {}) =>
  ({ strike_date: future(), option_type: "CALL", strike: 6500, threshold: 0.6, ...over });

const COMBO = {
  name: "sep-condor",
  legs: [
    { sign: 1, option_type: "CALL", strike: 8100 },
    { sign: -1, option_type: "CALL", strike: 8150 },
  ],
  threshold: 10,
  direction: "below",
};
const combo = (over: Record<string, unknown> = {}) => ({ ...COMBO, strike_date: future(), ...over });

const post = (payload: unknown) => h.call("/monitors", json(payload));
const patch = (id: string, payload: unknown) =>
  h.call(`/monitors/${id}`, { ...json(payload), method: "PATCH" });

describe("the round trip", () => {
  it("creates, lists, patches and deletes", async () => {
    h = harness();
    const created = await post(single());
    expect(created.status).toBe(201);
    const data = await body(created);
    // uuid4 hex, like run ids — not a guessable sequence
    expect(data.id).toHaveLength(32);
    expect(data.code).toMatch(/^US\.SPXW\d{6}C6500000$/);
    expect(data.field).toBe("option_delta");
    expect(data.enabled).toBe(true);

    expect((await post(single())).status).toBe(409); // duplicate (code, field)

    const listed = await body(await h.call("/monitors"));
    expect(listed).toHaveLength(1);
    expect(listed[0].last_value).toBeNull();
    expect(listed[0].triggered).toBe(false);

    expect((await patch(data.id, { threshold: 0.5 })).status).toBe(200);
    expect((await body(await h.call("/monitors")))[0].threshold).toBe(0.5);

    expect((await h.call(`/monitors/${data.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await body(await h.call("/monitors"))).toEqual([]);
  });

  it("allows the same contract on a different field", async () => {
    h = harness();
    expect((await post(single())).status).toBe(201);
    expect((await post(single({ field: "mid_price", threshold: 30 }))).status).toBe(201);
  });

  it("is a 404 for a monitor that was never there, and says which noun is missing", async () => {
    // The status alone was asserted here, and on both doors: a mutation changing the PATCH
    // handler's notFound("monitor") to notFound("position") survived, which is a 404 reading
    // "position not found" about a monitor. Only /monitors/:id/total-entry stated the noun, so
    // the two doors the dashboard actually uses were the two that did not.
    h = harness();
    for (const resp of [
      await patch("nope", { threshold: 1 }),
      await h.call("/monitors/nope", { method: "DELETE" }),
    ]) {
      expect(resp.status).toBe(404);
      expect(await body(resp)).toEqual({ detail: "monitor not found" });
    }
  });
});

describe("dates and shapes", () => {
  it("normalises a compact date to the dashed form", async () => {
    h = harness();
    const created = await post(single({ strike_date: future().replaceAll("-", "") }));
    expect(created.status).toBe(201);
    expect((await body(created)).strike_date).toBe(future()); // stored dashed regardless of input
  });

  it("rejects a date that is not one of the two forms, and an impossible one", async () => {
    h = harness();
    for (const bad of ["18-12-2026", "2026-13-45", "2026-02-30", "nope"]) {
      expect((await post(single({ strike_date: bad }))).status, bad).toBe(422);
    }
  });

  it("says what is wrong with a body, whichever of the two shapes it is", async () => {
    // The two shapes are one union, and a union that every member refuses answers "Invalid
    // input" and nothing else — so a date it cannot read, a missing threshold and a combo leg
    // signed 2 all read the same on the dashboard, which prints `detail` verbatim. The shape
    // picks the member, and the member says what it refused.
    h = harness();
    const detail = async (payload: unknown) => {
      const resp = await post(payload);
      expect(resp.status).toBe(422);
      return (await body(resp)).detail as string;
    };
    const date = "✖ invalid strike_date '18 Dec': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date";
    expect(await detail(single({ strike_date: "18 Dec" }))).toBe(date);
    expect(await detail(combo({ strike_date: "18 Dec" })), "and a combo's").toBe(date);
    expect(await detail(single({ threshold: undefined })))
      .toBe("✖ Invalid input: expected number, received undefined\n  → at threshold");
    expect(await detail(combo({ legs: [{ ...COMBO.legs[0], sign: 2 }, COMBO.legs[1]] })))
      .toBe("✖ Invalid option: expected one of 1|-1\n  → at legs[0].sign");
  });

  it("reads a body that carries legs as a combo, and refuses it as one", async () => {
    // The union took this as a single-leg rule and dropped the legs without a word: the
    // combo member refused it for want of a name, and the single-leg member accepted it.
    h = harness();
    const resp = await post(single({ legs: COMBO.legs }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail)
      .toBe("✖ Invalid input: expected string, received undefined\n  → at name");
  });

  it("rejects an option type that is not CALL or PUT, and a direction that is neither", async () => {
    h = harness();
    expect((await post(single({ option_type: "FOO" }))).status).toBe(422);
    expect((await post(single({ direction: "sideways" }))).status).toBe(422);
  });

  it("stores a below-direction monitor as asked", async () => {
    h = harness();
    const created = await post(single({ field: "mid_price", threshold: 30, direction: "below" }));
    expect((await body(created)).direction).toBe("below");
  });

  it("renders timestamps in the display zone", async () => {
    h = harness();
    expect((await body(await post(single()))).created_at).toMatch(/\+08:00$/);
  });
});

describe("thresholds", () => {
  it("refuses a non-positive threshold in abs mode, everywhere it can be set", async () => {
    // abs comparison makes these never-firing (below) or always-firing (above)
    h = harness();
    expect((await post(single({ threshold: -4.05 }))).status).toBe(422);
    expect((await post(single({ threshold: 0 }))).status).toBe(422);
    expect((await post(combo({ threshold: -1 }))).status).toBe(422);

    const id = (await body(await post(single()))).id;
    expect((await patch(id, { threshold: -1 })).status).toBe(422);
  });

  it("says WHICH rule the threshold broke, not merely that it broke one", async () => {
    // Only the 422 was asserted, so the two sentences were interchangeable: a mutation swapping
    // them broke nothing, and a signed zero could be refused with "must be positive when
    // compare='abs'" — an error naming a mode you did not use.
    h = harness();
    const abs = await body(await post(single({ threshold: 0, compare: "abs" })));
    expect(abs.detail, "the abs rule").toMatch(/must be positive when compare='abs'/);

    const signed = await body(await post(single({ threshold: 0, compare: "signed" })));
    expect(signed.detail, "the signed rule").toMatch(/signed threshold cannot be 0/);

    // and PATCH keeps its own shorter wording for the same two faults
    const id = (await body(await post(single()))).id;
    const patchedAbs = await body(await patch(id, { threshold: 0, compare: "abs" }));
    expect(patchedAbs.detail).toMatch(/must be positive when compare='abs'/);
    const patchedSigned = await body(await patch(id, { threshold: 0, compare: "signed" }));
    expect(patchedSigned.detail).toMatch(/signed threshold cannot be 0/);
  });

  it("allows a negative threshold in signed mode, and refuses exactly zero", async () => {
    h = harness();
    const created = await post(single({
      strike: 8100, field: "mid_price", threshold: -4.05, direction: "below", compare: "signed",
    }));
    expect(created.status).toBe(201);
    const data = await body(created);
    expect(data.compare).toBe("signed");

    expect((await patch(data.id, { threshold: -5 })).status).toBe(200);
    // a signed threshold of zero is a band of zero width that a value can sit exactly on
    expect((await patch(data.id, { threshold: 0 })).status).toBe(422);
    expect((await post(single({ strike: 8150, field: "mid_price", threshold: 0, compare: "signed" })))
      .status).toBe(422);
  });

  it("judges a patched threshold against the compare mode in the same patch", async () => {
    h = harness();
    const id = (await body(await post(single({ option_type: "PUT", strike: 7800 })))).id;
    expect((await patch(id, { threshold: -1 })).status).toBe(422);
    // the two together are legal; the threshold alone is not
    expect((await patch(id, { compare: "signed", threshold: -1 })).status).toBe(200);
  });
});

describe("combos", () => {
  it("creates one under the name the trader chose, with the combo default field", async () => {
    h = harness();
    const created = await post(combo());
    expect(created.status).toBe(201);
    const data = await body(created);
    expect(data.code).toBe("sep-condor");
    expect(data.field).toBe("mid_price"); // combo default, not option_delta
    expect(data.option_type).toBe("CMB");
    expect(data.legs).toHaveLength(2);

    expect((await post(combo())).status).toBe(409); // duplicate name
  });

  it("needs at least two legs to be a combo at all", async () => {
    h = harness();
    expect((await post(combo({ name: "x", legs: COMBO.legs.slice(0, 1) }))).status).toBe(422);
  });

  it("keeps its legs through an edit that tries to carry new ones", async () => {
    // The legs define it; changing them would change what the alarm means. PUT refused that in
    // prose — "combo monitors cannot be edited in place; delete and recreate" — and went with the
    // route in #199. The protection is now structural: `MonitorPatch` has no `legs`, so zod strips
    // the key and the stored legs cannot be reached from any door.
    //
    // Stated as what the API DOES rather than as a refusal, because that is the truth and the
    // difference matters to anyone reading this file: the key is dropped silently, not rejected,
    // so the rest of the patch still applies. Worth pinning either way — a schema that gained a
    // passthrough, or a handler that started spreading `given` into `changes`, would edit the legs
    // of a live combo with nothing to show for it.
    h = harness();
    const created = await body(await post(combo()));
    expect(created.legs).toHaveLength(2);
    const resp = await patch(created.id, {
      threshold: 12, legs: [{ sign: 1, option_type: "CALL", strike: 1 }],
    });
    expect(resp.status).toBe(200);
    const after = (await body(await h.call("/monitors")))[0];
    expect(after.threshold).toBe(12);          // the legal half went through
    expect(after.legs).toEqual(created.legs);  // and the legs are exactly as created
  });

  it("names the field before the threshold when both are wrong", async () => {
    // Precedence, pinned on both doors. The route checked the combo field first and the bot
    // checked the threshold first, so one input had two answers depending on where you typed it;
    // create-monitor.ts fixes one order and this is half of what holds it there (the other half is
    // the same test in bot.test.ts). The field wins because it says the rule can never work,
    // while a threshold is a number you can correct.
    h = harness();
    const resp = await post(combo({
      name: "both-wrong", field: "option_implied_volatility", threshold: -1,
      legs: [
        { sign: 1, option_type: "CALL", strike: 8100 },
        { sign: 1, option_type: "CALL", strike: 8150 },
      ],
    }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toContain("not additive");
  });

  it("cannot watch implied volatility", async () => {
    // IV is intensive: two 20% legs are not a 40% combo. Summing it is meaningless, so the field
    // is refused at the gate rather than producing a nonsense alarm.
    h = harness();
    const resp = await post(combo({
      name: "iv-combo", field: "option_implied_volatility",
      legs: [
        { sign: 1, option_type: "CALL", strike: 8100 },
        { sign: 1, option_type: "CALL", strike: 8150 },
      ],
    }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail)
      .toBe("combos cannot watch option_implied_volatility: it is not additive across legs");
  });

  it("is patchable for the safe fields, leaving the legs alone", async () => {
    h = harness();
    const created = await body(await post(combo()));
    const patched = await patch(created.id, { threshold: 25 });
    expect(patched.status).toBe(200);
    const data = await body(patched);
    expect(data.threshold).toBe(25);
    expect(data.legs).toEqual(created.legs);
  });
});

describe("renaming", () => {
  it("keeps the monitor's history, which recreating it would lose", async () => {
    h = harness();
    const created = await body(await post(combo()));
    // a live, triggered monitor with history
    h.db.prepare("update monitors set triggered = 1, last_value = 7.15 where id = ?")
      .run(created.id);

    const renamed = await patch(created.id, { name: "sep-condor-v2" });
    expect(renamed.status).toBe(200);
    const data = await body(renamed);
    expect(data.code).toBe("sep-condor-v2");
    expect(data.triggered).toBe(true);
    expect(data.last_value).toBe(7.15);
    expect(data.legs).toEqual(created.legs);
    expect(data.created_at).toBe(created.created_at);
  });

  it("refuses a single-leg monitor, whose code is derived from its contract", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    const resp = await patch(id, { name: "nope" });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/only combo monitors can be renamed/);
  });

  it("refuses a name another monitor already uses", async () => {
    h = harness();
    const a = await body(await post(combo()));
    const b = await body(await post(combo({ name: "other" })));
    expect((await patch(b.id, { name: a.code })).status).toBe(409);
  });
});

describe("patching", () => {
  it("changes only what it was given", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    const patched = await patch(id, { threshold: 0.5, direction: "below" });
    expect(patched.status).toBe(200);
    const data = await body(patched);
    expect(data.threshold).toBe(0.5);
    expect(data.direction).toBe("below");
    expect(data.field).toBe("option_delta"); // untouched
  });

  it("refuses an empty patch rather than reporting a change it did not make", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    const resp = await patch(id, {});
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("nothing to update");
  });

  it("changes every field a rule has in one patch: what it watches, its direction, its compare", async () => {
    // the dashboard's editor sends whichever of the four changed (#292), and each must land
    h = harness();
    const id = (await body(await post(single()))).id;
    const data = await body(await patch(id, {
      field: "mid_price", direction: "below", compare: "signed", threshold: -1.5,
    }));
    expect([data.field, data.direction, data.compare, data.threshold])
      .toEqual(["mid_price", "below", "signed", -1.5]);
    expect((await body(await h.call("/monitors")))[0].field).toBe("mid_price");
  });

  it("refuses a combo moved onto a figure that does not add up across its legs", async () => {
    // POST refuses a combo on IV; a PATCH reaching the same row by the back door must too, or the
    // engine sums nothing and the rule goes silent until it is quarantined (CLAUDE.md: Combos)
    h = harness();
    const id = (await body(await post(combo()))).id;
    const resp = await patch(id, { field: "option_implied_volatility" });
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail)
      .toBe("combos cannot watch option_implied_volatility: it is not additive across legs");
    expect((await body(await h.call("/monitors")))[0].field).toBe("mid_price");
  });

  it("lets a single leg watch its IV, which is its own and needs no sum", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    expect((await patch(id, { field: "option_implied_volatility", threshold: 25 })).status).toBe(200);
  });

  it("refuses a field that would collide with another monitor on the same contract", async () => {
    h = harness();
    await post(single());
    const other = await body(await post(single({ field: "mid_price", threshold: 30 })));
    expect((await patch(other.id, { field: "option_delta" })).status).toBe(409);
  });

  it("records that a monitor was disabled by hand, and clears that on re-enable", async () => {
    // the sweeper's own quarantine and expiry notices must not be overwritten by a manual toggle
    h = harness();
    const id = (await body(await post(single()))).id;
    expect((await body(await patch(id, { enabled: false }))).disabled_reason).toBe("manual");
    expect((await body(await patch(id, { enabled: true }))).disabled_reason).toBeNull();
  });
});

describe("the ordering", () => {
  it("groups by expiry, combos first, then calls before puts", async () => {
    h = harness();
    const near = future();
    const far = daysAhead(45);
    for (const payload of [
      single({ strike_date: far, strike: 8100 }),
      single({ strike_date: near, option_type: "PUT", strike: 6425, threshold: 0.5 }),
      single({ strike_date: near, strike: 6500 }),
      combo({
        name: "near-condor", strike_date: near, threshold: 10,
        legs: [
          { sign: 1, option_type: "CALL", strike: 6500 },
          { sign: -1, option_type: "CALL", strike: 6600 },
        ],
      }),
    ]) await post(payload);

    const listed = await body(await h.call("/monitors"));
    expect(listed.map((m: { strike_date: string }) => m.strike_date)).toEqual([near, near, near, far]);
    // the combo leads its own expiry, not the CALL/PUT gap
    expect(listed[0].code).toBe("near-condor");
    expect(listed.slice(1, 3).map((m: { option_type: string }) => m.option_type))
      .toEqual(["CALL", "PUT"]);
  });
});

describe("the creation gate", () => {
  it("refuses a contract moomoo does not have, and persists nothing", async () => {
    h = harness({ fetchQuotes: poisonable("99999") });
    const resp = await post(single({ strike: 99999, strike_date: "2026-10-16", threshold: 0.5 }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toMatch(/does not exist/);
    expect(await body(await h.call("/monitors"))).toEqual([]);
  });

  it("refuses a combo when any one leg does not exist", async () => {
    h = harness({ fetchQuotes: poisonable("99999") });
    const resp = await post(combo({
      name: "bad-combo", strike_date: "2026-10-16",
      legs: [
        { sign: 1, option_type: "CALL", strike: 8100 },
        { sign: -1, option_type: "CALL", strike: 99999 },
      ],
    }));
    expect(resp.status).toBe(422);
    expect(await body(await h.call("/monitors"))).toEqual([]);
  });

  it("refuses when the probe threw, rather than accepting a contract it cannot check", async () => {
    // strict by design: a monitor on a contract that does not exist would quarantine itself on the
    // first sweep, which is a worse way to find out.
    //
    // The wording carries the Provider's own sentence and no longer claims an outage: a Provider
    // that ANSWERED and declined the security throws here too (ADR 0018).
    h = harness({ fetchQuotes: () => Promise.reject(new Error("Client connection failed!")) });
    const resp = await post(single({ strike: 8100, threshold: 0.5 }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe(
      "cannot verify contract: the Provider did not confirm it — Client connection failed!",
    );
  });
});

describe("the links to positions", () => {
  const seedPosition = (id: string, name: string, strikeDate: string, strike: number) =>
    h.db.prepare(
      `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
       values (?, ?, 'credit_spread', ?, 1, 2.0, ?, '2026-09-24 02:58:57.456253')`,
    ).run(id, name, strikeDate,
      JSON.stringify([{ side: "short", option_type: "CALL", strike }]));

  const linkCount = (monitorId: string) =>
    (h.db.prepare("select count(*) n from monitor_positions where monitor_id = ?").get(monitorId) as { n: number }).n;

  it("attaches a new monitor to whatever position already holds its contract", async () => {
    // without this, everything the Position work built — entry, P&L, the derived total — applies
    // only to monitors that predate the migration which backfilled these rows
    h = harness();
    seedPosition("p".repeat(32), "del-target", "2026-12-18", 6500);
    const created = await body(await post(single({ strike_date: "2026-12-18", strike: 6500, threshold: 0.2 })));
    expect(linkCount(created.id)).toBe(1);
    expect(created.scope).toBe("all");
    // The create response carries the links it has just made. It answered `positions: []` until
    // #172 — the Python's did too, and the port kept it — which is a false statement about a row
    // the same transaction linked: `scope: "all"` beside an empty list says "this covers a whole
    // holding" and "no holding", and a client has no way to tell which half to believe. The list
    // route is NOT the answer to that: it is a second call, so a client acting on the reply it
    // just received acts on the lie.
    expect(created.positions).toEqual([{ id: "p".repeat(32), name: "del-target" }]);
    const listed = await body(await h.call("/monitors"));
    expect(listed[0].positions).toEqual(created.positions);
  });

  it("carries the links on a combo it has just linked by its legs", async () => {
    // a combo links by its LEGS and never by its own name, so its reply is the one place the
    // linkage is least guessable from the request
    h = harness();
    seedPosition("p".repeat(32), "wing", "2026-12-18", 8100);
    const created = await body(await post(combo({ strike_date: "2026-12-18" })));
    expect(created.positions).toEqual([{ id: "p".repeat(32), name: "wing" }]);
  });

  it("carries the links when a monitor is patched", async () => {
    // an edit does not change the links, which is exactly why the reply must still state them:
    // a client that re-renders a row from the PATCH response would otherwise lose the holding's
    // name and its leg badge until the next poll
    h = harness();
    seedPosition("p".repeat(32), "del-target", "2026-12-18", 6500);
    const payload = single({ strike_date: "2026-12-18", strike: 6500, threshold: 0.2 });
    const created = await body(await post(payload));
    // spelled out rather than compared to `created.positions`: two empty arrays are equal, so
    // that comparison passes while every reply is wrong — the shape of a vacuous assertion
    const linked = [{ id: "p".repeat(32), name: "del-target" }];
    expect((await body(await patch(created.id, { threshold: 0.3 }))).positions).toEqual(linked);
  });

  it("takes the links with it when the monitor goes, and leaves the position", async () => {
    // deleting the monitor first raised FOREIGN KEY constraint failed for every row in the live
    // database, because every one of them is linked (#70). A Position is a holding: it exists
    // whether or not anything watches it (ADR 0001).
    h = harness();
    seedPosition("p".repeat(32), "del-target", "2026-12-18", 6500);
    const created = await body(await post(single({ strike_date: "2026-12-18", strike: 6500, threshold: 0.2 })));
    expect(linkCount(created.id)).toBe(1);

    expect((await h.call(`/monitors/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect(linkCount(created.id)).toBe(0);
    expect(h.db.prepare("select name from positions").get()).toMatchObject({ name: "del-target" });
  });

  it("leaves the monitor and its links alone when the delete cannot finish", async () => {
    // DELETE is now the only handler in this file wrapping two writes in `atomic`, and the
    // route-level proof that it is one fact went with PUT in #199 — that handler's own rollback
    // test was where it lived. `db/open.test.ts` proves `atomic` rolls back; this proves this
    // route uses it, which is a different claim and the one that can rot.
    //
    // The links must go before the row or the foreign key refuses (#70). A half-applied delete in
    // the other order is the worse half: a monitors row gone with its links behind it, or the
    // links cleared while the rule stays — a rule that would then report no holding, no entry and
    // no P&L for a position the trader still owns.
    //
    // The failure is injected in SQLite rather than by mocking, so what is proved is the handler's
    // transaction and not a stand-in for it.
    h = harness();
    seedPosition("p".repeat(32), "keep-me", "2026-12-18", 6500);
    const created = await body(await post(single({ strike_date: "2026-12-18", strike: 6500, threshold: 0.2 })));
    expect(linkCount(created.id)).toBe(1);

    h.db.exec(`create trigger no_delete before delete on monitors
               begin select raise(abort, 'delete refused'); end`);
    expect((await h.call(`/monitors/${created.id}`, { method: "DELETE" })).status).toBe(500);

    // the row is still there AND still linked: the clear that ran first was rolled back with it
    expect(h.db.prepare("select id from monitors where id = ?").get(created.id)).toBeDefined();
    expect(linkCount(created.id)).toBe(1);

    // and with the trigger gone the same delete goes through, which says the 500 was the
    // trigger's doing and not a monitor left in a state that refuses every further write
    h.db.exec("drop trigger no_delete");
    expect((await h.call(`/monitors/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect(linkCount(created.id)).toBe(0);
  });

  it("links nothing when no position holds the contract", async () => {
    // watching a strike you have no position in is legitimate; it simply has no entry and no P&L
    h = harness();
    const created = await body(await post(single()));
    expect(linkCount(created.id)).toBe(0);
    expect(created.scope).toBeNull();
    expect(created.positions).toEqual([]);
  });

  it("links nothing when two positions hold the same contract", async () => {
    // rolling a spread can leave the old and the new sharing a strike for a day, and the entry is
    // then genuinely ambiguous. A wrong P&L is worse than an absent one.
    h = harness();
    seedPosition("a".repeat(32), "old", "2026-12-18", 6500);
    seedPosition("b".repeat(32), "new", "2026-12-18", 6500);
    const created = await body(await post(single({ strike_date: "2026-12-18", strike: 6500, threshold: 0.2 })));
    expect(linkCount(created.id)).toBe(0);
    expect(created.scope).toBeNull();
  });

});

describe("/quotes", () => {
  it("is empty with nothing enabled, and does not call OpenD at all", async () => {
    let calls = 0;
    h = harness({ fetchQuotes: (codes) => { calls += 1; return Promise.resolve(codes.map((c) => ({ code: c }))); } });
    expect(await body(await h.call("/quotes"))).toEqual([]);
    expect(calls).toBe(0);
  });

  it("carries each monitor's own quote and threshold", async () => {
    h = harness();
    await post(single());
    const code = (await body(await h.call("/monitors")))[0].code;
    h.close();

    h = harness({ fetchQuotes: quoting({ [code]: { name: "X", option_delta: 0.33 } }) });
    await post(single());
    const quotes = await body(await h.call("/quotes"));
    expect(quotes).toHaveLength(1);
    expect(quotes[0].quote.option_delta).toBe(0.33);
    expect(quotes[0].threshold).toBe(0.6);
    expect(quotes[0].dte).toBe(30);
  });

  it("carries the figures a rule's sentence reads, which the reply schema would strip", async () => {
    // `.parse()` drops whatever EntryOut does not list, so a figure computed in the service and
    // left out of the schema vanishes on the way out with nothing failing (ADR 0023's sentence:
    // "spread value ≥ 6.01 — now 2.00, 4.01 away", and the spread a leg's rule sits under)
    h = harness({
      fetchQuotes: (codes) => Promise.resolve(
        codes.map((code) => ({ code, option_delta: 0.45, mid_price: 2 })),
      ),
    });
    const leg = (await body(await post(single({ strike: 8100, threshold: 0.6 })))).id;
    const spread = (await body(await post(combo({ field: "mid_price" })))).id;
    const quotes = await body(await h.call("/quotes"));

    const row = quotes.find((q: { id: string }) => q.id === leg);
    expect(row.watched).toBe(0.45);
    expect(row.distance).toBeCloseTo(0.15, 12);
    expect(row.in_combos).toEqual([spread]);
    // 2.00 less 2.00 is nothing, below a threshold of 10: breached, and 10 past it
    const sum = quotes.find((q: { id: string }) => q.id === spread);
    expect([sum.watched, sum.distance, sum.triggered, sum.in_combos]).toEqual([0, -10, true, []]);
  });

  it("says whether a rule watches anything held, even where no link names the holding", async () => {
    // a roll day: two holdings share the short call, so the link declines to name either — and
    // the reply schema would strip `held` as it strips any field it does not list
    h = harness();
    for (const [id, name] of [["a".repeat(32), "old"], ["b".repeat(32), "new"]]) {
      h.db.prepare(
        `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
         values (?, ?, 'credit_spread', ?, 1, 2.0, ?, '2026-09-24 02:58:57.456253')`,
      ).run(id!, name!, future(), JSON.stringify([{ side: "short", option_type: "CALL", strike: 6500 }]));
    }
    await post(single());
    await post(single({ strike: 6550 }));
    const quotes = await body(await h.call("/quotes"));
    expect(quotes.map((q: { positions: unknown[]; held: boolean }) => [q.positions.length, q.held]))
      .toEqual([[0, true], [0, false]]);
  });

  it("keeps every row when one rule's reading cannot be written as JSON", async () => {
    // a field the quote schema does not type passes through, so its Infinity reached `watched`
    // and the reply schema refused the whole watchlist: one row's figure took down every row
    h = harness({
      fetchQuotes: (codes) => Promise.resolve(codes.map((code) => ({
        code, option_delta: 0.45, option_open_interest: Infinity,
      }))),
    });
    await post(single());
    const far = (await body(await post(single({
      strike: 6550, field: "option_open_interest", threshold: 1000,
    })))).id;
    const resp = await h.call("/quotes");
    expect(resp.status).toBe(200);
    const quotes = await body(resp);
    expect(quotes).toHaveLength(2);
    const row = quotes.find((q: { id: string }) => q.id === far);
    expect([row.watched, row.distance, row.fill, row.triggered]).toEqual([null, null, 100, true]);
  });

  it("answers 502 rather than 500 when the Provider call fails", async () => {
    h = harness({ fetchQuotes: echoThenFail() });
    await post(single());
    const resp = await h.call("/quotes");
    expect(resp.status).toBe(502);
    expect((await body(resp)).detail).toMatch(/moomoo call failed/);
  });

  it("names the Provider that failed, whichever one this deployment reads", async () => {
    // the dashboard prints this `detail` verbatim, and it said "OpenD call failed" whatever was
    // answering — the same leak ADR 0018 corrected in `verifyContracts` and the sweeper's
    // degraded default corrected again. A sentence naming one vendor is wrong the moment
    // OPTIONALITY_PROVIDER names another.
    h = harness({ providerName: "ibkr", fetchQuotes: echoThenFail() });
    await post(single());
    const detail = (await body(await h.call("/quotes"))).detail as string;
    expect(detail).toMatch(/^ibkr call failed/);
    expect(detail, "never the vendor it is not").not.toMatch(/OpenD/);
  });

  it("excludes a disabled monitor", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    await patch(id, { enabled: false });
    expect(await body(await h.call("/quotes"))).toEqual([]);
  });
});

/** Lets the creation probe through, then fails the watchlist call. */
function echoThenFail() {
  let first = true;
  return (codes: string[]) => {
    if (first) {
      first = false;
      return Promise.resolve(codes.map((code) => ({ code })));
    }
    return Promise.reject(new Error("quota exceeded"));
  };
}

describe("/monitors/:id/total-entry", () => {
  it("is a 404 for a rule that does not exist", async () => {
    h = harness();
    const resp = await h.call("/monitors/nope/total-entry", json({ entry: 1.0 }));
    expect(resp.status).toBe(404);
    expect(await body(resp)).toEqual({ detail: "monitor not found" });
  });

  it("is a 422 for a rule with no holdings attached", async () => {
    h = harness();
    const id = (await body(await post(single({ strike: 8100 })))).id;
    const resp = await h.call(`/monitors/${id}/total-entry`, json({ entry: 3.21 }));
    expect(resp.status).toBe(422);
    expect((await body(resp)).detail).toBe("no holdings attached to this rule");
  });

  it("records the derived credit and answers ok", async () => {
    h = harness();
    // a condor: two spreads, a rule over the calls alone, and one spanning both (ADR 0004)
    const seed = (id: string, name: string, entry: number | null, legs: unknown[]) =>
      h.db.prepare(
        `insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
         values (?, ?, 'credit_spread', '2026-12-18', 1, ?, ?, '2026-08-01 00:00:00.000000')`,
      ).run(id, name, entry, JSON.stringify(legs));
    // each wing holds BOTH its legs, so the rule over the calls covers it exactly and derives
    // scope "all". The Python's version of this test forges that scope by writing the Monitor
    // directly; going through the API means it is computed, and computed from the legs.
    seed("c".repeat(32), "calls", 2.87, [
      { side: "short", option_type: "CALL", strike: 8050 },
      { side: "long", option_type: "CALL", strike: 8075 },
    ]);
    seed("p".repeat(32), "puts", null, [
      { side: "short", option_type: "PUT", strike: 7100 },
      { side: "long", option_type: "PUT", strike: 7075 },
    ]);

    const wing = await body(await post(combo({
      name: "calls_rule", strike_date: "2026-12-18",
      legs: [
        { sign: 1, option_type: "CALL", strike: 8050 },
        { sign: -1, option_type: "CALL", strike: 8075 },
      ],
    })));
    expect(wing.scope).toBe("all"); // covers the calls wing exactly, so its credit is editable
    const span = (await body(await post(combo({
      name: "span_rule", strike_date: "2026-12-18",
      legs: [
        { sign: 1, option_type: "CALL", strike: 8050 },
        { sign: 1, option_type: "PUT", strike: 7100 },
      ],
    })))).id;
    const resp = await h.call(`/monitors/${span}/total-entry`, json({ entry: 3.21 }));
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({ ok: true });
    const puts = h.db.prepare("select entry from positions where name = 'puts'").get() as { entry: number };
    expect(puts.entry).toBeCloseTo(0.34, 10);
  });

  it("rejects a payload with no entry at all", async () => {
    h = harness();
    const id = (await body(await post(single()))).id;
    expect((await h.call(`/monitors/${id}/total-entry`, json({}))).status).toBe(422);
  });
});
