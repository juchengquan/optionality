import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The detail sheet (ADR 0008). Its whole point is showing what the table is not:
 *  columns the picker has hidden, and — once the actions column retires — every control. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const leg = {
  id: "m3", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p3", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: {
    name: "SPXW 261120 8100.00C", option_delta: 0.1685, option_gamma: 0.00009,
    option_theta: -0.42, option_vega: 0.33, option_implied_volatility: 0.1712,
    mid_price: 31.5, bid_price: 31.3, ask_price: 31.7,
  },
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
  await waitFor(() => expect(screen.getByText("SPXW 261120 8100.00C")).toBeTruthy());
  await userEvent.click(screen.getByText("SPXW 261120 8100.00C"));
  return await screen.findByRole("dialog");
}

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

    expect(within(sheet).getByText(/SPXW 261120 8100.00C/)).toBeTruthy();
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
    mockApi([{ ...leg, snapshot: { ...leg.snapshot, option_delta: 0.2100 } }]);
    await userEvent.click(within(sheet).getByRole("button", { name: "mute" }));

    await waitFor(() => expect(within(sheet).getByText("0.2100")).toBeTruthy());
  });
});
