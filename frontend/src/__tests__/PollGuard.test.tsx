import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, beingOperated } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The poll replaces every row, so it must not land while something is being operated.
 *  The guard behind it is a list of selectors, and a list of selectors rots: it named
 *  "details" until phase 4 retired that element, and the column pickers silently stopped
 *  being protected. These assert against the REAL rendered controls rather than against
 *  the string, so retiring the next one fails here instead of going quiet. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const wing = {
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
        url.endsWith("/quotes") ? [wing] : url.endsWith("/monitors") ? [] : health),
    } as Response)));
}

describe("the poll guard", () => {
  // a popover left open by the previous test keeps focus, and the next test then reads
  // ITS activeElement rather than its own — green or red for the wrong reason either way
  beforeEach(async () => {
    await userEvent.keyboard("{Escape}");
    document.body.focus();
  });

  it("lets the poll through when nothing is focused", () => {
    expect(beingOperated(null)).toBe(false);
    expect(beingOperated(document.body)).toBe(false);
  });

  it("holds it while a threshold box has focus", async () => {
    mockApi();
    render(<App />);
    const box = await waitFor(() =>
      document.querySelector<HTMLInputElement>('[data-slot="number-field"]')!);

    box.focus();
    expect(beingOperated(document.activeElement)).toBe(true);
  });

  it("holds it while a column picker is open", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(screen.getByText("Single-leg columns")).toBeTruthy());

    await userEvent.click(screen.getByText("Single-leg columns"));
    await screen.findByRole("group", { name: "Single-leg columns" });

    // this is the case that went quiet in phase 4: the picker stopped being a <details>
    await waitFor(() => expect(beingOperated(document.activeElement)).toBe(true));
  });

  it("holds it while the delete confirmation is up", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(screen.getByText("1016_bs_8050")).toBeTruthy());
    await userEvent.click(screen.getByText("1016_bs_8050"));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByText("delete"));
    await screen.findByRole("alertdialog");

    // focus lands a tick after the dialog mounts, so this waits rather than races
    await waitFor(() => expect(beingOperated(document.activeElement)).toBe(true));
  });
});
