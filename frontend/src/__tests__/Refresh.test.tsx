import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** The manual refresh.
 *
 *  The dashboard's figures come from `/quotes`, which is a LIVE call — so this button is not a
 *  repaint, it is a market data fetch. That is why it guards against overlapping itself and why
 *  it restarts the poll clock: a click one second before an automatic poll would otherwise cost
 *  two full-watchlist snapshots a second apart.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};
const wing = {
  id: "m1", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all", positions: [{ id: "p1", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 }], combo_value: -0.8, combo_greeks: {},
};

let quoteCalls = 0;
/** `hold` lets a test keep a fetch in flight, which is the only way to see the in-flight guard. */
function mockApi(hold?: { promise: Promise<void> }) {
  quoteCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/quotes")) {
      quoteCalls++;
      if (hold) await hold.promise;
    }
    return {
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? [wing] : url.endsWith("/monitors") ? [] : health),
    } as Response;
  }));
}

// no jest-dom matchers in this suite, so the property is read directly
const button = () => screen.getByRole("button", { name: "refresh now" }) as HTMLButtonElement;

afterEach(() => { vi.useRealTimers(); });

describe("the refresh button", () => {
  it("fetches at once, without waiting for the poll", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(quoteCalls).toBe(1));

    fireEvent.click(button());
    // no timers advanced: the automatic poll is fifteen seconds away
    await waitFor(() => expect(quoteCalls).toBe(2));
  });

  it("will not stack a second fetch on an unfinished one", async () => {
    // every one of these is a full-watchlist OpenD snapshot, so a double click must cost one
    let release!: () => void;
    const hold = { promise: new Promise<void>((r) => { release = r; }) };
    mockApi(hold);
    render(<App />);
    await waitFor(() => expect(quoteCalls).toBe(1));

    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    fireEvent.click(button());
    fireEvent.click(button());
    expect(quoteCalls).toBe(2);

    release();
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("restarts the poll clock, so a click just before a tick does not cost two fetches", async () => {
    vi.useFakeTimers();
    mockApi();
    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    expect(quoteCalls).toBe(1);

    // one second short of the 15s poll
    await vi.advanceTimersByTimeAsync(14_000);
    expect(quoteCalls).toBe(1);

    fireEvent.click(button());
    await vi.advanceTimersByTimeAsync(0);
    expect(quoteCalls).toBe(2);

    // the second that remained of the old interval must no longer be owed
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quoteCalls, "the old interval fired on top of the manual refresh").toBe(2);

    // and the poll still works afterwards
    await vi.advanceTimersByTimeAsync(15_000);
    expect(quoteCalls, "the poll stopped after a manual refresh").toBe(3);
  });
});
