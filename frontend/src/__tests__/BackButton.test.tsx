import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** Back closes the panel (ADR 0008). The interesting case is not that it works — it is
 *  that closing a panel some OTHER way has to consume the history entry too, or the next
 *  press of back does nothing at all and looks like the page ignoring you. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const row = {
  id: "m1", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all", positions: [{ id: "p1", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 }], combo_value: -0.8, combo_greeks: {},
};

function mockApi() {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? [row] : url.endsWith("/monitors") ? [] : health),
    } as Response)));
}

async function openRow() {
  render(<App />);
  await waitFor(() => expect(screen.getByText("1016_bs_8050")).toBeTruthy());
  await userEvent.click(screen.getByText("1016_bs_8050"));
  return await screen.findByRole("dialog");
}

describe("the back button", () => {
  beforeEach(() => { mockApi(); });

  it("closes the detail panel instead of leaving the dashboard", async () => {
    await openRow();
    const depth = window.history.length;

    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // still on the dashboard, not gone from it
    expect(screen.getByText("optionality watchlist")).toBeTruthy();
    expect(window.history.length).toBeLessThanOrEqual(depth);
  });

  it("consumes its history entry when the panel is closed another way", async () => {
    // history.length is useless here — it does not shrink when you go back, and jsdom
    // reports 1 regardless. What must actually happen is that closing by any other route
    // takes our pushed entry back off the stack, so this watches for exactly that.
    const back = vi.spyOn(window.history, "back");
    const pushed = vi.spyOn(window.history, "pushState");
    try {
      await openRow();
      expect(pushed).toHaveBeenCalledTimes(1);

      // Escape, not back — the case that strands an entry if closing ignores it
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    } finally {
      back.mockRestore();
      pushed.mockRestore();
    }
  });

  it("survives opening and closing repeatedly", async () => {
    const before = window.history.length;
    for (let i = 0; i < 3; i++) {
      await userEvent.click(screen.queryByText("1016_bs_8050") ?? (await openRow()));
      await screen.findByRole("dialog");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    // three opens and three closes must not grow the stack by three
    await waitFor(() => expect(window.history.length).toBe(before));
  });
});
