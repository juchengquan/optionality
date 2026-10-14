import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** What you actually HOLD, as distinct from what is watched.
 *
 *  The gap: the dashboard rendered rules only — `/quotes` and `/monitors` — and never read
 *  `/positions/values`, so a holding no rule watches was invisible. Found with a live put spread
 *  that had an entry, a P&L and a full exit schedule and no screen anywhere that showed it. A
 *  contract claimed by two holdings is never adopted (positionsHolding declines rather than
 *  guess whose credit it is), which is one way to end up there, but any unwatched holding is.
 *
 *  FETCHED ON DEMAND. `/positions/values` makes its own bounded OpenD batch — a documented
 *  live-call exception — so putting it on the poll would mean a second batch per poll per open
 *  tab, and ADR 0010 is explicit that polling is not free.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

const spread = {
  id: "pBS", name: "1120_BS_7100", strategy: null, strike_date: "2026-11-20",
  contracts: 1, entry: 2.43, created_at: "x", opened_at: "2026-10-06",
  legs: [
    { side: "sold", option_type: "PUT", strike: 7100 },
    { side: "bought", option_type: "PUT", strike: 7050 },
  ],
  cost_to_close: 2.35, pnl: 8, contract_size: 100, fetched_at: "x", dte: 37,
  greeks: { option_delta: -0.04, option_vega: -0.8 },
  schedule: {
    dte_at_open: 45, on_pace: 2.2, pace_gap: 0.15,
    target: 1.215, stop: 4.86, target_dte: 11, manage_by_dte: 21,
  },
};
const undated = {
  ...spread, id: "pX", name: "1016_CS_8000", entry: null, opened_at: null, schedule: null,
};

let calls: string[] = [];
let posted: { url: string; method: string; body: Record<string, unknown> }[] = [];

function mockApi(holdings: unknown[]) {
  calls = [];
  posted = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      posted.push({ url, method, body: JSON.parse(init!.body as string) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    calls.push(url);
    const body = url.includes("/positions/values") ? holdings
      : url.endsWith("/vol") ? { vol: null, from: null, to: null, days: null }
      : url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

const holdingsOf = async () => {
  const toggle = await screen.findByRole("button", { name: /holdings/i });
  await userEvent.click(toggle);
  return await screen.findByTestId("holdings");
};

beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

describe("fetching only when asked", () => {
  it("asks for nothing until the section is opened", async () => {
    mockApi([spread]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /holdings/i })).toBeTruthy());
    // the poll has run at least once by now and must not have touched the holdings route:
    // it makes its own OpenD batch, so an idle tab would cost one every interval
    expect(calls.some((u) => u.includes("/positions/values"))).toBe(false);
  });

  it("asks once when opened", async () => {
    mockApi([spread]);
    render(<App />);
    await holdingsOf();
    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values"))).toHaveLength(1));
  });

  it("asks again when the refresh button fires, since nothing else refreshes it", async () => {
    // the other half of fetching on demand: these figures are live — cost to close, P&L and the
    // pace gap all move — and no poll touches them, so the button is the ONLY thing that brings
    // them up to date. A mutation sweep found both the effect's dependency and App's wiring of
    // it could be removed with every test still green.
    mockApi([spread]);
    render(<App />);
    await holdingsOf();
    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values"))).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values")).length).toBeGreaterThan(1));
  });

  it("stops asking again once closed", async () => {
    mockApi([spread]);
    render(<App />);
    const toggle = await screen.findByRole("button", { name: /holdings/i });
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("holdings")).toBeTruthy());
    await userEvent.click(toggle);
    const before = calls.filter((u) => u.includes("/positions/values")).length;
    await userEvent.click(await screen.findByRole("button", { name: /refresh now/i }));
    await waitFor(() => expect(screen.queryByTestId("holdings")).toBeNull());
    expect(calls.filter((u) => u.includes("/positions/values"))).toHaveLength(before);
  });
});

describe("a holding nothing watches", () => {
  it("shows its figures, which no other screen does", async () => {
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    expect(within(panel).getByText("1120_BS_7100")).toBeTruthy();
    const text = panel.textContent ?? "";
    expect(text).toContain("2.43");
    expect(text).toContain("2.35");
    expect(text).toContain("37");
  });

  it("shows its exit schedule, worded the way the row sheet words it", async () => {
    // behind means costing MORE than time alone accounts for. Same words as the watchlist's
    // sheet, because a signed gap next to a P&L reads backwards (RowDetail.tsx:89).
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    expect(within(panel).getByText(/behind by 0.15/)).toBeTruthy();
    expect((panel.textContent ?? "")).toContain("manage by 21");
  });

  it("says plainly when there is no schedule, rather than showing blanks", async () => {
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    expect(within(panel).getByText(/no opened date/i)).toBeTruthy();
  });
});

describe("recording entry and Opened where the holding actually lives", () => {
  it("patches the holding by its own id", async () => {
    // the semantically right place: #113 told the owner the entry "is set on that holding's own
    // row" and no such row existed. This is that row.
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pX");
    fireEvent.change(within(row).getByLabelText("entry", { exact: false }), { target: { value: "3.1" } });
    fireEvent.change(within(row).getByLabelText("opened", { exact: false }), { target: { value: "2026-10-09" } });
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/positions\/pX$/);
    expect(posted[0]!.method).toBe("PATCH");
    expect(posted[0]!.body).toEqual({ entry: 3.1, opened_at: "2026-10-09" });
  });

  it("leaves Opened alone when it was not filled in", async () => {
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pX");
    fireEvent.change(within(row).getByLabelText("entry", { exact: false }), { target: { value: "3.1" } });
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ entry: 3.1 });
  });

  it("sends nothing without an entry", async () => {
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pX");
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));
    expect(posted).toHaveLength(0);
  });

  it("re-reads the holdings after a write, so the figures are the server's", async () => {
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    const before = calls.filter((u) => u.includes("/positions/values")).length;
    const row = within(panel).getByTestId("holding-pX");
    fireEvent.change(within(row).getByLabelText("entry", { exact: false }), { target: { value: "3.1" } });
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));
    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values")).length).toBeGreaterThan(before));
  });
});
