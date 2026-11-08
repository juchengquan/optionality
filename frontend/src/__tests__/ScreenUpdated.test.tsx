import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** When this SCREEN last fetched, which is not when the service last did.
 *
 *  2026-10-20: "refresh immediately does not work". The clock was fine — what was missing was any
 *  evidence of it. The one timestamp on the page is `fetched_at`, the SWEEP's, which moves on the
 *  service's own cadence whatever the dashboard does; and with the market shut no figure on the
 *  page moves at all, so pressing refresh changed nothing a reader could see. A fetch that leaves
 *  no trace is indistinguishable from a button that does nothing.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-10-20 00:04:37+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-10-20 00:04:37+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
function mockApi() {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? []
          : url.endsWith("/references") ? [] : url.endsWith("/monitors") ? [] : url.includes("/positions") ? [] : health),
    } as Response)));
}
afterEach(() => { vi.useRealTimers(); });

const line = () => screen.getByText(/screen updated/i).textContent ?? "";

/** Drain microtasks until the first fetch has painted, under fake timers.
 *
 *  One `advanceTimersByTimeAsync(0)` is not enough, and that is the whole flake: measured over
 *  repeated runs, the first paint needs ONE drain or TWO depending on how the fetch's two promises
 *  (the response, then `json()`) interleave with React's commit. The test did exactly one, so it
 *  failed about one run in three — `getByText` threw "unable to find element", which reads like a
 *  component that never rendered rather than a wait that was one tick short.
 *
 *  Chased for a while as a timezone problem and then recorded as undiagnosed, because it never
 *  reproduced in the full suite — file order changes the interleaving. Bounded rather than a
 *  `while (true)`: a genuinely absent line must still fail the test, not hang the suite.
 */
const painted = async () => {
  for (let i = 0; i < 20 && screen.queryByText(/screen updated/i) === null; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
};

describe("what the page says about its own freshness", () => {
  it("says when it last fetched, beside what the service says", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(line()).toMatch(/screen updated \d{1,2}:\d{2}:\d{2}/));
    // and the service's own figure stays, worded distinctly: it is the one that says how fresh
    // the FIGURES are, where this one says only how recently they reached the screen
    expect(line()).toContain("00:04:37");
  });

  it("moves when the refresh button is pressed, which is the whole point", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T00:10:00+08:00"));
    mockApi();
    render(<App />);
    await painted();
    const before = line();

    vi.setSystemTime(new Date("2026-10-20T00:11:07+08:00"));
    fireEvent.click(screen.getByRole("button", { name: "refresh now" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(line(), `it still reads ${before}`).not.toBe(before);
  });

  it("says nothing of the kind before the first fetch lands", async () => {
    // a time written before anything was fetched would be a claim about data that is not there
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.queryByText(/screen updated/i)).toBeNull();
  });
});
