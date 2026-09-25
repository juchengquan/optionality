import { render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The name column must stay put while the rest of the row is swiped, or swiping loses the
 *  one thing that says which row you are reading. position:sticky and border-collapse are
 *  famously uneasy together, so this is measured rather than assumed. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const combo = {
  id: "m2", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all", positions: [{ id: "p2", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207, snapshot: null,
  combo_value: -0.8, combo_greeks: {},
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 },
         { sign: 1, option_type: "CALL", strike: 8075 }],
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

afterEach(async () => { document.body.innerHTML = ""; await page.viewport(1280, 900); });

describe("the name column while swiping", () => {
  it("stays where it is when the table is scrolled sideways", async () => {
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 160));

    const box = document.querySelector<HTMLElement>(".table-scroll")!;
    const name = screen.getByText("261120 8100C").closest("td")!;
    const before = name.getBoundingClientRect().left;

    box.scrollLeft = 200;
    await new Promise((r) => setTimeout(r, 80));
    expect(box.scrollLeft, "the table did not actually scroll").toBeGreaterThan(0);

    // the row's identity must not slide away with everything else
    expect(Math.abs(name.getBoundingClientRect().left - before)).toBeLessThan(2);
  });

  it("keeps a visible edge after the row has been swiped under it", async () => {
    /* This test previously asserted getComputedStyle(cell).borderRightWidth > 0 and passed
       while the edge was visibly MISSING on a swipe. Computed style reports what was
       DECLARED; with border-collapse the edge between two cells is painted once by
       agreement between them, and the cell that paints this one scrolls away underneath the
       sticky column. A declaration was never evidence of a painted line.
       No assertion available here can see paint. So this asserts the technique that makes
       paint correct — a box-shadow, which border collapsing does not touch — and says so
       rather than implying more than it checks. */
    mockApi();
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 160));

    const box = document.querySelector<HTMLElement>(".table-scroll")!;
    const name = screen.getByText("261120 8100C").closest("td")!;

    box.scrollLeft = 200;
    await new Promise((r) => setTimeout(r, 80));

    const shadow = getComputedStyle(name).boxShadow;
    expect(shadow, "the frozen column has no shadow to stand in for its border")
      .not.toBe("none");
    // and it must be an opaque line, not a soft glow that reads as nothing
    expect(shadow).toMatch(/0px 0px 0px|1px 0px 0px/);
  });

  it("does not let the frozen name eat the screen", async () => {
    // a sticky column occupies its width at EVERY scroll position, so a wide one is not
    // merely wide — it permanently shrinks the window you swipe the figures through. At
    // 390px an uncapped "1016_bs_8050" took 51% of the container and left room for two
    // columns at a time.
    mockApi([combo]);
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 200));

    const box = document.querySelector<HTMLElement>(".table-scroll")!;
    const name = screen.getByText(/1016_bs_8050/).closest("td")!;
    const rect = name.getBoundingClientRect();
    const share = rect.width / box.clientWidth;
    expect(share, `the frozen name takes ${Math.round(share * 100)}% of the screen`)
      .toBeLessThan(0.30);
    // and the width must not be bought with unlimited height: letting it wrap freely
    // collapses the column to its narrowest token and folds the name onto three lines
    expect(rect.height, `the name cell is ${Math.round(rect.height)}px tall`)
      .toBeLessThan(70);
  });

  it("still shows the whole name, capped or not", async () => {
    // capping must not truncate: the name is the identity, and half an identity is worse
    // than a narrow column
    mockApi([combo]);
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 200));

    const cell = screen.getByText(/1016_bs_8050/).closest("td")!;
    expect(cell.textContent).toContain("1016_bs_8050");
    // and not clipped away to nothing
    expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
  });
});

describe("the frozen cell's background", () => {
  it("takes the breached row's colour, not the page's", async () => {
    /* The sticky cell must be opaque or the row would show through it while scrolling — so
       it sets a background. That background must LOSE to a breached row's, or a firing row
       would show a plain white name cell against its own alarm colour. The rules share
       specificity, so only source order decides it, which is an easy thing to break by
       tidying a stylesheet. */
    mockApi([{ ...row, triggered: true }]);
    render(<App />);
    await page.viewport(390, 800);
    await new Promise((r) => setTimeout(r, 160));

    const name = screen.getByText("261120 8100C").closest("td")!;
    const neighbour = name.parentElement!.querySelectorAll("td")[2]!;

    /* Compared against its OWN ROW, not against the body. The first version of this test
       compared the cell to document.body and passed regardless, because the body reports
       "oklch(1 0 0)" and cells report "rgb(...)" — two notations that are never equal as
       strings, so the assertion could not fail. Comparing like with like is the whole
       point: the frozen cell must look like the row it belongs to. */
    expect(getComputedStyle(name).backgroundColor,
      "the frozen cell does not match the row it belongs to")
      .toBe(getComputedStyle(neighbour).backgroundColor);
  });
});
