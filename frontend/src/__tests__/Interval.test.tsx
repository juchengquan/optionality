import { fireEvent, render, screen, within } from "@testing-library/react";
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
  db: true, opend: true,
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
