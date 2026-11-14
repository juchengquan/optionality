/** The Reference strip on a phone, on `/opt/next` (ADR 0018) — carried from `References.test.tsx`
 *  (#337), which measures it on today's `App` at a phone's width and goes with it in #301. Runs in
 *  the suite's `iphone` instance: Playwright's iPhone profile, touch and a coarse pointer.
 *
 *  A green suite can hide an unusable UI: the figures are index-sized and each carries a label, a
 *  vendor and a percentage, so three of them is more text than a 390px screen has room for on one
 *  line. This is the measurement, not a reading of the CSS — the strip must WRAP, and nothing on
 *  the page may push it sideways.
 *
 *  Measured in session (the suite's pinned clock) and outside it, where every reading also carries
 *  the time it was read (#371) and the strip is longest. The Book tab is pressed, as Live was.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { serveReferences, stripLines } from "./nextCarried";

async function show() {
  serveReferences();
  render(<Next />);
  await settle();
  fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Book" }));
  await settle();
}

afterEach(async () => { cleanup(); await page.viewport(390, 664); });

describe("the strip on a phone", () => {
  for (const [name, w, h, outside] of [
    ["iPhone 13", 390, 664, false], ["narrow phone", 320, 568, false],
    ["iPhone 13, outside the session", 390, 664, true], ["narrow phone, outside the session", 320, 568, true],
  ] as const) {
    it(`wraps rather than reaching past the edge — ${name}`, async () => {
      if (outside) vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // a Sunday
      await page.viewport(w, h);
      await show();
      const { items, lines } = stripLines();
      expect(items).toHaveLength(3);
      if (outside) for (const item of items) expect(item.textContent).toMatch(/read at 01:00$/);
      // each one whole, inside the page: a figure clipped at the edge is the shape of bug a green
      // suite hides
      for (const item of items) {
        const box = item.getBoundingClientRect();
        expect(box.right, `${item.textContent} reaches past ${w}px`).toBeLessThanOrEqual(w + 1);
        expect(item.scrollWidth, `${item.textContent} is clipped`).toBeLessThanOrEqual(item.clientWidth + 1);
      }
      // and it used more than one line to do it, which is what wrapping means
      expect(lines, "three References fitted on one line at a phone's width").toBeGreaterThan(1);
    });

    it(`does not push the page sideways — ${name}`, async () => {
      if (outside) vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));
      await page.viewport(w, h);
      await show();
      expect(overflowsSideways()).toBe(false);
    });
  }

  it("sits below the freshness line and above the cards", async () => {
    await show();
    const strip = document.querySelector(".nx .references")!.getBoundingClientRect();
    const fresh = document.querySelector(".nx .meta")!.getBoundingClientRect();
    const card = document.querySelector(".nx [data-ref]")!.getBoundingClientRect();
    expect(strip.top).toBeGreaterThan(fresh.top);
    expect(strip.bottom).toBeLessThanOrEqual(card.top);
  });
});
