import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** The page's own chrome: where you create things from, and what the top of the page says.
 *
 *  Both moved. The add triggers used to sit in the page heading, which is global chrome for two
 *  controls that each add a row to exactly ONE table — the same reasoning that put each table's
 *  column picker on its own heading line (ADR 0008). The refresh interval moved the other way,
 *  into a settings sheet, because it is a preference set once rather than a thing to read.
 *
 *  The service status line did NOT move. If OpenD is down or the alarm engine has stalled, every
 *  figure on the page is suspect and the bell may be silent — that is exactly when it must not be
 *  a click away. It is hidden only while there is nothing to say.
 */

const health = (over: Record<string, unknown> = {}) => ({
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  ...over,
});
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 84, scope: "leg", positions: [], cost_to_close: null, entry: null, pnl: null,
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.17, mid_price: 31.5 },
};
const cmb = {
  id: "c1", code: "1120_IC", field: "mid_price", threshold: 7.81,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 50, scope: "all", positions: [{ id: "p1", name: "1120_IC" }],
  cost_to_close: 4.0, entry: 6.86, pnl: 286, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8200 }], combo_value: -4.0, combo_greeks: {},
};

function mockApi(quotes: unknown[], h: Record<string, unknown> = health()) {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? quotes : url.endsWith("/monitors") ? [] : h),
    } as Response)));
}

beforeEach(() => {
  document.cookie = "ui_refresh=;path=/";
  document.cookie = "ui_cols_single=;path=/";
  document.cookie = "ui_cols_combo=;path=/";
});

describe("adding from the table that will hold it", () => {
  it("opens the monitor form from the single-leg table's own heading", async () => {
    mockApi([leg, cmb]);
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "add monitor" });
    // the button is inside that table's block, not floating in the page chrome
    const block = screen.getByText("Single-leg").closest("div")!;
    expect(block.contains(trigger)).toBe(true);

    await userEvent.click(trigger);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Add monitor" })).toBeTruthy();
  });

  it("opens the combo form from the combos table's own heading", async () => {
    mockApi([leg, cmb]);
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "add combo" });
    expect(screen.getByText("Combos").closest("div")!.contains(trigger)).toBe(true);

    await userEvent.click(trigger);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Add combo" })).toBeTruthy();
  });

  it("STILL offers both when there is nothing watched at all", async () => {
    // the trap this move walked into: WatchlistTable returns null on an empty list, heading and
    // all, so a trigger living on that heading would vanish exactly when it is the only way in —
    // a fresh install, or the moment you delete your last monitor of a kind.
    mockApi([]);
    render(<App />);
    expect(await screen.findByRole("button", { name: "add monitor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "add combo" })).toBeTruthy();
    expect(screen.getByText("Single-leg")).toBeTruthy();
    expect(screen.getByText("Combos")).toBeTruthy();
  });

  it("says a table is empty rather than drawing nothing", async () => {
    mockApi([cmb]);
    render(<App />);
    await screen.findByText("Combos");
    // the heading's own div is .table-head; the empty-state line is its sibling, so the block
    // is one level up. Asserting on .table-head passed vacuously by matching only the title.
    const block = screen.getByText("Single-leg").closest(".table-head")!.parentElement!;
    expect(block.textContent).toMatch(/nothing watched/i);
    expect(block.querySelector("table")).toBeNull();
  });
});

describe("the settings sheet", () => {
  it("holds the refresh interval, and remembers the choice", async () => {
    mockApi([leg]);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "settings" }));
    const sheet = await screen.findByRole("dialog");

    const select = within(sheet).getByLabelText("refresh every") as HTMLSelectElement;
    await userEvent.selectOptions(select, "5");
    expect(document.cookie).toContain("ui_refresh=5");
  });

  it("keeps the interval off the page itself", async () => {
    mockApi([leg]);
    render(<App />);
    await screen.findByText("Single-leg");
    expect(screen.queryByLabelText("refresh every")).toBeNull();
  });
});

describe("the service status line", () => {
  it("says nothing at all while there is nothing to say", async () => {
    mockApi([leg]);
    render(<App />);
    await screen.findByText("Single-leg");
    expect(document.querySelector(".health")).toBeNull();
  });

  it("appears, marked bad, when OpenD is down", async () => {
    mockApi([leg], health({ opend: false }));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".health")).toBeTruthy());
    const line = document.querySelector(".health")!;
    expect(line.textContent).toContain("DOWN");
    expect(line.querySelector(".bad")!.textContent).toContain("DOWN");
  });

  it("appears when the alarm engine is not active, which is the quiet failure", async () => {
    mockApi([leg], health({
      monitor: { last_sweep_at: "x", fetched_at: "x", alarms: { label: "stalled", bad: true } },
    }));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".health")).toBeTruthy());
    expect(document.querySelector(".health")!.textContent).toContain("stalled");
  });

  it("appears for a non-empty queue, which is not a fault but is worth seeing", async () => {
    mockApi([leg], health({ queue_depth: 3 }));
    render(<App />);
    await waitFor(() => expect(document.querySelector(".health")).toBeTruthy());
    expect(document.querySelector(".health")!.textContent).toContain("3");
  });
});
