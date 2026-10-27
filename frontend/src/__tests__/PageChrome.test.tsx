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
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  ...over,
});
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 84, scope: "leg", positions: [], cost_to_close: null, entry: null, pnl: null,
  quote: { name: "SPXW 261120 8100.00C", option_delta: 0.17, mid_price: 31.5 },
};
const cmb = {
  id: "c1", code: "1120_IC", field: "mid_price", threshold: 7.81,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 50, scope: "all", positions: [{ id: "p1", name: "1120_IC" }],
  cost_to_close: 4.0, entry: 6.86, pnl: 286, quote: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8200 }], combo_value: -4.0, combo_greeks: {},
};

/** @param holdings what /positions/values answers. Defaulted to empty rather than falling through
 *  to the health body: the Service panel reads holdings, and a mock that hands it an object where
 *  the API promises an array fails inside the component rather than in the assertion. */
function mockApi(
  quotes: unknown[], h: Record<string, unknown> = health(), holdings: unknown[] = [],
) {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? quotes
          : url.endsWith("/monitors") ? []
            : url.includes("/positions") ? holdings
              : h),
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

/** These four pinned the `.health` strip. The strip is now the top line, which says the same
 *  faults in the same place and appears the same way — so three of them keep their reasons and
 *  change only what they read. The fourth moved: a non-empty queue is still worth seeing and is
 *  still not a fault, so it belongs in the Service panel rather than in a line about what needs
 *  you. A run executing needs nothing from you. */
describe("the top line, in place of the service status strip", () => {
  it("says nothing at all while there is nothing to say", async () => {
    mockApi([leg]);
    render(<App />);
    await screen.findByText("Single-leg");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("appears, marked bad, when the Provider is down", async () => {
    mockApi([leg], health({ provider: { name: "moomoo", ok: false } }));
    render(<App />);
    const line = await waitFor(() => screen.getByRole("status"));
    expect(line.textContent).toContain("moomoo down");
    expect(line.className, "a fault is painted bad").toContain("bad");
  });

  it("names whichever Provider the service says, rather than one it was written against", async () => {
    /** The guard for #169. Both assertions above would pass with "moomoo" hard-coded in the page,
     *  which is exactly the state this replaced: the line said "OpenD" whatever was behind the
     *  port. The name comes from /health or the dashboard is making it up. */
    mockApi([leg], health({ provider: { name: "ibkr", ok: false } }));
    render(<App />);
    const line = await waitFor(() => screen.getByRole("status"));
    expect(line.textContent).toContain("ibkr down");
    expect(line.textContent).not.toContain("moomoo");
  });

  it("appears when the alarm engine is not active, which is the quiet failure", async () => {
    mockApi([leg], health({
      monitor: { last_sweep_at: "x", fetched_at: "x", alarms: { label: "stalled", bad: true } },
    }));
    render(<App />);
    const line = await waitFor(() => screen.getByRole("status"));
    expect(line.textContent).toContain("stalled");
  });

  it("shows no queue in the Service panel, because there is no run pipeline (phase 10)", async () => {
    mockApi([leg], health());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");
    expect(panel.textContent).toContain("alarms");
    expect(panel.textContent).not.toContain("queue");
  });

  it("lists a holding at its Level that the page cannot see", async () => {
    // the page polls one batch per poll (ADR 0010) and a holding no rule covers has no row in it,
    // so this is the ONLY surface that can say so — which is why the page never claims all clear
    mockApi([leg], health(), [{
      id: "p9", name: "1130_BS_6950", entry: 1, contracts: 1, strategy: null,
      strike_date: "2026-11-30", legs: [], created_at: "x", opened_at: "2026-10-16",
      cost_to_close: 0.4, pnl: 60, contract_size: 100, greeks: {}, fetched_at: "x", dte: 45,
      schedule: {
        dte_at_open: 45, on_pace: 1, pace_gap: -0.6, target: 0.5, stop: 2,
        target_dte: 11, manage_by_dte: 21, reached: "target", manage_by_due: false,
      },
    }]);
    render(<App />);
    await screen.findByText("Single-leg");
    expect(screen.queryByRole("status"), "the page is silent about it").toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");
    expect(panel.textContent).toContain("1130_BS_6950 at target");
  });

  it("says in full what the page says by staying quiet", async () => {
    mockApi([leg]);
    render(<App />);
    await screen.findByText("Single-leg");
    await userEvent.click(await screen.findByRole("button", { name: "settings" }));
    const panel = await screen.findByRole("dialog");

    expect(panel.textContent).toContain("nothing needs you");
    expect(panel.textContent).toContain("moomoo up");
  });
});
