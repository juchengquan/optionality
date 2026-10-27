import { cleanup, render, screen } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** The holdings list, MEASURED.
 *
 *  A new surface, so it gets measured rather than read. The standing lesson here is that the
 *  functional suite passes on a form nobody can operate: every control in both add-forms was
 *  86px wide and the strike box 22px while every payload test was green. This list carries a
 *  native date input, whose intrinsic width (dd/mm/yyyy plus a calendar button) is not something
 *  a `w-40` can shrink below — so a fixed width here is a clipping waiting to happen.
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

async function openHoldings() {
  window.fetch = ((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    const u = String(url);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        u.includes("/positions/values") ? [spread]
          : u.endsWith("/quotes") ? [] : u.endsWith("/monitors") ? [] : health),
    });
  }) as typeof window.fetch;
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /holdings/i }));
  return await screen.findByTestId("holdings");
}

afterEach(cleanup);

/** 320 is in here on purpose. At 390 the edit form fits on one line with room to spare, so
 *  `flex-wrap` was inert and a mutation sweep proved it: removing the class changed nothing.
 *  320px is a small phone, and the same width a 390px screen shows at 125% browser zoom. */
const WIDTHS: [string, number, number][] = [
  ["small phone", 320, 844], ["phone", 390, 844], ["desk", 1280, 900],
];

describe("the holdings list fits the page", () => {
  for (const [name, w, h] of WIDTHS) {
    it(`never pushes the page sideways — ${name}`, async () => {
      await page.viewport(w, h);
      const panel = await openHoldings();
      // the page body must not scroll horizontally; only a table or a code block may, each in
      // its own overflow container, and this list is neither
      expect(panel.scrollWidth, `holdings panel at ${w}px`)
        .toBeLessThanOrEqual(panel.clientWidth + 1);
      expect(document.documentElement.scrollWidth)
        .toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
    });

    it(`shows every figure without clipping its text — ${name}`, async () => {
      await page.viewport(w, h);
      const panel = await openHoldings();
      for (const dd of [...panel.querySelectorAll("dd"), ...panel.querySelectorAll("dt")]) {
        expect(dd.scrollWidth, `"${dd.textContent}" at ${w}px`)
          .toBeLessThanOrEqual(dd.clientWidth + 1);
      }
    });

    it(`keeps every figure's label on one line — ${name}`, async () => {
      // A label that WRAPS is not clipped, so the test above cannot see one squeezed into a
      // column too narrow for it: "cost to close" in a quarter of a phone simply becomes two
      // lines. A mutation sweep found that forcing four columns at every width changed nothing
      // any assertion could detect. This measures the text against the box it was given.
      await page.viewport(w, h);
      const panel = await openHoldings();
      const ctx = document.createElement("canvas").getContext("2d")!;
      const labels = [...panel.querySelectorAll("dt")];
      expect(labels.length).toBeGreaterThan(3);
      for (const dt of labels) {
        const cs = getComputedStyle(dt);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const needs = ctx.measureText(dt.textContent ?? "").width;
        const room = dt.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        expect(needs, `"${dt.textContent}" needs ${Math.round(needs)}px of ${Math.round(room)}px at ${w}px`)
          .toBeLessThanOrEqual(room);
      }
    });

    it(`gives the date input room for the whole date — ${name}`, async () => {
      // a native date input has an intrinsic minimum: the dd/mm/yyyy text plus a calendar
      // button. A fixed w-40 cannot shrink below it, so the box either fits or overflows.
      await page.viewport(w, h);
      const panel = await openHoldings();
      const date = panel.querySelector('input[type="date"]') as HTMLInputElement;
      expect(date, "a date input").toBeTruthy();
      expect(date.scrollWidth, `the date box at ${w}px`)
        .toBeLessThanOrEqual(date.clientWidth + 1);
      expect(date.clientWidth, `the date box is ${date.clientWidth}px wide`)
        .toBeGreaterThanOrEqual(110);
    });

    it(`keeps the entry box usable rather than collapsed — ${name}`, async () => {
      await page.viewport(w, h);
      const panel = await openHoldings();
      const box = panel.querySelector('input[inputmode], input[type="text"]') as HTMLInputElement;
      expect(box, "an entry box").toBeTruthy();
      expect(box.clientWidth, `the entry box is ${box.clientWidth}px wide`)
        .toBeGreaterThanOrEqual(60);
    });
  }
});
