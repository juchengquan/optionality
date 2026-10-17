import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** The detail sheet (ADR 0008). Its whole point is showing what the table is not:
 *  columns the picker has hidden, and — once the actions column retires — every control. */

const health = {
  db: true, opend: true,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};
const leg = {
  id: "m3", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p3", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  quote: {
    name: "SPXW 261120 8100.00C", option_delta: 0.1685, option_gamma: 0.00009,
    option_theta: -0.42, option_vega: 0.33, option_implied_volatility: 0.1712,
    mid_price: 31.5, bid_price: 31.3, ask_price: 31.7,
  },
};

/** An UNHELD combo — scope null, no positions — which is what every combo rule looks like
 *  until a holding it watches is recorded. Copied from the live /quotes response. */
const unheldCombo = {
  id: "c1", code: "1130_BS_6950", field: "mid_price", threshold: 2.01,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-30",
  dte: 45, fill: 72, scope: null, positions: [], cost_to_close: null,
  schedule: null, entry: null, pnl: null, quote: null,
  legs: [{ sign: -1, option_type: "PUT", strike: 6950 }, { sign: 1, option_type: "PUT", strike: 6900 }],
  combo_value: -1.45,
  combo_greeks: { option_delta: 0.006, option_gamma: 0, option_theta: 0.03, option_vega: -0.25 },
};

let calls: { method: string; body: unknown }[] = [];
function mockApi(quotes: unknown[] = [leg]) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      calls.push({ method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    const body = url.endsWith("/quotes") ? quotes : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

async function openDetail() {
  render(<App />);
  await waitFor(() => expect(screen.getByText("261120 8100C")).toBeTruthy());
  await userEvent.click(screen.getByText("261120 8100C"));
  return await screen.findByRole("dialog");
}

describe("editing the threshold from the table", () => {
  beforeEach(() => {
    document.cookie = "ui_cols_single=;path=/";
    document.cookie = "ui_cols_combo=;path=/";
  });

  /** The number in the alarm column IS the threshold, so it is the thing to tap when you want to
   *  change it. The controls moved into the sheet when the actions column retired (ADR 0008's
   *  column budget), and nothing on the row said so — reported twice as "no way to edit the
   *  threshold for combos".
   *
   *  The sheet already focuses its first control, which is the threshold box, so tapping the figure
   *  is the whole edit: tap, type, set. No column spent, no focus plumbing needed — only an
   *  affordance saying the figure is a door. */
  it("opens the sheet with the cursor already in the threshold box", async () => {
    mockApi([unheldCombo]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());

    await userEvent.click(screen.getByTitle("edit the threshold"));
    const sheet = await screen.findByRole("dialog");
    const box = within(sheet).getAllByRole("textbox")[0];

    expect(document.activeElement, "the threshold box has focus").toBe(box);
    expect((box as HTMLInputElement).value).toBe("2.01");
  });

  it("leaves the rest of the row opening the sheet exactly as before", async () => {
    // the figure is a way IN, not the only one: the whole row still opens the sheet, and the sheet
    // focuses its first control either way — which is why this needed no focus plumbing at all
    mockApi([unheldCombo]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());

    await userEvent.click(screen.getByText("1130_BS_6950"));
    const sheet = await screen.findByRole("dialog");

    expect(within(sheet).getByRole("button", { name: "set" })).toBeTruthy();
    expect(document.activeElement).toBe(within(sheet).getAllByRole("textbox")[0]);
  });

  it("sends the new threshold the sheet's own way", async () => {
    mockApi([unheldCombo]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByTitle("edit the threshold"));
    const sheet = await screen.findByRole("dialog");

    await userEvent.clear(within(sheet).getAllByRole("textbox")[0]!);
    await userEvent.type(within(sheet).getAllByRole("textbox")[0]!, "2.5");
    await userEvent.click(within(sheet).getByRole("button", { name: "set" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "PATCH", body: { threshold: 2.5 } });
  });
});

describe("an unheld combo's sheet", () => {
  beforeEach(() => {
    document.cookie = "ui_cols_single=;path=/";
    document.cookie = "ui_cols_combo=;path=/";
  });

  it("offers no entry row at all, rather than a label with nothing beside it", async () => {
    // EntryCell renders NOTHING for a rule that covers no whole holding — the figure would be a
    // fraction of someone else's credit. But the labelled wrapper went up regardless, so the sheet
    // showed the word "entry" with empty space where its box should be. A label with no control
    // reads as a broken control, which is how this was reported.
    mockApi([unheldCombo]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByText("1130_BS_6950"));
    const sheet = await screen.findByRole("dialog");

    const rows = Array.from(sheet.querySelectorAll("span.w-20")).map((s) => s.textContent?.trim());
    expect(rows, "no empty entry row").not.toContain("entry");
    // and the controls that DO belong to an unheld combo are all there
    expect(rows).toEqual(["threshold", "holding", "name"]);
    for (const name of ["set", "record", "rename", "mute", "delete"]) {
      expect(within(sheet).getByRole("button", { name }), name).toBeTruthy();
    }
  });

  it("still shows the entry row once a holding is recorded against it", async () => {
    // the row is absent because there is nothing to type, not because combos do not get one
    mockApi([{ ...unheldCombo, scope: "all", positions: [{ id: "p1", name: "spread" }], entry: 1 }]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());
    await userEvent.click(screen.getByText("1130_BS_6950"));
    const sheet = await screen.findByRole("dialog");

    const rows = Array.from(sheet.querySelectorAll("span.w-20")).map((s) => s.textContent?.trim());
    expect(rows).toContain("entry");
  });
});

describe("the row detail sheet", () => {
  beforeEach(() => {
    document.cookie = "ui_cols_single=;path=/";
    document.cookie = "ui_cols_combo=;path=/";
  });

  it("shows a figure the column picker has hidden", async () => {
    // gamma hidden for every row — the gap this sheet exists to close
    document.cookie = "ui_cols_single=gamma.vega.iv;path=/";
    mockApi();
    const sheet = await openDetail();

    expect(within(sheet).getByText("gamma")).toBeTruthy();
    expect(within(sheet).getByText("vega")).toBeTruthy();
    expect(within(sheet).getByText("IV")).toBeTruthy();
    // and the table is still drawing none of them
    expect([...document.querySelectorAll("th")].map((h) => h.textContent)).not.toContain("gamma");
  });

  it("names the row and the rule it is watching", async () => {
    mockApi();
    const sheet = await openDetail();

    expect(within(sheet).getByText(/261120 8100C/)).toBeTruthy();
    // the rule as the alarm column states it. "delta" alone also matches the figure label
    // below it, so this asserts the whole phrase, comparator and all
    expect(within(sheet).getByText(/delta ≥ 0\.2/)).toBeTruthy();
  });

  it("operates the row from inside the sheet", async () => {
    mockApi();
    const sheet = await openDetail();

    await userEvent.click(within(sheet).getByRole("button", { name: "mute" }));
    await waitFor(() =>
      expect(calls.some((c) => c.body && "enabled" in (c.body as object))).toBe(true));
  });

  it("follows the live data rather than freezing what it opened with", async () => {
    mockApi();
    const sheet = await openDetail();
    expect(within(sheet).getByText("0.1685")).toBeTruthy();

    // the poll replaces every row object; the sheet must re-read, not hold a stale copy
    mockApi([{ ...leg, quote: { ...leg.quote, option_delta: 0.2100 } }]);
    await userEvent.click(within(sheet).getByRole("button", { name: "mute" }));

    await waitFor(() => expect(within(sheet).getByText("0.2100")).toBeTruthy());
  });
});
