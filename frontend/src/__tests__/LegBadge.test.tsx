import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { COMBO_COLUMNS, identityBadges, widthsFromContent } from "../columns";
import { cellValue } from "../WatchlistTable";
import type { Entry } from "../api";

/** A rule watching PART of a holding said so only by what it did NOT draw.
 *
 *  Scope "leg" blanks entry, P&L and on-pace (WatchlistTable: `entry.scope === "all" ? … : ""`),
 *  which is right — those figures would be a fraction of someone else's credit. But a rule
 *  holding NOTHING blanks exactly the same three cells, so the two states were indistinguishable
 *  in the table: on 2026-10-20, recording 1130_8100 turned the adjacent 1130_8150 into a leg rule
 *  and nothing on the row changed. The only surface that said which was which was the detail
 *  sheet, one tap away.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const held = { id: "p1", name: "1130_8100" };

const combo = (over: Record<string, unknown>) => ({
  field: "mid_price", threshold: 2.49, direction: "above", compare: "abs", triggered: false,
  strike_date: "2026-11-30", option_type: "CMB", dte: 41, fill: 61,
  scope: null, positions: [], cost_to_close: null, entry: null, pnl: null, schedule: null,
  quote: null, combo_value: -3.05, combo_greeks: {},
  legs: [{ sign: -1, option_type: "CALL", strike: 8150 }, { sign: 1, option_type: "CALL", strike: 8200 }],
  ...over,
});

/** The three states side by side, which is the comparison the badge exists to make legible. */
const rows = [
  // watches the 8150 you hold and the 8200 nobody does — part of a structure
  combo({ id: "m1", code: "1130_8150", scope: "leg", positions: [held] }),
  // covers the holding whole: its entry and P&L are already on the row, saying so
  combo({ id: "m2", code: "1130_8100", scope: "all", positions: [held], entry: 5.01, pnl: 41,
          cost_to_close: 4.6 }),
  // watches contracts nobody holds
  combo({ id: "m3", code: "1130_6950", scope: null, positions: [] }),
];

function mockApi(served = rows) {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? served : url.endsWith("/monitors") ? [] : health),
    } as Response)));
}

async function rowFor(code: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
  const row = screen.getAllByRole("row").find((r) => r.textContent?.includes(code));
  if (!row) throw new Error(`no row for ${code}`);
  return row;
}

describe("the leg badge", () => {
  it("marks a rule that watches part of a holding, and names the holding", async () => {
    mockApi();
    render(<App />);
    const row = await rowFor("1130_8150");

    const badge = within(row).getByText("leg");
    // the badge is terse because it sits in the frozen identity column, where width is the
    // scarcest thing on the page; the holding's name is what you came to the row to learn
    expect(badge.title).toContain("1130_8100");
  });

  it("is quiet, not the red one — a leg rule is working, not broken", async () => {
    mockApi();
    render(<App />);
    const badge = within(await rowFor("1130_8150")).getByText("leg");

    // `.badge` alone is --destructive: it was built for a quarantined contract, and red here
    // would say a working rule had gone wrong
    expect(badge.className).toContain("quiet");
  });

  it("stays off a rule covering the whole holding, whose entry already says so", async () => {
    mockApi();
    render(<App />);
    const row = await rowFor("1130_8100");

    expect(within(row).queryByText("leg")).toBeNull();
  });

  it("stays off a rule that holds nothing, which is the state it distinguishes", async () => {
    mockApi();
    render(<App />);
    const row = await rowFor("1130_6950");

    expect(within(row).queryByText("leg")).toBeNull();
  });
});

/** The badge is width, and the fitting is told in TEXT how wide a column has to be (ADR 0008).
 *
 *  Above 60rem the identity cell does not wrap (app.css), so the badge genuinely extends it — and
 *  a column measured short by exactly a badge lets the fitting spend a budget the table then
 *  exceeds. Measured here rather than in a layout: this is the arithmetic, and `__browser__`
 *  holds the geometry it has to agree with.
 */
describe("what the column measuring is told", () => {
  const legRow = {
    code: "1130_8150", scope: "leg", positions: [{ id: "p1", name: "1130_8100" }],
  } as unknown as Entry;
  const width = (row: Entry, key: string) =>
    widthsFromContent(COMBO_COLUMNS.filter((c) => c.key === key), [row], true, 10, cellValue)[key]!;

  it("counts the badge beside the name", () => {
    const whole = { ...legRow, scope: "all" } as unknown as Entry;
    // 10px per character, so the four characters of " leg" are 40px the budget would not
    // otherwise have known to spend
    expect(width(legRow, "combo") - width(whole, "combo")).toBe(40);
  });

  it("leaves every other column exactly as it reads", () => {
    // the badge belongs to one cell; charging the figures for it would narrow the table for
    // nothing
    const row = { ...legRow, combo_value: -3.05, cost_to_close: null } as unknown as Entry;
    const whole = { ...row, scope: "all", entry: null, pnl: null } as unknown as Entry;
    expect(width(row, "value")).toBe(width(whole, "value"));
  });

  it("charges nothing where there is no badge", () => {
    const whole = { ...legRow, scope: "all" } as unknown as Entry;
    expect(identityBadges(whole)).toEqual([]);
  });
});
