import { render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** Where the controls sit. Three rows of chrome used to stand between the heading and the
 *  data: the refresh selector, a row of picker buttons, and the freshness line. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "08:44:09" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, mid_price: 31.5 },
};

async function show() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [leg] : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
  render(<App />);
  await new Promise((r) => setTimeout(r, 200));
}

function sameLine(a: Element, b: Element): boolean {
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  return Math.abs((ra.top + ra.height / 2) - (rb.top + rb.height / 2)) < 8;
}

afterEach(async () => { document.body.innerHTML = ""; await page.viewport(1280, 900); });

describe("where the controls sit", () => {
  it("puts a table's column picker on that table's heading line", async () => {
    await show();
    const heading = screen.getByText("Single-leg");
    const picker = screen.getByRole("button", { name: "Single-leg columns" });

    expect(sameLine(heading, picker), "the picker is not on the heading's line").toBe(true);
    // and inside the table's own block, not floating in the page chrome
    expect(picker.closest("div")!.contains(heading)).toBe(true);
  });

  it("puts the refresh selector in the line that reports freshness", async () => {
    await show();
    const meta = document.querySelector(".meta")!;
    const refresh = screen.getByLabelText("refresh every");

    expect(meta.contains(refresh), "the refresh control is not in the freshness line").toBe(true);
    expect(meta.textContent).toMatch(/fetched at/);
  });

  it("puts refresh-now in that same line, as something a finger can hit", async () => {
    await show();
    const meta = document.querySelector(".meta")!;
    const now = screen.getByRole("button", { name: "refresh now" });

    expect(meta.contains(now), "refresh-now is not in the freshness line").toBe(true);
    // it is an icon in a line of small text, so its tap target is the thing to check rather
    // than its presence. 24px is the floor a thumb can be expected to find.
    const box = now.getBoundingClientRect();
    expect(Math.min(box.width, box.height), `${Math.round(box.width)}×${Math.round(box.height)}`)
      .toBeGreaterThanOrEqual(24);
    // and it sits beside the interval it overrides, not somewhere else in the sentence
    expect(sameLine(screen.getByLabelText("refresh every"), now)).toBe(true);
  });

  it("leaves one row of chrome between the heading and the data, not three", async () => {
    await show();
    const h2 = screen.getByText("optionality watchlist");
    const table = document.querySelector("table")!;

    // everything between them that is not the table's own wrapper — that starts above the
    // table because it contains it, and counting it made this read 3 when it meant 2
    const between = [...document.querySelectorAll<HTMLElement>("main > *")].filter((el) => {
      if (el.contains(table)) return false;
      const t = el.getBoundingClientRect().top;
      return t > h2.getBoundingClientRect().bottom && t < table.getBoundingClientRect().top;
    });
    // the freshness line and the service-status line; the pickers and the refresh selector
    // used to add two more
    expect(between.length, `chrome rows: ${between.map((e) => e.className || e.tagName).join(", ")}`)
      .toBeLessThanOrEqual(2);
  });

  it("puts the add triggers above the tables, on the heading's own line", async () => {
    await show();
    const h2 = screen.getByText("optionality watchlist");
    const table = document.querySelector("table")!;

    for (const label of ["add monitor", "add combo"]) {
      const button = screen.getByRole("button", { name: label });
      expect(sameLine(h2, button), `"${label}" is not on the heading's line`).toBe(true);
      expect(button.getBoundingClientRect().top, `"${label}" is below the table`)
        .toBeLessThan(table.getBoundingClientRect().top);
    }
  });

  it("costs no extra row to do it", async () => {
    await show();
    const h2 = screen.getByText("optionality watchlist");
    const table = document.querySelector("table")!;

    // they used to sit below the muted tables; moving them up must not push the data down,
    // which is the whole reason they share the heading's line
    const between = [...document.querySelectorAll<HTMLElement>("main > *")].filter((el) => {
      if (el.contains(table) || el.contains(h2)) return false;
      const t = el.getBoundingClientRect().top;
      return t > h2.getBoundingClientRect().bottom && t < table.getBoundingClientRect().top;
    });
    expect(between.length, `chrome rows: ${between.map((e) => e.className || e.tagName).join(", ")}`)
      .toBeLessThanOrEqual(2);
  });
});
