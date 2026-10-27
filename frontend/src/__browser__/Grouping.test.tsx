import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** A group divider is one cell spanning every column, which makes it the one piece of the table
 *  the column measuring (ADR 0008) never sees: `cellValue` is asked how wide each COLUMN needs to
 *  be, and this cell belongs to all of them. At phone width, where two columns are drawn and the
 *  budget is tight, a label wider than their sum would push the table out on its own — the kind of
 *  thing a green jsdom suite reports nothing about.
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
  single({ id: "m3", code: "US.SPXW261204P6950000", option_type: "PUT", strike_date: "2026-12-04", dte: 46 }),
];

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? rows
          : String(url).endsWith("/monitors") ? []
            : String(url).includes("/positions") ? []
              : health),
    })) as unknown as typeof fetch;
}

afterEach(async () => {
  cleanup();
  document.cookie = "ui_group=;path=/";
  await page.viewport(1280, 900);
});

const settle = () => new Promise((r) => setTimeout(r, 200));

describe("a group divider at phone width", () => {
  it("does not widen the table it sits in", async () => {
    document.cookie = "ui_group=expiry;path=/"; // the longer of the two labels
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await settle();

    const divider = document.querySelector<HTMLElement>("tr.group td")!;
    expect(divider.textContent, "the longer label is the one worth measuring").toContain("dte");

    const table = divider.closest("table")!;
    const body = table.querySelector<HTMLElement>("tbody tr:not(.group)")!;
    // the data rows decide the table's width; the divider must not be what sets it
    expect(divider.getBoundingClientRect().width)
      .toBeLessThanOrEqual(body.getBoundingClientRect().width + 1);
  });

  it("leaves the page itself unscrollable sideways, which is the whole budget", async () => {
    document.cookie = "ui_group=expiry;path=/";
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await settle();

    expect(document.documentElement.scrollWidth)
      .toBeLessThanOrEqual(document.documentElement.clientWidth);
  });

  it("stays put over the figures rather than freezing, when a row is swiped", async () => {
    // it spans the row it heads; a sticky first-child would pin it across the swipe instead
    document.cookie = "ui_group=type;path=/";
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await settle();

    const divider = document.querySelector<HTMLElement>("tr.group td")!;
    expect(getComputedStyle(divider).position).toBe("static");
  });

  it("reads as a heading: left-aligned, and not mistakable for a row of figures", async () => {
    document.cookie = "ui_group=type;path=/";
    mockApi();
    render(<App />);
    await settle();

    const divider = document.querySelector<HTMLElement>("tr.group td")!;
    const style = getComputedStyle(divider);
    expect(divider.textContent).toBe("calls");
    expect(style.textAlign).toBe("left");
    expect(style.textTransform).toBe("uppercase");
    // three rows share one quote name in these fixtures; any of them is a data cell
    const dataCell = screen.getAllByText("261130 8100C")[0]!.closest("td")!;
    expect(parseFloat(style.fontSize))
      .toBeLessThan(parseFloat(getComputedStyle(dataCell).fontSize));
  });
});
