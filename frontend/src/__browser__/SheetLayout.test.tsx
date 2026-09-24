import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The detail sheet's layout, measured. jsdom cannot see any of this — every box it
 *  reports is zero wide and zero tall — so "the controls are misaligned" was invisible to
 *  56 passing tests. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const combo = {
  id: "m1", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all", positions: [{ id: "p1", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 }], combo_value: -0.8, combo_greeks: {},
};

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [combo] : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

async function openSheet() {
  mockApi();
  render(<App />);
  await new Promise((r) => setTimeout(r, 120));
  await userEvent.click(screen.getByText("1016_bs_8050"));
  const sheet = await screen.findByRole("dialog");
  await new Promise((r) => setTimeout(r, 120));
  return sheet;
}

/** Do these two sit on the same line? Compares vertical centres, which is what the eye
 *  reads as "aligned" — matching tops would fail for controls of different heights. */
function sameLine(a: Element, b: Element): boolean {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return Math.abs((ra.top + ra.height / 2) - (rb.top + rb.height / 2)) < 6;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("the detail sheet's controls", () => {
  it("keeps each box on the same line as its button", async () => {
    const sheet = await openSheet();

    for (const label of ["set", "rename"]) {
      const button = [...sheet.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) continue;
      const form = button.closest("form")!;
      const box = form.querySelector("input")!;
      const rb = box.getBoundingClientRect();
      const rn = button.getBoundingClientRect();
      const detail = `form display=${getComputedStyle(form).display} ` +
        `box=(${Math.round(rb.left)},${Math.round(rb.top)},w${Math.round(rb.width)}) ` +
        `btn=(${Math.round(rn.left)},${Math.round(rn.top)},w${Math.round(rn.width)})`;
      expect(sameLine(box, button), `"${label}": ${detail}`).toBe(true);
    }
  });

  it("does not let a text box swallow the whole panel", async () => {
    const sheet = await openSheet();
    const rename = [...sheet.querySelectorAll("button")].find((b) => b.textContent === "rename");
    if (!rename) return;
    const box = rename.closest("form")!.querySelector("input")!;

    // a full-width box leaves its button nowhere to go but the next line
    expect(box.getBoundingClientRect().width)
      .toBeLessThan(sheet.getBoundingClientRect().width * 0.75);
  });

  it("lines the figures up in two clean columns", async () => {
    const sheet = await openSheet();
    const values = [...sheet.querySelectorAll("dd")];
    expect(values.length).toBeGreaterThan(3);

    // every value's right edge on the same x: what makes a column of numbers readable
    const rights = values.map((v) => Math.round(v.getBoundingClientRect().right));
    expect(new Set(rights).size, `value column is ragged: ${[...new Set(rights)]}`).toBe(1);
  });
});
