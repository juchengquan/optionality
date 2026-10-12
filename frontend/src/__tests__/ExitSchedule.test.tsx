import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** The exit schedule on screen (ADR 0011).
 *
 *  It arrives on the /quotes payload rather than being fetched beside it, so the pace is the pace
 *  against the very Cost to close the row shows. The column is the on-pace LEVEL and not the gap:
 *  it sits next to `value`, so the comparison is visual and there is no convention about which way
 *  a signed number points. The worded gap lives in the sheet, where there is room for words.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};
const scheduled = {
  id: "c1", code: "1120_IC_7100_8200", field: "mid_price", threshold: 7.51,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 39, fill: 86, scope: "all", positions: [{ id: "p1", name: "1120_IC_7100_8200" }],
  cost_to_close: 6.45, entry: 6.86, pnl: 41, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8200 }],
  combo_value: -6.45, combo_greeks: {},
  schedule: {
    dte_at_open: 45, on_pace: 6.39, pace_gap: 0.06,
    target: 3.43, stop: 13.72, target_dte: 11, manage_by_dte: 21,
  },
};
const unscheduled = { ...scheduled, id: "c2", code: "1030_bs_8100", schedule: null, entry: 3.37 };

function mockApi(rows: unknown[]) {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? rows : url.endsWith("/monitors") ? [] : health),
    } as Response)));
}

beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

const openRow = async (code: string) => {
  await waitFor(() => expect(screen.getByText(code)).toBeTruthy());
  await userEvent.click(screen.getByText(code));
  return await screen.findByRole("dialog");
};

describe("the on-pace column", () => {
  it("shows the level, beside the value it is to be compared with", async () => {
    mockApi([scheduled]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1120_IC_7100_8200")).toBeTruthy());

    const headers = [...document.querySelectorAll("th")].map((h) => h.textContent!.trim());
    expect(headers).toContain("on pace");
    // adjacent, because reading one against the other is the whole point of a level rather
    // than a gap — no sign convention to get the wrong way round
    expect(headers.indexOf("on pace") - headers.indexOf("value")).toBe(1);

    const row = screen.getByText("1120_IC_7100_8200").closest("tr")!;
    const cells = [...row.querySelectorAll("td")].map((c) => c.textContent!.trim());
    expect(cells).toContain("6.39");
    expect(cells, "the value it is compared against").toContain("6.45");
  });

  it("is blank, not zero, for a row with no declared holding", async () => {
    mockApi([unscheduled]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1030_bs_8100")).toBeTruthy());
    const row = screen.getByText("1030_bs_8100").closest("tr")!;
    const headers = [...document.querySelectorAll("th")].map((h) => h.textContent!.trim());
    const cell = [...row.querySelectorAll("td")][headers.indexOf("on pace")]!;
    expect(cell.textContent!.trim(), "a dash or nothing, never a 0.00").not.toMatch(/\d/);
  });
});

describe("the schedule in the row's sheet", () => {
  it("words the gap, which a column cannot", async () => {
    mockApi([scheduled]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");

    // behind means costing MORE than it should, and the sheet says which rather than leaving a
    // signed number to be read the wrong way
    expect(sheet.textContent).toMatch(/behind by 0\.06/i);
    expect(sheet.textContent).toMatch(/opened at 45 DTE/i);
  });

  it("gives the levels and when decay alone reaches the target", async () => {
    mockApi([scheduled]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");

    expect(within(sheet).getByText("target").closest("div")!.textContent).toContain("3.43");
    expect(within(sheet).getByText("stop").closest("div")!.textContent).toContain("13.72");
    // the finding worth having: a 50% target is not reached by time alone until ~11 DTE
    expect(within(sheet).getByText("target on decay alone").closest("div")!.textContent)
      .toContain("11 DTE");
    // asserted as the dt/dd pair, not as running text: they are separate elements, so the
    // concatenation has no space in it and a prose regex silently never matches
    expect(within(sheet).getByText("manage by").closest("div")!.textContent).toContain("21 DTE");
  });

  it("says ahead when it is ahead", async () => {
    mockApi([{ ...scheduled, cost_to_close: 6.0, schedule: { ...scheduled.schedule, pace_gap: -0.39 } }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toMatch(/ahead by 0\.39/i);
  });

  it("shows no schedule section at all when there is none", async () => {
    mockApi([unscheduled]);
    render(<App />);
    const sheet = await openRow("1030_bs_8100");
    // not "behind by —" and not a block of dashes: the section is absent
    expect(sheet.textContent).not.toMatch(/behind|ahead|on pace/i);
  });
});
