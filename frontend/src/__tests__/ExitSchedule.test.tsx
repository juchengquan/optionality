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

describe("how much of the gap vol could explain", () => {
  /** The √T shape assumes IV has not moved — time value scales with σ√T and only √T is used. The
   *  condor's net vega is about -1.3 points per vol point, so HALF a vol point covers a whole pace
   *  gap: "behind by 0.54" is largely a vol reading rather than a verdict on the trade.
   *
   *  Adjusting the line needs a baseline IV that nothing has recorded yet, so until then the sheet
   *  says what a vol move WOULD explain. Net vega is already computed and already on screen as the
   *  vega column, so this is arithmetic on figures the row already carries. */
  const vega = (v: number | null) => ({
    ...scheduled,
    combo_greeks: { option_delta: -0.012, option_vega: v, option_gamma: 0.00004, option_theta: 0.21 },
  });

  it("says how big an IV move would account for the whole gap", async () => {
    // gap 0.06 against a net vega of -1.29: 0.05 vol points
    mockApi([vega(-1.29)]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toMatch(/0\.05 vol points would cover/i);
    expect(sheet.textContent).toContain("-1.29");
  });

  it("scales with the gap, so a wide gap needs a big move", async () => {
    mockApi([{ ...vega(-1.29), schedule: { ...scheduled.schedule, pace_gap: 1.29 } }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toMatch(/1\.00 vol points would cover/i);
  });

  it("says nothing where there is no vega to divide by", async () => {
    // a structure with no net vol exposure cannot have its gap explained by vol, and dividing by
    // zero would print Infinity next to a number you act on
    mockApi([vega(0)]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).not.toMatch(/vol points would cover/i);
    expect(sheet.textContent, "the rest of the schedule still shows").toMatch(/on pace/i);
  });

  it("says nothing when the vega is unknown", async () => {
    mockApi([vega(null)]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).not.toMatch(/vol points would cover/i);
  });

  it("says nothing on a row with no gap to explain", async () => {
    mockApi([{ ...vega(-1.29), schedule: { ...scheduled.schedule, on_pace: null, pace_gap: null } }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).not.toMatch(/vol points would cover/i);
  });

  it("keeps it out of the table", async () => {
    mockApi([vega(-1.29)]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1120_IC_7100_8200")).toBeTruthy());
    expect(document.querySelector("table")!.textContent).not.toMatch(/vol points/i);
  });
});

describe("where the on-pace figure comes from", () => {
  /** Everything else on the row is a measurement; this one is a MODEL output, chosen on a single
   *  confirming observation (ADR 0011). A number that looks like a price and is not should say so
   *  on its face — and substituted with the row's own figures it can be checked by eye, which the
   *  abstract form cannot. Sheet only: the table is a scanning surface (ADR 0008). */
  it("shows the sum with this row's own numbers in it", async () => {
    mockApi([scheduled]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    // entry 6.86, 39 DTE now, opened at 45
    expect(sheet.textContent).toContain("6.86 × √(39 ÷ 45)");
  });

  it("takes them from the row, not from anywhere fixed", async () => {
    mockApi([{
      ...scheduled, entry: 3.91, dte: 30,
      schedule: { ...scheduled.schedule, dte_at_open: 57, on_pace: 2.84, pace_gap: -0.2 },
    }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toContain("3.91 × √(30 ÷ 57)");
    // the other row's sum, specifically — "45" on its own also matches the 6.45 cost to close,
    // which is how this assertion first failed while the formula was perfectly correct
    expect(sheet.textContent).not.toContain("√(39");
    expect(sheet.textContent).not.toContain("6.86 ×");
  });

  it("says what kind of number it is, which is the point", async () => {
    mockApi([scheduled]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toMatch(/shape, not a price/i);
    // the two things it cannot see, named rather than implied
    expect(sheet.textContent).toMatch(/IV/);
    expect(sheet.textContent).toMatch(/where SPX is/i);
  });

  it("shows no sum when there is no figure to explain", async () => {
    // an Opened in the future: the schedule exists, the pace does not
    mockApi([{
      ...scheduled,
      schedule: { ...scheduled.schedule, on_pace: null, pace_gap: null, dte_at_open: 10 },
    }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).not.toContain("√");
    // and still no stray caveat about a number that is not there
    expect(sheet.textContent).not.toMatch(/shape, not a price/i);
  });

  it("survives a row with no schedule FIELD at all, not merely a null one", async () => {
    // the case that broke everything: every fixture here carried the key, so `=== null` checks
    // passed their own tests and threw on each older fixture in the suite, where the field does
    // not exist. A row from the bot, or from a cached payload, looks like this.
    const { schedule: _dropped, ...noField } = scheduled;
    mockApi([noField]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).not.toContain("√");
    expect(sheet.textContent).toMatch(/mid ≥ 7\.51/);
  });

  it("keeps the formula off the table, which is for scanning", async () => {
    mockApi([scheduled]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1120_IC_7100_8200")).toBeTruthy());
    const table = document.querySelector("table")!;
    expect(table.textContent).not.toContain("√");
    expect(table.textContent).toContain("6.39");
  });

  it("renders a debit structure's negative entry as it is", async () => {
    mockApi([{
      ...scheduled, entry: -5, cost_to_close: -3.4,
      schedule: {
        ...scheduled.schedule, on_pace: -3.42, pace_gap: 0.02,
        target: null, stop: null, target_dte: null,
      },
    }]);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");
    expect(sheet.textContent).toContain("-5.00 × √(39 ÷ 45)");
  });
});
