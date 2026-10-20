import { cleanup, render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** The badge sits in the FROZEN identity column, which is the one place on this page where width
 *  is genuinely scarce (ADR 0008's budget, and app.css's cap: "a frozen column occupies its width
 *  at EVERY scroll position").
 *
 *  Two things cannot be proven in jsdom, which reports every element as zero wide:
 *    - the badge is drawn inside its own cell rather than spilling over the figures beside it,
 *      which `white-space: nowrap` on a capped sticky cell is exactly how you get;
 *    - adding it does not hand the identity column a bigger share of a phone screen, undoing
 *      the cap that bought back two columns at a time.
 *  Both are the kind of fault a green unit suite says nothing about.
 */
const health = {
  db: true, opend: true,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const held = { id: "p1", name: "1130_8100" };

/** The owner's own pair: an adjacent call spread sharing the 8150 leg, which is what turned
 *  1130_8150 into a leg rule the moment 1130_8100 was recorded (2026-10-20). */
const legRow = {
  id: "m1", code: "1130_8150", field: "mid_price", threshold: 2.49, direction: "above",
  compare: "abs", triggered: false, strike_date: "2026-11-30", option_type: "CMB",
  dte: 41, fill: 61, scope: "leg", positions: [held],
  cost_to_close: null, entry: null, pnl: null, schedule: null, quote: null,
  combo_value: -3.05, combo_greeks: { option_delta: -0.0123, option_vega: -0.18 },
  legs: [{ sign: -1, option_type: "CALL", strike: 8150 }, { sign: 1, option_type: "CALL", strike: 8200 }],
};

/** The widest identity on either table, so the cap is actually binding while the badge is drawn. */
const condor = {
  ...legRow, id: "m2", code: "1120_IC_7100_8200", strike_date: "2026-11-20", dte: 45,
  legs: [
    { sign: -1, option_type: "CALL", strike: 8200 }, { sign: 1, option_type: "CALL", strike: 8250 },
    { sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7050 },
  ],
};

function mockApi(rows: unknown[]) {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? rows : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

async function atWidth(px: number) {
  await page.viewport(px, 900);
  await new Promise((r) => setTimeout(r, 200));
}

function badges(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("td .badge")];
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("the leg badge, measured", () => {
  for (const width of [390, 1280]) {
    it(`stays inside its own cell at ${width}px`, async () => {
      mockApi([legRow, condor]);
      render(<App />);
      await atWidth(width);

      const found = badges();
      expect(found.length, "no badge was drawn, so nothing below was measured").toBe(2);
      for (const badge of found) {
        const cell = badge.closest("td")!;
        const b = badge.getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        expect(b.width, "the badge has no width").toBeGreaterThan(0);
        // the identity cell is sticky: anything past its right edge is painted OVER the
        // figures the row is swiped through, and reads as belonging to whichever column
        // happens to be under it
        expect(Math.round(b.right), `badge spills ${Math.round(b.right - c.right)}px past its cell`)
          .toBeLessThanOrEqual(Math.round(c.right));
      }
    });
  }

  it("does not widen the identity column on a phone", async () => {
    // Measured both ways rather than against a constant: the cap exists to keep the frozen
    // column off the screen's share, and the badge must not buy that back.
    mockApi([legRow, condor]);
    render(<App />);
    await atWidth(390);
    const withBadge = document.querySelector("td")!.getBoundingClientRect().width;

    cleanup();
    mockApi([{ ...legRow, scope: null, positions: [] }, { ...condor, scope: null, positions: [] }]);
    render(<App />);
    await atWidth(390);
    const without = document.querySelector("td")!.getBoundingClientRect().width;

    expect(withBadge, `${withBadge}px with the badge against ${without}px without`)
      .toBeLessThanOrEqual(without);
  });
});
