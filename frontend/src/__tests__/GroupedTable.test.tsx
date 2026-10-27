import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** Dividing a table into groups, and the control that picks how.
 *
 *  The watchlist interleaves two questions. "Which side is moving" wants the calls together and
 *  the puts together — the two wings of a credit structure. "What is happening to the 11-30s"
 *  wants one expiry at a time, and a book with several of them mixes them row by row. Both are
 *  the same rows in a different order, so this is a viewer preference and lives in a cookie.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const single = (over: Record<string, unknown>) => ({
  field: "option_delta", threshold: 0.12, direction: "above", compare: "abs", triggered: false,
  strike_date: "2026-11-30", option_type: "CALL", dte: 42, fill: 40, scope: "leg", positions: [],
  cost_to_close: null, entry: null, pnl: null, schedule: null,
  quote: { name: "SPXW 261130 8100.00C", option_delta: 0.11, mid_price: 12.5 },
  ...over,
});

const rows = [
  single({ id: "m1", code: "US.SPXW261130C8100000" }),
  single({ id: "m2", code: "US.SPXW261130P6950000", option_type: "PUT" }),
  single({ id: "m3", code: "US.SPXW261204C8100000", option_type: "CALL", strike_date: "2026-12-04", dte: 46 }),
];

function mockApi(quotes: unknown[] = rows) {
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

const singleTable = () =>
  screen.getByText("Single-leg").closest(".table-head")!.parentElement!.querySelector("table")!;

beforeEach(() => {
  document.cookie = "ui_group=;path=/";
  document.cookie = "ui_cols_single=;path=/";
  document.cookie = "ui_cols_combo=;path=/";
});

async function chooseGrouping(label: string) {
  await userEvent.click(screen.getByRole("button", { name: /settings/i }));
  const sheet = await screen.findByRole("dialog");
  await userEvent.selectOptions(within(sheet).getByLabelText("group rows by"), label);
  await userEvent.click(within(sheet).getByRole("button", { name: /close/i }));
}

describe("a table divided into groups", () => {
  it("draws no divider at all until one is asked for", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    expect(singleTable().querySelectorAll("tr.group")).toHaveLength(0);
  });

  it("labels the calls and the puts, calls first", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    await chooseGrouping("type");

    const dividers = [...singleTable().querySelectorAll("tr.group")].map((r) => r.textContent);
    expect(dividers).toEqual(["calls", "puts"]);
  });

  it("spans the divider across the whole table, so it reads as a heading", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    await chooseGrouping("type");

    const header = singleTable().querySelector("thead tr")!;
    const cell = singleTable().querySelector("tr.group td")!;
    expect(Number(cell.getAttribute("colSpan") ?? cell.getAttribute("colspan")))
      .toBe(header.querySelectorAll("th").length);
  });

  it("opens nothing when the divider itself is clicked", async () => {
    // every data row opens its detail sheet; a heading is not a row and has nothing to open
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    await chooseGrouping("type");

    await userEvent.click(singleTable().querySelector("tr.group")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups by expiry too, nearest first", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    await chooseGrouping("expiry");

    const dividers = [...singleTable().querySelectorAll("tr.group")].map((r) => r.textContent);
    expect(dividers).toEqual(["261130 · 42 dte", "261204 · 46 dte"]);
  });

  it("remembers the choice, because a layout you re-pick every load is not a preference", async () => {
    mockApi();
    render(<App />);
    await waitFor(() => expect(singleTable()).toBeTruthy());
    await chooseGrouping("type");
    expect(document.cookie).toContain("ui_group=type");
  });
});
