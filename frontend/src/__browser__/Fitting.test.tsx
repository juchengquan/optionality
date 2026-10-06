import { render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

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

/** A combo, because the combo table is where the fitting went wrong and there was no combo
 *  here to see it. Shaped like the owner's own iron condor, whose name is the widest identity
 *  on either table and whose leg summary is the widest column anywhere. */
const combo = {
  id: "c1", code: "1120_IC_7100_8200", field: "mid_price", threshold: 7.81,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 97, scope: "all", positions: [{ id: "p2", name: "1120_IC_7100_8200" }],
  cost_to_close: 7.55, combo_value: -7.55, entry: 6.86, pnl: -69,
  legs: [
    { sign: -1, option_type: "CALL", strike: 8200 },
    { sign: 1, option_type: "CALL", strike: 8250 },
    { sign: -1, option_type: "PUT", strike: 7100 },
    { sign: 1, option_type: "PUT", strike: 7050 },
  ],
  combo_greeks: {
    option_delta: -0.0123, option_gamma: 0.00004, option_theta: 0.21, option_vega: -0.18,
  },
  snapshot: null,
};

/** the headers of one table, in order. `headers()` above reads BOTH tables at once, which is
 *  fine while only one is on the page and useless for comparing them. */
function headersOf(which: "single" | "combo"): string[] {
  const table = document.querySelectorAll("table")[which === "single" ? 0 : 1]!;
  return [...table.querySelectorAll("th")].map((h) => (h.textContent ?? "").trim());
}

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
  it("gives a phone more columns than fit, and lets it swipe", async () => {
    mockApi();
    render(<App />);
    await atWidth(390);

    const h = headers();
    expect(h[0]).toBe("contract");
    expect(h).toContain("alarm");
    // this asserted "at most four" until the owner pointed out the table swipes and they
    // would rather have the figures. It now spends up to SCROLL_BUDGET screens.
    expect(h.length).toBeGreaterThan(4);

    const box = document.querySelector<HTMLElement>(".table-scroll")!;
    expect(box.scrollWidth, "there is nothing to swipe").toBeGreaterThan(box.clientWidth);
  });

  it("draws a combo's delta on a phone, and does not starve that table", async () => {
    // The report: "for combo table the behavior is different from single-leg table, for those
    // selected columns they are not shown". Measured here before the fix: the combo table drew
    // six columns to the single table's nine, and delta was not among them — `legs` is the
    // widest column on either table and sat mid-priority, so the loop stopped there and
    // everything after it was unreachable however it was ticked.
    document.cookie = "ui_cols_combo=;path=/";
    document.cookie = "ui_cols_single=;path=/";
    mockApi([row, combo]);
    render(<App />);
    await atWidth(390);

    const single = headersOf("single");
    const combos = headersOf("combo");
    expect(combos, `combo headers were ${combos.join(",")}`).toContain("delta");
    // not asserted as a count, which would pin today's widths: the point is that the two
    // tables now fare alike at the same width
    expect(combos.length, `combo ${combos.length} vs single ${single.length}`)
      .toBeGreaterThanOrEqual(single.length - 1);
  });

  /** What the picker lists, against what the table draws — both directions, because each one
   *  was broken differently.
   *
   *  ADR 0008 promises one of them: "the picker only offers columns that could appear at the
   *  current width", so ticking is never silently ignored. Offerability was measured per column
   *  against the width while the drawing loop spends the budget cumulatively and stops at the
   *  first miss, so at 390px the combo picker offered five columns no amount of ticking could
   *  reveal.
   *
   *  The other direction is written down nowhere and was broken too: a column ON SCREEN must
   *  have a box, or it cannot be turned off. `delta` had none on the combo table, because one
   *  PROTECTED set unioned both tables' pinned columns and delta is pinned on the single-leg one.
   *
   *  A column may legitimately be offered without being drawn — that is exactly a column you
   *  have unticked — so the gap is allowed to be the hidden set, and nothing else.
   */
  async function pickerMatchesTable(hiddenCombo: string) {
    document.cookie = `ui_cols_combo=${hiddenCombo};path=/`;
    document.cookie = "ui_cols_single=;path=/";
    mockApi([row, combo]);
    render(<App />);
    await atWidth(390);

    let checked = 0;
    for (const which of ["single", "combo"] as const) {
      const label = which === "single" ? "Single-leg columns" : "Combos columns";
      const pinned = which === "single" ? ["contract", "delta"] : ["combo"];
      const unticked = which === "combo" && hiddenCombo ? [hiddenCombo] : [];
      const trigger = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      trigger.click();
      await new Promise((r) => setTimeout(r, 160));
      const group = document.querySelector<HTMLElement>(`[role=group][aria-label="${label}"]`)!;
      const offered = [...group.querySelectorAll("label")].map((l) => (l.textContent ?? "").trim());
      const drawn = headersOf(which);

      for (const on of drawn.filter((h) => !pinned.includes(h))) {
        expect(offered, `${which} @390: "${on}" is on screen with no box to turn it off`)
          .toContain(on);
        checked++;
      }
      expect(offered.filter((o) => !drawn.includes(o)).sort(),
        `${which} @390: offered but not drawn, and not unticked either`).toEqual(unticked);

      trigger.click();
      await new Promise((r) => setTimeout(r, 160));
    }
    // an empty popover, or a table drawing nothing, would satisfy every assertion above
    expect(checked, "no checkboxes were examined").toBeGreaterThan(8);
  }

  it("lists exactly the columns on screen in each picker", async () => {
    await pickerMatchesTable("");
  });

  it("still does so once a column has been unticked", async () => {
    await pickerMatchesTable("alarm");
  });

  it("changes the combo table when a box is actually clicked", async () => {
    // the complaint, end to end: tick a box and see whether anything happens. Clicked for real
    // rather than computed, because every layer between the checkbox and the table — the cookie,
    // readHidden, the offer set, the fitting — had a fault in it.
    document.cookie = "ui_cols_combo=;path=/";
    mockApi([row, combo]);
    render(<App />);
    await atWidth(390);
    expect(headersOf("combo")).toContain("delta");

    const trigger = document.querySelector<HTMLElement>('[aria-label="Combos columns"]')!;
    trigger.click();
    await new Promise((r) => setTimeout(r, 160));
    const group = document.querySelector<HTMLElement>('[role=group][aria-label="Combos columns"]')!;
    const deltaBox = [...group.querySelectorAll("label")]
      .find((l) => (l.textContent ?? "").trim() === "delta")!;
    expect(deltaBox, "the combo picker has no delta box at all").toBeTruthy();

    deltaBox.querySelector<HTMLElement>("button, input")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(headersOf("combo"), "unticking delta did not remove it").not.toContain("delta");

    deltaBox.querySelector<HTMLElement>("button, input")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(headersOf("combo"), "ticking delta back did not restore it").toContain("delta");
    document.cookie = "ui_cols_combo=;path=/";
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
      // the DOCUMENT must not scroll. Individual cells legitimately extend past the edge
      // now — that is what .table-scroll is for — so checking element rects would flag the
      // very behaviour the owner asked for.
      expect(document.documentElement.scrollWidth,
        `at ${w}px the page itself scrolls sideways`).toBeLessThanOrEqual(w + 1);

      // and if it does, say what caused it, excluding anything properly contained
      if (document.documentElement.scrollWidth > w + 1) {
        const guilty = [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((el) => !el.closest(".table-scroll"))
          .filter((el) => el.getBoundingClientRect().right > w + 1)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className || "-"}`.slice(0, 60));
        expect(guilty, `at ${w}px these spill past the edge`).toEqual([]);
      }
    }
  });

  it("fits fewer columns when the text is bigger, at the same width", async () => {
    mockApi();
    render(<App />);
    // narrow enough that room is scarce even with the budget, or both sides saturate
    await atWidth(360);
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
    await atWidth(360);
    const wide = headers().length;

    document.body.innerHTML = "";
    mockApi([{ ...row, snapshot: { ...row.snapshot, name: "SPX C1" } }]);
    render(<App />);
    await atWidth(360);

    expect(headers().length).toBeGreaterThan(wide);
  });

  it("contains a name too long for the screen without moving the page or losing it", async () => {
    // the identity column is never dropped, so a very long name has to go somewhere. It is
    // capped and wrapped rather than allowed to push anything: the assertion that matters
    // is that the page stays still AND the whole name survives. This used to assert the
    // table overflowed, which was testing the mechanism rather than the outcome.
    const long = "SPXW 261120 8100.00C QUARANTINED LONG NAME";
    mockApi([{ ...row, snapshot: { ...row.snapshot, name: long } }]);
    render(<App />);
    await atWidth(320);

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(321);
    const cell = document.querySelector("tbody td")!;
    expect(cell.textContent).toContain("QUARANTINED LONG NAME");
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
