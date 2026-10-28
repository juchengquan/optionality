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
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

const spread = {
  id: "pBS", name: "1120_BS_7100", strategy: null, strike_date: "2026-11-20",
  contracts: 1, entry: 2.43, created_at: "x", opened_at: "2026-10-06",
  legs: [
    { side: "short", option_type: "PUT", strike: 7100 },
    { side: "long", option_type: "PUT", strike: 7050 },
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
      posted.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : {} });
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

  it("asks when the CAMERA presses, with the panel never opened", async () => {
    // #176: the picture used to clone this panel's node, so it carried the money only if you had
    // opened the panel first — and pressing the button on a page you have not touched is how a
    // daily record gets taken. The press fetches them itself now. (The capture itself cannot run
    // under jsdom; what is asserted is the call that has to precede it.)
    mockApi([spread]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: /save as image/i })).toBeTruthy());
    expect(calls.some((u) => u.includes("/positions/values")), "fetched before the press")
      .toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /save as image/i }));

    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values"))).toHaveLength(1));
    expect(screen.queryByTestId("holdings"), "the panel opened itself").toBeNull();
  });

  it("drops the figures when the fetch fails, rather than keeping them under a fresh stamp", async () => {
    // the stale-figure failure this dashboard refuses everywhere else: a cost to close from ten
    // minutes ago, shown beside a freshness line that says now. The rows go and the reason shows.
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    expect(within(panel).getByText("1120_BS_7100")).toBeTruthy();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      }
      if (url.includes("/positions/values")) {
        return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as Response);
      }
      const body = url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }));
    await userEvent.click(screen.getByRole("button", { name: /refresh now/i }));

    await waitFor(() => expect(screen.getByText(/502/)).toBeTruthy());
    expect(screen.queryByText("1120_BS_7100"), "a figure nobody can vouch for is still on screen")
      .toBeNull();
    expect(screen.queryByText(/loading/i), "'loading…' under the reason it failed").toBeNull();
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
    // two decimals, like every other money figure on the dashboard. `String(pnl)` printed a bare
    // 8 where WatchlistTable prints 8.00 for the same number, which broke the tabular-nums
    // alignment of the grid it sits in — a code review caught the inconsistency, and a mutation
    // sweep then showed nothing here could tell the two apart.
    expect(text).toContain("8.00");
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

describe("the row #113 pointed at", () => {
  /** Only testable once both changes exist, which is why it lands with the merge rather than in
   *  either branch.
   *
   *  #113 stopped a leg rule from creating a duplicate Position and told the owner instead that
   *  the entry "is set on that holding's own row". For a holding no rule watched there was no
   *  such row — the advice named something that did not exist. This asserts the pair: the sheet
   *  sends you somewhere, and somewhere is here, with the controls it promised.
   */
  const legRule = {
    id: "mBS", code: "1120_BS_7100", field: "mid_price", threshold: 7.0,
    direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
    dte: 37, fill: null, scope: "leg",
    positions: [{ id: "pBS", name: "1120_BS_7100" }],
    cost_to_close: 2.35, entry: null, pnl: null, quote: null,
    legs: [
      { sign: -1, option_type: "PUT", strike: 7100 },
      { sign: 1, option_type: "PUT", strike: 7050 },
    ],
    combo_value: -2.35, combo_greeks: {}, schedule: null,
  };

  function mockBoth(holdings: unknown[], rows: unknown[]) {
    calls = [];
    posted = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        posted.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : {} });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      }
      calls.push(url);
      const body = url.includes("/positions/values") ? holdings
        : url.endsWith("/vol") ? { vol: null, from: null, to: null, days: null }
        : url.endsWith("/quotes") ? rows : url.endsWith("/monitors") ? [] : health;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }));
  }

  it("names a holding the list can actually show, with the controls it promised", async () => {
    mockBoth([{ ...spread, entry: null, opened_at: null, schedule: null }], [legRule]);
    render(<App />);

    // the sheet declines, and says where to go
    await waitFor(() => expect(screen.getByText("1120_BS_7100")).toBeTruthy());
    await userEvent.click(screen.getByText("1120_BS_7100"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/its entry and opened date are set on that holding's own row/))
      .toBeTruthy();
    const named = within(sheet).getByText(/part of/).textContent ?? "";
    expect(named).toContain("1120_BS_7100");

    // ...and that row exists, with both controls on it
    await userEvent.keyboard("{Escape}");
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pBS");
    expect(within(row).getByLabelText("entry", { exact: false })).toBeTruthy();
    expect(within(row).getByLabelText("opened", { exact: false })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /set/i })).toBeTruthy();
  });

  it("records nothing from the sheet, so the 409 cannot come back", async () => {
    mockBoth([spread], [legRule]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("1120_BS_7100")).toBeTruthy());
    await userEvent.click(screen.getByText("1120_BS_7100"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: /record/i })).toBeNull();
    expect(posted).toHaveLength(0);
  });
});

