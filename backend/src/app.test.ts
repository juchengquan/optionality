/** The app itself: what is open, what needs a token, and what /health reports.
 *
 *  Ported from tests/test_app.py (ADR 0009, phase 5). One of its four tests does not come across:
 *  `test_root_path_prefixes_openapi_url_for_reverse_proxy` asserts that FastAPI's /docs page points
 *  at a prefixed openapi.json. Hono served no such page, so the port recorded it as a gap; since
 *  /docs was added, the test lives in openapi.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";

import { type Harness, body, harness } from "./testing.ts";

let h: Harness;
const start = (...args: Parameters<typeof harness>) => (h = harness(...args));
afterEach(() => h?.close());

describe("/health", () => {
  it("is open, and reports status rather than raising", async () => {
    const resp = await start().call("/health", { anonymous: true });
    expect(resp.status).toBe(200);
    const data = await body(resp);
    expect(data.db).toBe(true);
    expect(data.opend).toBe(false); // nothing listens on the test port
    expect(data.queue_depth).toBe(0);
    expect(data.last_run).toBeNull();
  });

  it("reports the last fetch for opend, not a port that merely accepts", async () => {
    // 2026-10-16: OpenD held the socket open and would not log in. The probe said true, every
    // OpenD-backed route returned 502, and the dashboard showed a green light for a gateway the
    // service could not speak to. What the last batch actually did is the only honest answer, and
    // it costs no extra call.
    const h2 = start({ opend: true });
    h2.sweeper.fetchOk = false;
    const data = await body(await h2.call("/health", { anonymous: true }));
    expect(data.opend).toBe(false);
  });

  it("falls back to the port probe only while nothing has been fetched yet", async () => {
    // a service that has not asked yet cannot report what asking would do, and "unknown" is not one
    // of the two values this field has
    const h2 = start({ opend: true });
    expect(h2.sweeper.fetchOk).toBeNull();
    const data = await body(await h2.call("/health", { anonymous: true }));
    expect(data.opend).toBe(true);
  });

  it("no longer carries a contract version, because the compiler has replaced it", async () => {
    // the dashboard used to compare one against its own to decide whether it had been built against
    // the API it was talking to. Since phase 8 it takes its TYPES from the API, so a shape that has
    // moved is a compile error rather than a banner nobody may be looking at.
    const data = await body(await start().call("/health", { anonymous: true }));
    expect("contract_version" in data).toBe(false);
  });

  it("reports the knobs a client cannot guess", async () => {
    const data = await body(await start({
      settings: { monitorIntervalSeconds: 45, expiredRetentionDays: 3, displayTz: "Asia/Singapore" },
    }).call("/health", { anonymous: true }));
    expect(data.settings).toEqual({
      // the manage-by DTE is a knob too, and the dashboard needs it: it is the horizon the
      // watchlist's pressure reading weighs fill against, and a second copy of 21 in the frontend
      // would drift from EXIT_MANAGE_BY_DTE the first time it moved
      manage_by_dte: 21,
      sweep_seconds: 45, expired_retention_days: 3, display_tz: "Asia/Singapore",
    });
  });

  it("says the alarm engine has not swept yet, rather than inventing a time", async () => {
    const data = await body(await start().call("/health", { anonymous: true }));
    expect(data.monitor).toEqual({
      last_sweep_at: null, last_sweep_ok: true, consecutive_failures: 0,
      alarms: { label: "watching", bad: false }, fetched_at: null,
    });
  });

  it("reports the newest run once there is one", async () => {
    start();
    h.db.prepare(
      `insert into runs (id, task_type, config_name, trigger, notify, attempt, status, created_at)
       values (?, 'holdings', 'spx', 'api', 0, 1, 'succeeded', ?)`,
    ).run("a".repeat(32), "2026-08-10 03:35:32.000000");
    const data = await body(await h.call("/health", { anonymous: true }));
    // display converts via DISPLAY_TZ; storage is UTC (CLAUDE.md)
    expect(data.last_run).toEqual({
      id: "a".repeat(32), task_type: "holdings", status: "succeeded",
      created_at: "2026-08-10 11:35:32+08:00",
    });
  });

  it("says so when the database has gone, instead of failing the request", async () => {
    start();
    h.db.close(); // every query from here on throws
    const resp = await h.call("/health", { anonymous: true });
    expect(resp.status).toBe(200);
    expect((await body(resp)).db).toBe(false);
  });
});

describe("the bearer token", () => {
  it("rejects a request without one", async () => {
    const resp = await start().call("/monitors", { anonymous: true });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ detail: "unauthorized" });
  });

  it("rejects a wrong one", async () => {
    const resp = await start().call("/monitors", {
      anonymous: true, headers: { Authorization: "Bearer nope" },
    });
    expect(resp.status).toBe(401);
  });

  it("accepts the right one", async () => {
    expect((await start().call("/monitors")).status).toBe(200);
  });

  it("asks for nothing when no token is configured", async () => {
    // the owner's deployment sets API_TOKEN; a local run without one must still work
    expect((await start({ settings: { apiToken: "" } }).call("/monitors", { anonymous: true })).status)
      .toBe(200);
  });

  it("guards every route except /health", async () => {
    start();
    // every surviving route, not a sample of them: the run-pipeline paths this used to walk were
    // removed, and a list that names paths which no longer exist passes by vacuity.
    //
    // /quotes was missing from the first version of this list, which a code review caught — the
    // dashboard's main poll and the one route here that triggers a live OpenD batch, so exactly
    // the one worth guarding. Derived from app.ts's mounts rather than remembered: /health,
    // /quotes, /monitors*, /positions*, /spx/quote.
    for (const path of [
      "/quotes", "/monitors", "/positions", "/positions/values", "/positions/x/vol", "/spx/quote",
    ]) {
      expect((await h.call(path, { anonymous: true })).status, path).toBe(401);
    }
    expect((await h.call("/health", { anonymous: true })).status).toBe(200);
  });
});

describe("the error shape", () => {
  it("is the {detail} the dashboard reads, on every failure path", async () => {
    start();
    // 404 from a missing row, 422 from a bad payload, 401 from a missing token — all one shape
    const missing = await h.call("/positions/ghost/vol");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "position not found" });

    const bad = await h.call("/positions", {
      method: "POST", body: JSON.stringify({ name: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(422);
    expect(typeof (await body(bad)).detail).toBe("string");
  });
});
