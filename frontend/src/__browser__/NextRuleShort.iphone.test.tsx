/** The phone's rule line in its short form (#388), MEASURED under the iPhone profile at 390px: every
 *  rule line of the owner-shaped book fits on ONE line, in session and with a last reading out of it
 *  ("|val| ≥ 5.51   —  last 3.05 Fri 16:14") — the longest the short form gets. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { settle } from "./nextBook";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

function serve(quotes: object[], monitors: object[] = MONITORS): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? quotes : path === "/monitors" ? monitors
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

afterEach(cleanup);

/** How many lines each drawn rule line takes: an inline box has one client rect per line. */
function lines(): [string, number][] {
  return [...document.querySelectorAll<HTMLElement>(".nxp-sentence .nx-rule-short")]
    .map((el) => [el.textContent!, el.getClientRects().length]);
}

describe("the phone's rule line, short (#388)", () => {
  it("fits on one line at 390px for every rule of the book", async () => {
    expect(window.innerWidth).toBe(390);
    serve(QUOTES);
    render(<Next />);
    await settle();
    const drawn = lines();
    expect(drawn.length).toBeGreaterThan(3);
    console.log(`#388 phone lines: ${JSON.stringify(drawn)}`);
    expect(drawn.filter(([, n]) => n !== 1)).toEqual([]);
  });

  it("and out of the session with no figure, saying the last reading and its New York time", async () => {
    // a Sunday: the page draws the dash, and beside it what the sweep last read in the session
    // (#380) — Friday 16:14 New York — the widest the short form gets
    vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));
    const quiet = QUOTES.map((q) => ({ ...q, threshold: q.field === "mid_price" ? 15.51 : q.threshold,
      watched: null, distance: null, fill: null }));
    const fieldOf = new Map(QUOTES.map((q) => [q.id, q.field]));
    const read = MONITORS.map((m) => ({ ...m, field: fieldOf.get(m.id) ?? m.field,
      last_value: fieldOf.get(m.id) === "mid_price" ? -12.35 : -0.168, last_checked_at: "2026-11-14 05:14:59+08:00" }));
    serve(quiet, read);
    render(<Next />);
    await settle();
    const drawn = lines();
    console.log(`#388 phone lines, out of session: ${JSON.stringify(drawn)}`);
    expect(drawn.some(([t]) => t.includes("last \u221212.35 Fri 16:14"))).toBe(true);
    expect(drawn.filter(([, n]) => n !== 1)).toEqual([]);
  });
});
