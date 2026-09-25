import { render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The name column must stay put while the rest of the row is swiped, or swiping loses the
 *  one thing that says which row you are reading. position:sticky and border-collapse are
 *  famously uneasy together, so this is measured rather than assumed. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const row = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: {
    name: "SPXW 261120 8100.00C", option_delta: 0.1685, option_gamma: 0.00009,
    option_theta: -0.42, option_vega: 0.33, option_implied_volatility: 0.1712,
    mid_price: 31.5, bid_price: 31.3, ask_price: 31.7,
  },
};

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [row] : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

afterEach(async () => { document.body.innerHTML = ""; await page.viewport(1280, 900); });

describe("the name column while swiping", () => {
  it("stays where it is when the table is scrolled sideways", async () => {
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 160));

    const box = document.querySelector<HTMLElement>(".table-scroll")!;
    const name = screen.getByText("261120 8100C").closest("td")!;
    const before = name.getBoundingClientRect().left;

    box.scrollLeft = 200;
    await new Promise((r) => setTimeout(r, 80));
    expect(box.scrollLeft, "the table did not actually scroll").toBeGreaterThan(0);

    // the row's identity must not slide away with everything else
    expect(Math.abs(name.getBoundingClientRect().left - before)).toBeLessThan(2);
  });

  it("still draws the gridline on the sticky cell", async () => {
    // border-collapse drops borders on sticky cells in some browsers, which would leave the
    // frozen column visually detached from the row it belongs to
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 160));

    const name = screen.getByText("261120 8100C").closest("td")!;
    const style = getComputedStyle(name);
    expect(parseFloat(style.borderRightWidth)).toBeGreaterThan(0);
  });
});
