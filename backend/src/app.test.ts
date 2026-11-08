/** The app itself: what is open, what needs a token, and what /health reports.
 *
 *  Ported from tests/test_app.py (ADR 0009, phase 5). One of its four tests does not come across:
 *  `test_root_path_prefixes_openapi_url_for_reverse_proxy` asserts that FastAPI's /docs page points
 *  at a prefixed openapi.json. Hono served no such page, so the port recorded it as a gap; since
 *  /docs was added, the test lives in openapi.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GOLDEN_CASES } from "./golden.ts";
import { type Harness, body, harness } from "../testing/harness.ts";

let h: Harness;
const start = (...args: Parameters<typeof harness>) => (h = harness(...args));
afterEach(() => h?.close());

describe("/health", () => {
  it("is open, and reports status rather than raising", async () => {
    const resp = await start().call("/health", { anonymous: true });
    expect(resp.status).toBe(200);
    const data = await body(resp);
    expect(data.db).toBe(true);
    // the Provider names itself: the dashboard said "OpenD" whatever was actually behind the
    // port, and a second Provider would have made that a lie on screen (#169)
    expect(data.provider).toEqual({ name: "moomoo", ok: false }); // nothing listens on the test port
  });

  it("reports the name of whichever Provider answered, not the one it was written against", async () => {
    // the route must read the Provider's own name: hard-coding "moomoo" here would pass every
    // other test in this file and put the wrong vendor on the dashboard the day a second one lands
    const data = await body(await start({ providerName: "ibkr" }).call("/health", { anonymous: true }));
    expect(data.provider.name).toBe("ibkr");
  });

  /** The one field a notebook reads rather than the dashboard (ADR 0016).
   *
   *  `python/`'s port is held to the TypeScript by the golden cases, but only at the moment it is
   *  written. A notebook pins a tag and keeps it for months, so the staleness it cannot otherwise
   *  see is "the engine has moved since my port was cut". This is how it finds out: the running
   *  service states which cases it IS, and `optionality.api.agrees` compares.
   */
  it("carries the fingerprint of the golden cases, for a port to compare itself against", async () => {
    const data = await body(await start().call("/health", { anonymous: true }));
    // the generated constant, not a literal: a copy here would agree with a stale port forever
    expect(data.golden_cases).toBe(GOLDEN_CASES);
    expect(data.golden_cases).toMatch(/^[0-9a-f]{12}$/);
  });

  it("reports the last fetch for the Provider, not a port that merely accepts", async () => {
    // 2026-10-16: OpenD held the socket open and would not log in. The probe said true, every
    // OpenD-backed route returned 502, and the dashboard showed a green light for a gateway the
    // service could not speak to. What the last batch actually did is the only honest answer, and
    // it costs no extra call.
    const h2 = start({ opend: true });
    h2.sweeper.fetchOk = false;
    const data = await body(await h2.call("/health", { anonymous: true }));
    expect(data.provider.ok).toBe(false);
  });

  it("falls back to the port probe only while nothing has been fetched yet", async () => {
    // a service that has not asked yet cannot report what asking would do, and "unknown" is not one
    // of the two values this field has
    const h2 = start({ opend: true });
    expect(h2.sweeper.fetchOk).toBeNull();
    const data = await body(await h2.call("/health", { anonymous: true }));
    expect(data.provider.ok).toBe(true);
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

  it("serves exactly these doors, and no others", () => {
    // The API's whole surface, stated. It is here because the two routes #199 removed — PUT
    // /monitors/:id and GET /spx/quote — had no caller in the dashboard, the bot or the Python
    // package, and nothing but prose said what the surface was meant to be. A route nothing calls
    // is a route nothing exercises; this is what makes adding or removing one a decision rather
    // than a diff nobody reads.
    start();
    const served = h.app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(served)].sort()).toEqual([
      "DELETE /monitors/:id",
      "DELETE /positions/:id",
      "DELETE /references/:id",
      "GET /docs",
      "GET /health",
      "GET /monitors",
      "GET /openapi.json",
      "GET /positions",
      "GET /positions/:id/vol",
      "GET /positions/values",
      "GET /quotes",
      "GET /references",
      "PATCH /monitors/:id",
      "PATCH /positions/:id",
      "POST /monitors",
      "POST /monitors/:id/total-entry",
      "POST /positions",
      "POST /references",
    ]);
  });

  it("guards every route except /health and the docs", async () => {
    start();
    // Derived from the router rather than remembered. The hand-written list this replaces named
    // /spx/quote, and when that route was removed the probe went on passing — the auth middleware
    // runs BEFORE routing, so an anonymous call to a path the app no longer serves still answers
    // 401. A list of paths is the one shape of this test that cannot tell "guarded" from "gone".
    //
    // /quotes was missing from the first version of that list, which a code review caught — the
    // dashboard's main poll and the one route here that triggers a live Provider batch, so exactly
    // the one worth guarding.
    //
    // Every METHOD, not only GET: the filter here read `r.method === "GET"` until this was widened,
    // which left the three DELETEs, both PATCHes and the four POSTs — every write the API has —
    // probed by nothing at all. The auth middleware could have been weakened on all of them with
    // the suite green. Each write is probed with its own verb and no body, because auth runs
    // before routing and before validation: a 401 is the answer whatever the body would have been.
    const open = ["/health", "/openapi.json", "/docs"];
    const doors = [...new Map(h.app.routes
      .filter((r) => r.method !== "ALL" && !open.includes(r.path))
      .map((r) => {
        const path = r.path.replace(/:(\w+)/g, "x");
        return [`${r.method} ${path}`, { method: r.method, path }] as const;
      })).entries()];
    // the real number of doors, which the route list above enumerates one by one
    expect(doors.length).toBe(15);
    for (const [door, { method, path }] of doors) {
      expect((await h.call(path, { anonymous: true, method })).status, door).toBe(401);
    }
    for (const path of open) {
      expect((await h.call(path, { anonymous: true })).status, path).toBe(200);
    }
  });
});

