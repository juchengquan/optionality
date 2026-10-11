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

  it("leaves the freshness line reporting freshness and nothing else", async () => {
    await show();
    const meta = document.querySelector(".meta")!;

    expect(meta.textContent).toMatch(/fetched at/);
    expect(meta.textContent).toMatch(/sweeps every/);
    // the interval used to live in this sentence. It is a preference set once, not a thing to
    // read, so it moved into the settings sheet — and must not have left a control behind.
    expect(screen.queryByLabelText("refresh every"), "the interval is still on the page").toBeNull();
    expect(meta.querySelector("select, button"), "a control is still in the freshness line").toBeNull();
  });

  it("offers the interval in the settings sheet instead", async () => {
    await show();
    screen.getByRole("button", { name: "settings" }).click();
    await new Promise((r) => setTimeout(r, 220));
    const sheet = document.querySelector("[role=dialog]")!;
    expect(sheet.contains(screen.getByLabelText("refresh every"))).toBe(true);
  });

  it("puts the page's own two actions on the heading's line, as things a finger can hit", async () => {
    await show();
    const h2 = screen.getByText("optionality watchlist");
    const now = screen.getByRole("button", { name: "refresh now" });
    const settings = screen.getByRole("button", { name: "settings" });

    // what you can DO to the screen sits with the screen's name; what you can CREATE moved to
    // the table that will hold it. Two different subjects, so two different lines.
    expect(sameLine(h2, now), "refresh-now is not on the heading's line").toBe(true);
    expect(sameLine(h2, settings), "settings is not on the heading's line").toBe(true);
    // it is an icon in a line of small text, so its tap target is the thing to check rather
    // than its presence. 24px is the floor a thumb can be expected to find.
    const box = now.getBoundingClientRect();
    expect(Math.min(box.width, box.height), `${Math.round(box.width)}×${Math.round(box.height)}`)
      .toBeGreaterThanOrEqual(24);
    for (const b of [now, settings]) {
      const box = b.getBoundingClientRect();
      expect(Math.min(box.width, box.height),
        `${b.getAttribute("aria-label")} is ${Math.round(box.width)}×${Math.round(box.height)}`)
        .toBeGreaterThanOrEqual(24);
    }
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
    // ONE row now, not two: the service-status line shows only when it has something to say, and
    // this fixture is healthy. A degraded service legitimately adds it back.
    expect(between.length, `chrome rows: ${between.map((e) => e.className || e.tagName).join(", ")}`)
      .toBe(1);
  });

  it("puts each add trigger on the heading of the table it adds to", async () => {
    await show();
    // the same reasoning that moved the column pickers here: a control belongs next to the thing
    // it changes, and each of these adds a row to exactly one of these tables
    for (const [label, title] of [["add monitor", "Single-leg"], ["add combo", "Combos"]] as const) {
      const button = screen.getByRole("button", { name: label });
      const heading = screen.getByText(title);
      expect(sameLine(heading, button), `"${label}" is not on ${title}'s line`).toBe(true);
      expect(heading.closest(".table-head")!.contains(button),
        `"${label}" is beside ${title} by accident, not inside its heading`).toBe(true);
    }
  });

  it("costs no extra row to do it", async () => {
    await show();
    const h2 = screen.getByText("optionality watchlist");
    const table = document.querySelector("table")!;

    // they used to sit below the muted tables, then on the page heading, and now on their own
    // tables' headings — none of which may push the data down. One row of chrome, the freshness
    // line; the service-status line joins it only when something is wrong.
    const between = [...document.querySelectorAll<HTMLElement>("main > *")].filter((el) => {
      if (el.contains(table) || el.contains(h2)) return false;
      const t = el.getBoundingClientRect().top;
      return t > h2.getBoundingClientRect().bottom && t < table.getBoundingClientRect().top;
    });
    expect(between.length, `chrome rows: ${between.map((e) => e.className || e.tagName).join(", ")}`)
      .toBe(1);
  });
});
