/** A slow Reference source must not delay the watchlist (ADR 0018, amended by measurement).
 *
 *  The strip is a BACKDROP: `/references` makes one bounded call per source, and a source that
 *  accepts a request and never answers it costs the whole of the client's `requestTimeoutMs`.
 *  Measured on 2026-11-10 against the live service: `/references` took 8.00s on every call while
 *  `/quotes` took 0.02s, because a gateway entitled to live data grants LIVE for an index that is
 *  not calculated out of hours — so it accepts the request and says nothing.
 *
 *  `App.tsx` loaded all four inside one `Promise.all`, with `setQuotes` after the await, so that
 *  8 seconds was the page's whole first paint. The `.catch` on the References already said "a
 *  backdrop must never be able to blank the page" — it stopped a REFUSAL doing that and never a
 *  DELAY, which is the half the containment did not cover. A dead vendor dashes its own rows and
 *  nobody else's; a slow one blanked everybody's.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const row = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 50, scope: null, positions: [], cost_to_close: null, entry: null,
  pnl: null, schedule: null, quote: { name: "SPXW 261120 8100.00C", option_delta: 0.1 },
};

const SPX = {
  id: "r1", code: "SPX", label: "SPX", source: "ibkr", name: null,
  figure: 7376.86, field: "last_price", change: 0.0031, error: null,
};

/** The References never settle until this is called — the 8-second gateway, without the wait. */
let releaseReferences: (rows: unknown[]) => void;

function mockApi(quotes: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/references")) {
      return new Promise<Response>((resolve) => {
        releaseReferences = (rows) => resolve(
          { ok: true, json: () => Promise.resolve(rows) } as Response);
      });
    }
    return {
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? quotes
          : url.endsWith("/monitors") ? []
            : url.includes("/positions") ? []
              : health),
    } as Response;
  }));
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const settled = async () => { await act(async () => { await Promise.resolve(); }); };

describe("a Reference source that never answers", () => {
  it("does not stop the watchlist being drawn", async () => {
    mockApi([row]);
    render(<App />);
    await settled();
    await settled();
    // the References are STILL in flight — nothing has released them, and the row is drawn anyway
    expect(screen.getByText("261120 8100C")).toBeTruthy();
    expect(screen.getByText("delta ≥ 0.2")).toBeTruthy();
  });

  it("leaves the strip absent until its figures arrive, rather than blanking the page", async () => {
    mockApi([row]);
    render(<App />);
    await settled();
    await settled();
    expect(screen.queryByText("SPX (ibkr)")).toBeNull();   // no strip yet
    expect(screen.getByText("261120 8100C")).toBeTruthy();  // but the watchlist is there

    releaseReferences([SPX]);
    await settled();
    await settled();
    expect(screen.getByText("SPX (ibkr)")).toBeTruthy();   // and it appears when it arrives
  });

  it("still shows the watchlist when the References REFUSE, which is what already worked", async () => {
    // the half the old `.catch` covered. Kept as a test so the fix cannot regress it while
    // fixing the other half.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/references")) throw new Error("yahoo unreachable");
      return {
        ok: true,
        json: () => Promise.resolve(
          url.endsWith("/quotes") ? [row]
            : url.endsWith("/monitors") ? []
              : url.includes("/positions") ? []
                : health),
      } as Response;
    }));
    render(<App />);
    await settled();
    await settled();
    expect(screen.getByText("261120 8100C")).toBeTruthy();
    expect(screen.queryByText("SPX (ibkr)")).toBeNull();
  });
});

describe("two Reference calls in flight at once", () => {
  it("shows the NEWER figures even when the older call answers last", async () => {
    // Splitting the References out of the poll lets two be in flight at once: at 8 seconds a call
    // and a 15-second interval, that is one slow poll away. The last to ARRIVE is then not the
    // most recent, and a stale set drawn over a fresh one is precisely "figures the strip cannot
    // vouch for" — the thing ADR 0018 built this feature around.
    const pending: ((rows: unknown[]) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/references")) {
        return new Promise<Response>((resolve) => {
          pending.push((rows) => resolve(
            { ok: true, json: () => Promise.resolve(rows) } as Response));
        });
      }
      return {
        ok: true,
        json: () => Promise.resolve(
          url.endsWith("/quotes") ? [row]
            : url.endsWith("/monitors") ? []
              : url.includes("/positions") ? []
                : health),
      } as Response;
    }));

    vi.useFakeTimers();
    render(<App />);
    await vi.advanceTimersByTimeAsync(0);        // poll 1 starts
    await vi.advanceTimersByTimeAsync(15_000);   // the interval fires: poll 2 starts
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.length, "two Reference calls should be in flight").toBeGreaterThanOrEqual(2);

    // the SECOND poll answers first, with the current figure
    pending[1]!([{ ...SPX, figure: 7549.94 }]);
    await vi.advanceTimersByTimeAsync(0);
    // then the FIRST poll answers, with a figure that is now stale
    pending[0]!([{ ...SPX, figure: 7376.86 }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("7,549.94"), "the stale set overwrote the fresh one").toBeTruthy();
    expect(screen.queryByText("7,376.86")).toBeNull();
  });
});
