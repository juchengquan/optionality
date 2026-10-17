import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

const health = {
  db: true, opend: true,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** the live book's loudest row: 99% of its threshold, and 48 days of time left */
const loud = {
  id: "m1", code: "1204_BS_6950", field: "mid_price", threshold: 2.79,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-12-04",
  dte: 48, fill: 99, scope: null, positions: [], cost_to_close: null, schedule: null,
  entry: null, pnl: null, quote: null,
  legs: [{ sign: -1, option_type: "PUT", strike: 6950 }, { sign: 1, option_type: "PUT", strike: 6900 }],
  combo_value: -2.75, combo_greeks: {},
};
/** further from its threshold, and days from expiry */
const near = { ...loud, id: "m2", code: "1020_BS_6900", dte: 3, fill: 70, combo_value: -1.9 };

function mockApi(quotes: unknown[]) {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? quotes
          : url.endsWith("/monitors") ? []
            : url.includes("/positions") ? []
              : health),
    } as Response)));
}

/** the cell wearing the bar, for a row named by its code */
function barCell(code: string): HTMLElement {
  const row = screen.getByText(code).closest("tr")!;
  return row.querySelector("td.hl") as HTMLElement;
}

describe("choosing what the second colour means", () => {
  beforeEach(() => {
    for (const c of ["ui_cols_single", "ui_cols_combo", "ui_signal", "ui_band"]) {
      document.cookie = `${c}=;path=/;max-age=0`;
    }
  });

  it("flags the loudest row by default, because distance is the default reading", async () => {
    mockApi([loud, near]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1204_BS_6950")).toBeTruthy());

    expect(barCell("1204_BS_6950").className, "99% clears the 90 band").toContain("imminent");
    expect(barCell("1020_BS_6900").className, "70% does not").not.toContain("imminent");
  });

  it("lets the band be raised until the colour is rare again", async () => {
    mockApi([loud, near]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1204_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");

    await userEvent.clear(within(panel).getByLabelText("flag above"));
    await userEvent.type(within(panel).getByLabelText("flag above"), "100");

    await waitFor(() => expect(barCell("1204_BS_6950").className).not.toContain("imminent"));
    expect(document.cookie, "and it is remembered").toContain("ui_band=100");
  });

  it("swaps the reading for pressure, which inverts these two rows", async () => {
    // 99% at 48 DTE weighs 43; 70% at 3 DTE weighs 70. The loud row goes quiet and the near-dated
    // one speaks — the whole point of offering the second reading.
    //
    // The band is lowered as part of the switch, because pressure is a DISCOUNTED fill and the two
    // readings are not on one scale: 90 is reachable by a fill and, outside the horizon, never by
    // a pressure. One band serves both, and switching means retuning it.
    mockApi([loud, near]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1204_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");

    await userEvent.selectOptions(within(panel).getByLabelText("flag on"), "pressure");
    await userEvent.clear(within(panel).getByLabelText("flag above"));
    await userEvent.type(within(panel).getByLabelText("flag above"), "60");

    await waitFor(() => expect(barCell("1020_BS_6900").className).toContain("imminent"));
    expect(barCell("1204_BS_6950").className, "99% of a threshold 48 days away").not.toContain("imminent");
    expect(document.cookie).toContain("ui_signal=pressure");
  });

  it("flags nothing in pressure mode while the band is still set for distance", async () => {
    // the trap the band control exists to answer: pressure(99, 48, 21) is 43, so a band of 90
    // silently turns the second colour off entirely rather than ringing differently
    mockApi([loud, near]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1204_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(panel).getByLabelText("flag on"), "pressure");

    await waitFor(() => expect(barCell("1204_BS_6950").className).not.toContain("imminent"));
    expect(barCell("1020_BS_6900").className).not.toContain("imminent");
  });

  it("never changes the bar itself, which is always the distance", async () => {
    // length says how close; colour says whether that closeness has been earned
    mockApi([loud, near]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1204_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(panel).getByLabelText("flag on"), "pressure");
    await userEvent.clear(within(panel).getByLabelText("flag above"));
    await userEvent.type(within(panel).getByLabelText("flag above"), "60");

    await waitFor(() => expect(barCell("1020_BS_6900").className).toContain("imminent"));
    expect(barCell("1204_BS_6950").style.getPropertyValue("--fill"), "still 99% long").toBe("99%");
  });
});
