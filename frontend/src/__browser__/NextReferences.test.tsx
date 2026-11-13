/** The Reference strip at a desk, on `/opt/next` (ADR 0018) — carried from `References.test.tsx`
 *  (#337), which measures it on today's `App` and goes with it in #301. The phone's widths are
 *  `NextReferences.iphone.test.tsx`'s.
 *
 *  Measured in session (the suite's pinned clock) and outside it, where every reading also carries
 *  the time it was read (#371). The Live switch is still pressed, as before.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, settle } from "./nextBook";
import { serveReferences, stripLines } from "./nextCarried";

async function show() {
  serveReferences();
  render(<Next />);
  await settle();
  fireEvent.click(within(screen.getByRole("group", { name: "mode" })).getByRole("button", { name: "Live" }));
  await settle();
}

afterEach(async () => { cleanup(); await page.viewport(1280, 900); });

describe("the strip at a desk", () => {
  it("fits on one line, where there is room for it", async () => {
    await page.viewport(1280, 900);
    await show();
    const { items, lines } = stripLines();
    expect(items).toHaveLength(3);
    expect(lines).toBe(1);
  });

  for (const width of [900, 1280, 2560]) {
    it(`outside the session, says every reading's time and keeps each whole at ${width}px (#371)`, async () => {
      vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // a Sunday
      await page.viewport(width, 900);
      await show();
      const { items } = stripLines();
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.textContent).toMatch(/read at 01:00$/);
        expect(item.getBoundingClientRect().right, `${item.textContent} past the edge`).toBeLessThanOrEqual(width + 1);
        expect(item.scrollWidth, `${item.textContent} is clipped`).toBeLessThanOrEqual(item.clientWidth + 1);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }

  it("sits below the freshness line and above the book", async () => {
    await page.viewport(1280, 900);
    await show();
    const strip = document.querySelector(".nx .references")!.getBoundingClientRect();
    const fresh = document.querySelector(".nx .meta")!.getBoundingClientRect();
    const book = document.querySelector(".nx [data-ref]")!.getBoundingClientRect();
    expect(strip.top).toBeGreaterThan(fresh.top);
    expect(strip.bottom).toBeLessThanOrEqual(book.top);
  });
});
