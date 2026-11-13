/** REVIEW's closed trades on the desk (#296), measured in a real layout engine: the journal's table
 *  and an opened trade, its charts and its correction, push nothing sideways from a 900px desk to a
 *  wide one, and no chart label lands on another. The behaviour is `__tests__/NextJournal.test.tsx`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { closedBookService } from "../testing/closedBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

async function review(width: number): Promise<HTMLElement> {
  await page.viewport(width, 900);
  window.fetch = closedBookService().fetch;
  document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await settle();
  // the clock is pinned in session (session.setup.ts); the switch picks this test's mode
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const journal = await screen.findByRole("region", { name: "closed trades" });
  await waitFor(() => expect(journal.querySelectorAll("[data-closed]")).toHaveLength(3));
  return journal;
}

afterEach(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });

describe("the closed trades on the desk", () => {
  for (const width of [900, 1440]) {
    it(`fit a ${width}px desk with a trade open, no chart label over another`, async () => {
      const journal = await review(width);
      fireEvent.click(within(journal).getByRole("button", { name: "1120_P6000" }));
      const trade = await screen.findByRole("region", { name: "closed trade 1120_P6000" });
      await waitFor(() => expect(trade.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
      await settle();
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
