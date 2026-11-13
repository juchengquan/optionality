/** The closed trades on the desk (#296), folded at the bottom of the book since #373, measured in a
 *  real layout engine: the fold shut and opened, and an opened trade, its charts and its correction,
 *  push nothing sideways from a 900px desk to a 2560px one, the trade is brought into view, and no
 *  chart label lands on another. The behaviour is `__tests__/NextJournal.test.tsx`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { closedBookService } from "../testing/closedBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

const WIDTHS = [900, 1280, 2560];

/** The desk at `width`, in session (session.setup.ts), its fold as loaded: shut. */
async function desk(width: number): Promise<HTMLElement> {
  await page.viewport(width, 900);
  window.fetch = closedBookService().fetch;
  document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await settle();
  return screen.getByRole("region", { name: "closed trades" });
}

/** The fold opened by its button, and its three trades drawn. */
async function opened(width: number): Promise<HTMLElement> {
  const journal = await desk(width);
  fireEvent.click(within(journal).getByRole("button", { name: "Closed trades" }));
  await waitFor(() => expect(journal.querySelectorAll("[data-closed]")).toHaveLength(3));
  await settle();
  return journal;
}

/** Wholly inside the window: left, right, top and bottom. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5
    && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5;
}

afterEach(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });

describe("the closed trades' fold on the desk", () => {
  for (const width of WIDTHS) {
    it(`is shut at ${width}px, the last thing in the book and across its width, pushing nothing sideways`, async () => {
      const journal = await desk(width);
      const book = document.querySelector<HTMLElement>(".nx-book")!;
      expect(book.lastElementChild).toBe(journal);
      expect(journal.querySelector("[data-closed]")).toBeNull();
      // across the whole book, under the table, whatever the inspector does beside it
      expect(Math.abs(journal.getBoundingClientRect().width - book.getBoundingClientRect().width)).toBeLessThan(1);
      const table = book.querySelector(".nxd-table")!.getBoundingClientRect();
      expect(journal.getBoundingClientRect().top).toBeGreaterThanOrEqual(table.bottom - 0.5);
      const button = within(journal).getByRole("button", { name: "Closed trades" }).getBoundingClientRect();
      expect(button.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
      expect(button.height).toBeGreaterThanOrEqual(24);
      expect(overflowsSideways()).toBe(false);
    });

    it(`opens at ${width}px into view, its table inside the window`, async () => {
      const journal = await opened(width);
      // brought into view by the press: the first trade's row is on the screen
      expect(onScreen(journal.querySelector("[data-closed]")!)).toBe(true);
      expect(journal.querySelector("table")!.getBoundingClientRect().right)
        .toBeLessThanOrEqual(document.documentElement.clientWidth);
      expect(overflowsSideways()).toBe(false);
    });
  }

  for (const width of WIDTHS) {
    it(`fits a ${width}px desk with a trade open, brought into view, no chart label over another`, async () => {
      const journal = await opened(width);
      fireEvent.click(within(journal).getByRole("button", { name: "1120_P6000" }));
      const trade = await screen.findByRole("region", { name: "closed trade 1120_P6000" });
      await waitFor(() => expect(trade.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
      await settle();
      // the opened trade's heading is on the screen, the focus on it
      const heading = within(trade).getByRole("heading", { name: "1120_P6000" });
      expect(onScreen(heading)).toBe(true);
      expect(document.activeElement).toBe(heading);
      const edge = document.documentElement.clientWidth;
      expect(journal.querySelector("table")!.getBoundingClientRect().right).toBeLessThanOrEqual(edge);
      // the burndown, the IV and where SPX was (#298): a closed trade reads the same samples
      const charts = [...trade.querySelectorAll<SVGSVGElement>(".nx-hist svg")];
      expect(charts).toHaveLength(3);
      for (const svg of charts) {
        const r = svg.getBoundingClientRect();
        expect(r.right).toBeLessThanOrEqual(edge);
        const labels = [...svg.querySelectorAll("text")].filter((t) => t.textContent);
        for (const t of labels) {
          const q = t.getBoundingClientRect();
          expect(q.left >= r.left - 0.5 && q.right <= r.right + 0.5, t.textContent ?? "").toBe(true);
          for (const u of labels) {
            if (u === t) continue;
            const p = u.getBoundingClientRect();
            const over = q.left < p.right - 1 && p.left < q.right - 1 && q.top < p.bottom - 1 && p.top < q.bottom - 1;
            expect(over, `${t.textContent} / ${u.textContent}`).toBe(false);
          }
        }
      }
      // and one day at the same x in all three, as an open holding's are (#298's shared margins)
      const centre = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      const burndown = centre(trade.querySelector('[data-sample="2026-11-03"] circle'));
      const iv = [...trade.querySelectorAll('[aria-label="IV by leg"] circle[data-dte="17"]')].map(centre);
      const spx = centre(trade.querySelector('circle[data-spx-day="2026-11-03"]'));
      expect(iv.length).toBeGreaterThan(0);
      for (const x of [...iv, spx]) expect(Math.abs(x - burndown)).toBeLessThan(0.75);
      expect(overflowsSideways()).toBe(false);
    });
  }
});
