import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** The Reference strip, in a real browser at a phone's width (ADR 0018).
 *
 *  A green suite can hide an unusable UI: the figures are index-sized and each one carries a
 *  label, a scale and a percentage, so three of them is more text than a 390px screen has room
 *  for on one line. This is the measurement, not a reading of the CSS — the strip must WRAP, and
 *  nothing on this page may push the document sideways.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "08:44:09" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: null, positions: [], cost_to_close: null, entry: null, pnl: null,
  quote: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, mid_price: 31.5 },
};

/** Three, which is what the owner asked about — and the widest shape each can take: a label, a
 *  proxy, a scale, a four-digit figure and a signed percentage. */
const REFERENCES = [
  {
    id: "r1", code: "US.SPY", label: "SPX", scale: 10, name: "SPDR S&P 500 ETF Trust",
    figure: 7587.3, field: "mid_price", change: 0.003982956650611325, error: null,
  },
  {
    id: "r2", code: "US.QQQ", label: "Nasdaq 100", scale: 25, name: "Invesco QQQ Trust",
    figure: 14962.5, field: "last_price", change: -0.0123, error: null,
  },
  {
    id: "r3", code: "US.VIXY", label: null, scale: null, name: "ProShares VIX Short-Term",
    figure: 42.18, field: "mid_price", change: 0.0415, error: null,
  },
];

async function show() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/references") ? REFERENCES
          : String(url).endsWith("/quotes") ? [leg]
            : String(url).endsWith("/monitors") ? []
              : String(url).includes("/positions") ? []
                : health),
    })) as unknown as typeof fetch;
  render(<App />);
  await new Promise((r) => setTimeout(r, 200));
}

afterEach(async () => { cleanup(); await page.viewport(1280, 900); });

describe("the strip at a phone's width", () => {
  for (const [name, w, h] of [["phone", 390, 844], ["narrow phone", 320, 568]] as const) {
    it(`wraps rather than reaching past the edge — ${name}`, async () => {
      await page.viewport(w, h);
      await show();
      const strip = document.querySelector(".references")!;
      const items = [...strip.querySelectorAll<HTMLElement>(".reference")];
      expect(items).toHaveLength(3);

      // each one whole, inside the page: a figure clipped at the edge is the shape of bug a
      // green suite hides
      for (const item of items) {
        const box = item.getBoundingClientRect();
        expect(box.right, `${item.textContent} reaches past ${w}px`).toBeLessThanOrEqual(w + 1);
        expect(item.scrollWidth, `${item.textContent} is clipped`)
          .toBeLessThanOrEqual(item.clientWidth + 1);
      }
      // and it used more than one line to do it, which is what wrapping means
      const tops = new Set(items.map((i) => Math.round(i.getBoundingClientRect().top)));
      expect(tops.size, "three References fitted on one line at a phone's width").toBeGreaterThan(1);
    });

    it(`does not push the page sideways — ${name}`, async () => {
      await page.viewport(w, h);
      await show();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w + 1);
    });
  }

  it("fits on one line at a desk, where there is room for it", async () => {
    await page.viewport(1280, 900);
    await show();
    const items = [...document.querySelectorAll<HTMLElement>(".references .reference")];
    const tops = new Set(items.map((i) => Math.round(i.getBoundingClientRect().top)));
    expect(tops.size).toBe(1);
  });

  it("sits below the freshness line and above the first table", async () => {
    await page.viewport(390, 844);
    await show();
    const strip = document.querySelector(".references")!.getBoundingClientRect();
    const fresh = document.querySelector(".meta")!.getBoundingClientRect();
    const table = screen.getByText("Single-leg").getBoundingClientRect();
    expect(strip.top).toBeGreaterThan(fresh.top);
    expect(strip.top).toBeLessThan(table.top);
  });
});
