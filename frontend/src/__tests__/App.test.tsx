import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** Fixtures mirror the REAL watchlist: a wing rule, a rule spanning two holdings, and a
 *  leg rule. Every frontend bug shipped on 2026-09-24 passed against a simpler fixture and
 *  failed on live data, twice. */
const wing = {
  id: "m1", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all",
  positions: [{ id: "p1", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207,
  snapshot: null,
  legs: [
    { sign: -1, option_type: "CALL", strike: 8050 },
    { sign: 1, option_type: "CALL", strike: 8075 },
  ],
  combo_value: -0.8, combo_greeks: { option_delta: -0.01, option_gamma: -0.00009, option_theta: 0.08, option_vega: -0.33 },
};

const spanning = {
  ...wing, id: "m2", code: "1016_IC", threshold: 3.21, fill: 48, triggered: true,
  positions: [{ id: "p1", name: "1016_bs_8050" }, { id: "p2", name: "1016_IC_puts" }],
  cost_to_close: 1.55, entry: 3.21, pnl: 166,
};

const leg = {
  id: "m3", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p3", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, mid_price: 31.5, bid_price: 31.3, ask_price: 31.7 },
};

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "2026-09-24 15:00:00+08:00", alarms: { label: "active", bad: false }, fetched_at: "2026-09-24 15:00:00+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

function mockApi(quotes: unknown[], monitors: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const body = url.endsWith("/quotes") ? quotes : url.endsWith("/monitors") ? monitors : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

describe("the watchlist", () => {
  beforeEach(() => { document.cookie = "ui_cols_single=;path=/"; document.cookie = "ui_cols_combo=;path=/"; });

  it("renders both tables from the API", async () => {
    mockApi([wing, spanning, leg]);
    render(<App rootPath="" />);
    await waitFor(() => expect(screen.getByText("Single-leg")).toBeTruthy());
    expect(screen.getByText("Combos")).toBeTruthy();
    expect(screen.getByText("SPXW 261120 8100.00C")).toBeTruthy();
  });

  it("shows cost to close positive, and the P&L it implies", async () => {
    mockApi([spanning]);
    render(<App rootPath="" />);
    // the combo's own signed sum is -0.80; what a trader reads is what it costs to close
    await waitFor(() => expect(screen.getByText("1.55")).toBeTruthy());
    expect(screen.getByText("166.00")).toBeTruthy();
    expect(screen.queryByText("-1.55")).toBeNull();
  });

  it("carries the legs, so a leg entered backwards is visible", async () => {
    mockApi([wing]);
    render(<App rootPath="" />);
    await waitFor(() => expect(screen.getByText(/-C8050 \+C8075/)).toBeTruthy());
  });

  it("puts the fill bar on the column the alarm watches", async () => {
    mockApi([leg]);
    const { container } = render(<App rootPath="" />);
    await waitFor(() => expect(container.querySelector("td.hl")).toBeTruthy());
    const filled = container.querySelector("td.hl") as HTMLElement;
    expect(filled.style.getPropertyValue("--fill")).toBe("84%");
    expect(filled.textContent).toBe("0.1685"); // delta, the monitored field
  });

  it("rings the bell on a triggered row", async () => {
    mockApi([spanning]);
    const { container } = render(<App rootPath="" />);
    await waitFor(() => expect(container.querySelector("tr.triggered")).toBeTruthy());
    expect(container.textContent).toContain("🔔");
  });

  it("names the sweep cadence, so a still timestamp reads as normal", async () => {
    mockApi([leg]);
    render(<App rootPath="" />);
    await waitFor(() => expect(screen.getByText(/sweep every 15s/)).toBeTruthy());
  });

  it("groups muted monitors by reason and counts down to the delete", async () => {
    mockApi([], [
      { id: "x", code: "old", field: "option_delta", threshold: 0.2, strike_date: "2026-09-22",
        enabled: false, disabled_reason: "expired", scope: null, positions: [] },
    ]);
    render(<App rootPath="" />);
    await waitFor(() => expect(screen.getByText("Expired")).toBeTruthy());
    expect(screen.getByText(/auto-deletes in \d+ days?/)).toBeTruthy();
  });
});
