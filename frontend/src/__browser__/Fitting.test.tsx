import { render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The only tests that need a real layout engine (ADR 0008).
 *
 *  Everything about the fitting RULE is proven in jsdom by Fitting.test.ts. What cannot be
 *  proven there is whether the measuring works at all: jsdom reports every element as zero
 *  wide, so a table that fits nothing and a table that fits everything look identical to it.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const row = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: {
    name: "SPXW 261120 8100.00C", option_delta: 0.1685, option_gamma: 0.00009,
    option_theta: -0.42, option_vega: 0.33, option_implied_volatility: 0.1712,
    mid_price: 31.5, bid_price: 31.3, ask_price: 31.7,
  },
};

function mockApi(rows: unknown[] = [row]) {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? rows : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

/** Resize the REAL viewport, not the body.
 *
 *  Narrowing document.body looks equivalent and is not. Fixed-position elements — the toast
 *  viewport, any sheet — are laid out against the viewport and ignore it entirely, and media
 *  queries never fire at all, so the phone margin and the muted tables' narrow rule went
 *  untested while appearing covered. */
async function atWidth(px: number) {
  await page.viewport(px, 900);
  await new Promise((r) => setTimeout(r, 160));
}

function headers(): string[] {
  return [...document.querySelectorAll("table th")].map((h) => h.textContent ?? "");
}

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("fitting, measured for real", () => {
  it("drops to the name and the alarm on a phone", async () => {
    mockApi();
    render(<App />);
    await atWidth(390);

    const h = headers();
    expect(h[0]).toBe("contract");
    expect(h).toContain("alarm");
    // the whole point: thirteen columns do not survive 390 CSS pixels
    expect(h.length).toBeLessThanOrEqual(4);
  });

  it("shows far more at a desk width", async () => {
    mockApi();
    render(<App />);
    await atWidth(1600);

    expect(headers().length).toBeGreaterThan(8);
  });

  it("never lets anything push the page sideways", async () => {
    mockApi();
    render(<App />);
    for (const w of [320, 390, 768, 1024, 1600]) {
      await atWidth(w);
      // naming the offender matters: "414 > 321" sends you hunting, and the thing that
      // overflows at 320px is rarely the thing you were working on
      const guilty = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > w + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className || "-"}`.slice(0, 60))
        .slice(0, 4);
      expect(guilty, `at ${w}px these spill past the edge`).toEqual([]);
    }
  });

  it("fits fewer columns when the text is bigger, at the same width", async () => {
    mockApi();
    render(<App />);
    await atWidth(900);
    const normal = headers().length;

    // the case no pixel breakpoint can ever handle: the viewport is unchanged and the
    // amount that fits is not
    document.documentElement.style.fontSize = "24px";
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 120));
    const bigger = headers().length;
    document.documentElement.style.fontSize = "";

    expect(bigger).toBeLessThan(normal);
  });

  it("fits fewer columns when the data is wider", async () => {
    const longName = { ...row, snapshot: { ...row.snapshot, name: "SPXW 261120 8100.00C EXTRA LONG" } };
    mockApi([longName]);
    render(<App />);
    await atWidth(700);
    const wide = headers().length;

    document.body.innerHTML = "";
    mockApi([{ ...row, snapshot: { ...row.snapshot, name: "SPX C1" } }]);
    render(<App />);
    await atWidth(700);

    expect(headers().length).toBeGreaterThan(wide);
  });

  it("contains a name too long for the screen instead of moving the page", async () => {
    // the identity column is never dropped, so a name wider than the phone overflows
    // whatever the rest does. It has to be contained by the table, not by the document.
    mockApi([{ ...row, snapshot: { ...row.snapshot, name: "SPXW 261120 8100.00C QUARANTINED LONG NAME" } }]);
    render(<App />);
    await atWidth(320);

    const table = document.querySelector("table")!;
    expect(table.getBoundingClientRect().width).toBeGreaterThan(320);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(321);
  });

  it("gives a phone back the margin a desk can afford", async () => {
    // a media query, which the old harness could never fire: it narrowed document.body,
    // and media queries answer to the viewport
    mockApi();
    render(<App />);

    await atWidth(1280);
    const wide = parseFloat(getComputedStyle(document.body).marginLeft);
    await atWidth(390);
    const narrow = parseFloat(getComputedStyle(document.body).marginLeft);

    expect(narrow).toBeLessThan(wide);
  });
});