describe("a refusal in the log", () => {
  /** A rejected write left no trace on the service at all.
   *
   *  2026-10-19: a holding would not record, and there was no way to tell from this side whether
   *  the request had even arrived — `onError` formats the {detail} body and returns it without a
   *  word, and a 401 from the auth middleware never reaches `onError` in the first place. The only
   *  way to split "the browser never sent it" from "the service refused it" was to probe the API
   *  by hand.
   */
  it("names the method, the path and the status of a refusal it threw", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
    try {
      start();
      await h.call("/positions", {
        method: "POST", body: JSON.stringify({ name: 1 }),
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      spy.mockRestore();
    }
    const lines = seen.filter((l) => l.includes("422"));
    expect(lines.length, `expected exactly one 422 line; saw ${JSON.stringify(seen)}`).toBe(1);
    expect(lines[0]).toContain("POST");
    expect(lines[0]).toContain("/positions");
    expect(lines[0], "and what was wrong with it").toContain("detail");
  });

  it("names one a route THREW, which is a different path through the app", async () => {
    // httpError/notFound throw an HTTPException that onError turns into the {detail} body. A
    // mutation sweep showed the other two cases here are both RETURNED — `valid()` answers 422
    // itself — so without this the thrown path was logged by nothing and nothing noticed.
    const seen: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
    try {
      start();
      await h.call("/positions/ghost/vol");
    } finally {
      spy.mockRestore();
    }
    const lines = seen.filter((l) => l.includes("404"));
    expect(lines.length, `expected exactly one 404 line; saw ${JSON.stringify(seen)}`).toBe(1);
    expect(lines[0]).toContain("/positions/ghost/vol");
    expect(lines[0], "and why").toContain("position not found");
  });

  it("names one it merely returned, which never passes through onError", async () => {
    // the auth middleware answers 401 with c.json rather than by throwing
    const seen: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
    try {
      start();
      await h.call("/positions", { anonymous: true });
    } finally {
      spy.mockRestore();
    }
    const line = seen.find((l) => l.includes("401"));
    expect(line, `nothing logged a 401; saw ${JSON.stringify(seen)}`).toBeTruthy();
    expect(line).toContain("GET");
  });

  it("says nothing at all about a request that succeeded", async () => {
    // the log is read by eye during an incident; a line per poll would bury the one that matters
    const seen: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
    try {
      start();
      await h.call("/health", { anonymous: true });
    } finally {
      spy.mockRestore();
    }
    expect(seen.filter((l) => l.includes("/health"))).toEqual([]);
  });

  it("names a write that SUCCEEDED, because a refusal is not the only thing worth seeing", async () => {
    // 2026-10-19, the second half of the same incident: with refusals logged, a press to record the
    // 11-30 spread still produced no line and no row. "The service refused nothing" and "the
    // service was never asked" then read identically, so the log still could not say whether the
    // browser had sent anything. A write is rare and owner-initiated — the flood the comment above
    // guards against is GETs — so every write says so, whatever its status.
    const seen: string[] = [];
    const out = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    });
    try {
      start();
      const resp = await h.call("/positions", {
        method: "POST",
        body: JSON.stringify({
          name: "1130_BS_6950", strike_date: "2026-11-30", contracts: 1, entry: 2.35,
          legs: [
            { side: "short", option_type: "PUT", strike: 6950 },
            { side: "long", option_type: "PUT", strike: 6900 },
          ],
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(resp.status, await resp.text()).toBe(201);
    } finally {
      out.mockRestore();
    }
    const line = seen.find((l) => l.includes("/positions"));
    expect(line, `nothing logged the write; saw ${JSON.stringify(seen)}`).toBeTruthy();
    expect(line).toContain("POST");
    expect(line).toContain("201");
  });

  it("still says nothing about a GET that succeeded, which is the flood", async () => {
    const seen: string[] = [];
    const spies = [
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(" ")); }),
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(" ")); }),
    ];
    try {
      start();
      await h.call("/monitors");
      await h.call("/health", { anonymous: true });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(seen).toEqual([]);
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