describe("deleting a holding", () => {
  /** There was no way to do it from the UI at all. The route has always existed and is carefully
   *  guarded — it clears the monitor links and the samples in one transaction, because both
   *  reference the row — but the frontend never called it, so removing a holding meant an HTTP
   *  request by hand.
   *
   *  Guarded like a monitor delete, and for a stronger reason: a monitor can be MUTED instead and
   *  unmuted with one click. A holding cannot. And its samples go with it — the daily cost to
   *  close, per-leg IV and per-leg vega that no later sweep can reconstruct, which for the live
   *  condor is the only vol history that exists.
   */
  const deleted = () => posted.filter((p) => p.method === "DELETE");

  it("asks before doing it, and does nothing until confirmed", async () => {
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pBS");
    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/1120_BS_7100/)).toBeTruthy();
    expect(deleted()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    expect(deleted()).toHaveLength(0);
  });

  it("says that the recorded history goes with it, which cannot be rebuilt", async () => {
    // the half worth warning about: entry and Opened can be typed again, the samples cannot.
    // IV and vega are only knowable on the day they were observed (ADR 0011).
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    await userEvent.click(
      within(within(panel).getByTestId("holding-pBS")).getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    const text = dialog.textContent ?? "";
    expect(text).toMatch(/volatility|vega|history/i);
    expect(text).not.toMatch(/threshold/i);
    expect(text).not.toMatch(/mut(e|ing)/i);
  });

  it("says the alarm rules survive, because they do", async () => {
    // nothing here deletes a rule as a side effect: they stop knowing what they watched and
    // would be adopted again if the holding came back
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    await userEvent.click(
      within(within(panel).getByTestId("holding-pBS")).getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect((dialog.textContent ?? "")).toMatch(/rules?.*(kept|survive|remain)/i);
  });

  it("deletes the holding by its own id once confirmed", async () => {
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    await userEvent.click(
      within(within(panel).getByTestId("holding-pBS")).getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleted()).toHaveLength(1));
    expect(deleted()[0]!.url).toMatch(/\/positions\/pBS$/);
  });

  it("re-reads the list afterwards, so the row goes without a manual refresh", async () => {
    mockApi([spread]);
    render(<App />);
    const panel = await holdingsOf();
    const before = calls.filter((u) => u.includes("/positions/values")).length;
    await userEvent.click(
      within(within(panel).getByTestId("holding-pBS")).getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() =>
      expect(calls.filter((u) => u.includes("/positions/values")).length).toBeGreaterThan(before));
  });
});

describe("when a write is refused", () => {
  /** Three findings from a code review, all the same shape: the owner acts and nothing happens,
   *  with no message saying why.
   *
   *  Every other mutation on the dashboard goes through App's `act`, which puts the service's own
   *  words in a toast — the service explains its refusals properly, so its words are what should
   *  be shown. These two writes went through a bare `void (async () => {...})()` with no catch, so
   *  a refusal became an unhandled promise rejection: no toast, no reload, the row untouched.
   */
  function mockRefusing(holdings: unknown[], detail: string) {
    calls = [];
    posted = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        posted.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : {} });
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ detail }) } as Response);
      }
      calls.push(url);
      const body = url.includes("/positions/values") ? holdings
        : url.endsWith("/vol") ? { vol: null, from: null, to: null, days: null }
        : url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }));
  }

  it("says why, in the service's own words, when a patch is refused", async () => {
    mockRefusing([undated], "position not found");
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pX");
    fireEvent.change(within(row).getByLabelText("entry", { exact: false }), { target: { value: "3.1" } });
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));

    await waitFor(() => expect(screen.getByText("position not found")).toBeTruthy());
  });

  it("says why when a delete is refused", async () => {
    mockRefusing([spread], "position not found");
    render(<App />);
    const panel = await holdingsOf();
    await userEvent.click(
      within(within(panel).getByTestId("holding-pBS")).getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.getByText("position not found")).toBeTruthy());
  });

  it("records the opened date alone, rather than refusing in silence", async () => {
    // `if (value === null) return;` made the button a no-op on a holding with no entry — the very
    // case the panel exists for, directly under a line telling the owner to set a date there.
    // exitLevels yields a schedule from opened_at alone, so the date by itself is meaningful.
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    const row = within(panel).getByTestId("holding-pX");
    fireEvent.change(within(row).getByLabelText("opened", { exact: false }), { target: { value: "2026-10-09" } });
    await userEvent.click(within(row).getByRole("button", { name: /set/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ opened_at: "2026-10-09" });
  });

  it("still sends nothing when neither field was filled in", async () => {
    mockApi([undated]);
    render(<App />);
    const panel = await holdingsOf();
    await userEvent.click(
      within(within(panel).getByTestId("holding-pX")).getByRole("button", { name: /set/i }));
    expect(posted).toHaveLength(0);
  });
});
