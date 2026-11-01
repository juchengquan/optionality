import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, beingOperated } from "../App";

/** The poll's cadence, and what is allowed to stop it.
 *
 *  NOTE on fake timers: they must be installed BEFORE render. `setInterval` captured at render
 *  time under real timers is not controlled by a later `useFakeTimers()`, and advancing then does
 *  nothing — which looks exactly like a poll that never fires. That artifact cost me a wrong
 *  diagnosis of this very bug, so it is written down here.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
let quoteCalls = 0;
function mockApi() {
  quoteCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/quotes")) quoteCalls++;
    return {
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? []
          : url.endsWith("/monitors") ? []
            : url.includes("/positions") ? []
              : health),
    } as Response;
  }));
}
afterEach(() => { vi.useRealTimers(); document.cookie = "ui_refresh=;path=/"; });

describe("changing the interval", () => {
  it("polls at the chosen cadence rather than the old one", async () => {
    vi.useFakeTimers();
    mockApi();
    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    expect(quoteCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await vi.advanceTimersByTimeAsync(0);
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("refresh every"), { target: { value: "60" } });
    expect(document.cookie, "and remembers it").toContain("ui_refresh=60");
    fireEvent.click(within(sheet).getByRole("button", { name: /close/i }));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(quoteCalls, "it kept polling at 15s").toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(quoteCalls, "it never polled at 60s").toBe(2);
  });

  /** A cadence chosen on an earlier visit, which is the half this suite did not state.
   *
   *  The test above proves a choice made NOW takes effect; nothing proved the stored one was read
   *  at all. A mutation sweep showed it: replacing `readRefresh(sweep_seconds)` with
   *  `sweep_seconds` — ignoring the cookie outright — left all 318 tests green. The default is
   *  deliberately the service's own sweep cadence, so the two are only distinguishable when they
   *  disagree, which is what this sets up.
   */
  it("polls at the cadence remembered from an earlier visit, not the service's", async () => {
    document.cookie = "ui_refresh=60;path=/";
    vi.useFakeTimers();
    mockApi();
    render(<App />);
    // `act` round the first flush, unlike the tests either side of this one: the cadence here is
    // set by /health LANDING rather than by a click, and an update React was not told about is
    // committed whenever it likes — measured, the 15s interval the page starts with survived long
    // enough to fire once at exactly 15s before the 60s one replaced it. The press-driven tests
    // need none of this because fireEvent acts for them.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quoteCalls).toBe(1);

    // the service sweeps every 15s, so a page that ignored the cookie would have polled by now
    await vi.advanceTimersByTimeAsync(20_000);
    expect(quoteCalls, "it fell back to the service's 15s").toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(quoteCalls, "it never polled at the remembered 60s").toBe(2);
  });

  it("keeps polling while a sheet is merely open, so its figures do not freeze", async () => {
    /** The detail sheet re-reads its row from the live list for exactly this reason, and the
     *  Service panel is the only place the cadence can be set — "I chose 30 seconds and watched
     *  nothing happen" has no other explanation left once the clock itself is proven. A focused
     *  INPUT still holds the poll, wherever it lives; an open sheet on its own does not.
     */
    vi.useFakeTimers();
    mockApi();
    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await vi.advanceTimersByTimeAsync(0);
    const sheet = screen.getByRole("dialog");
    // the panel's own focus behaviour is what broke this: in a real browser the trap lands on
    // `flag on`, and the guard read that as an edit in progress. Focused here deliberately, so
    // the test states the case it is about rather than depending on jsdom's focus handling.
    (within(sheet).getByLabelText("flag on") as HTMLElement).focus();
    expect(beingOperated(document.activeElement), "focus is not editing").toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(quoteCalls, "an open sheet stopped the poll").toBeGreaterThan(1);
  });
});
