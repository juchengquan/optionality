/** The Reference strip at a desk, on `/opt/next` (ADR 0018) — carried from `References.test.tsx`
 *  (#337), which measures it on today's `App` and goes with it in #301. The phone's widths are
 *  `NextReferences.iphone.test.tsx`'s.
 *
 *  The strip is drawn in LIVE only, so the page is put there by the mode switch: the browser's clock
 *  is the real one, and outside the session it says REVIEW.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { settle } from "./nextBook";
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
