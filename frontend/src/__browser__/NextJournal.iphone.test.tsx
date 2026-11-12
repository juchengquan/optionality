/** REVIEW's closed trades on the phone (#296), MEASURED under Playwright's iPhone profile: the list's
 *  cards each one 44pt target, a trade opened on a screen of its own with its charts inside the
 *  screen and no label over another, the correction's boxes 16px so iOS does not zoom and its
 *  targets 44pt, nothing past the screen's edge, and Back closing the trade. Runs in the suite's
 *  `iphone` instance only; the behaviour is `__tests__/NextJournal.test.tsx`.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { closedBookService } from "../testing/closedBook";
import type { HoldingService } from "../testing/holdingService";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

async function review(): Promise<{ s: HoldingService; journal: HTMLElement }> {
  const s = closedBookService();
  window.fetch = s.fetch;
  render(<Next />);
  await settle();
  // the mode follows the real clock here; the tab makes it this test's
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Review" }));
  const journal = await screen.findByRole("region", { name: "closed trades" });
  await waitFor(() => expect(journal.querySelectorAll("[data-closed]")).toHaveLength(3));
  return { s, journal };
}

/** A sheet slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

/** Every control a finger has to hit inside `root`, under 44pt. */
function tooSmall(root: Element): string[] {
  return [...root.querySelectorAll<HTMLElement>("button, select, input, a")]
    .filter((el) => el.getClientRects().length > 0)
    .flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
        : [];
    });
}

/** Every box under 16px text, which iOS zooms the page to on focus. */
const smallText = (root: Element) => [...root.querySelectorAll("input")]
  .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute("aria-label"));

function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

async function openTrade(journal: HTMLElement, name: string): Promise<HTMLElement> {
  await userEvent.click(within(journal).getByRole("button", { name: `details of ${name}` }));
  const sheet = await screen.findByRole("dialog", { name });
  await animationsDone();
  await waitFor(() => expect(sheet.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
  return sheet;
}

describe("the closed trades on the phone", () => {
  it("lists each trade as one 44pt card, inside the screen", async () => {
    const { journal } = await review();
    expect(tooSmall(journal)).toEqual([]);
    expect(pastTheEdge(journal)).toEqual([]);
    // the whole card is the target: its button covers it, inside the card's 1px border
    for (const card of journal.querySelectorAll<HTMLElement>("[data-closed]")) {
      const b = card.querySelector("button")!.getBoundingClientRect();
      expect(Math.round(b.width)).toBe(card.clientWidth);
      expect(Math.round(b.height)).toBe(card.clientHeight);
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("opens one trade on a screen of its own, its charts inside the screen and no label over another", async () => {
    const { journal } = await review();
    const sheet = await openTrade(journal, "1120_P6000");
    const charts = [...sheet.querySelectorAll<SVGSVGElement>(".nx-hist svg")];
    // the burndown, the IV and where SPX was (#298)
    expect(charts).toHaveLength(3);
    for (const svg of charts) {
      const r = svg.getBoundingClientRect();
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
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
    // the close is marked, and the last day drawn is on it
    const mark = charts[0]!.querySelector("[data-close] line")!.getBoundingClientRect();
    const last = [...charts[0]!.querySelectorAll("[data-sample] circle")].at(-1)!.getBoundingClientRect();
    expect(Math.abs((last.left + last.right) / 2 - mark.left)).toBeLessThan(1.5);
    expect(tooSmall(sheet)).toEqual([]);
    expect(smallText(sheet)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });

  it("corrects a close from the trade's screen, and the list says what it now made", async () => {
    const { s, journal } = await review();
    const sheet = await openTrade(journal, "1120_P6000");
    const fix = within(sheet).getByRole("form", { name: "correct the close of 1120_P6000" });
    await userEvent.fill(within(fix).getByLabelText("exit, per contract"), "0.7");
    await userEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(s.writes().map((w) => [`${w.method} ${w.path}`, w.body]))
      .toEqual([["PATCH /positions/c-old", { exit: 0.7 }]]));
    await waitFor(() => expect(sheet.querySelector('[data-fig="made"]')?.textContent).toBe("3.9 pts"));
    await waitFor(() => expect(journal.querySelector('[data-closed="c-old"] [data-fig="made"]')?.textContent).toBe("3.9 pts"));
  });

  it("asks before deleting a trade, in 44pt targets, and closes its screen once it is gone", async () => {
    const { s, journal } = await review();
    const sheet = await openTrade(journal, "1120_P6000");
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));
    const ask = within(sheet).getByRole("group", { name: "delete 1120_P6000?" });
    expect(tooSmall(ask)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Keep it" }));
    await userEvent.click(within(ask).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(s.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["DELETE /positions/c-old"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(journal.querySelector('[data-closed="c-old"]')).toBeNull());
    expect(overflowsSideways()).toBe(false);
  });

  it("opens a trade on its title, never on a box: no keyboard comes up, and the poll is not held", async () => {
    const { journal } = await review();
    await userEvent.click(within(journal).getByRole("button", { name: "details of 1120_P6000" }));
    const sheet = await screen.findByRole("dialog", { name: "1120_P6000" });
    await animationsDone();
    await waitFor(() => expect(sheet.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
    expect(document.activeElement).toBe(within(sheet).getByRole("heading", { name: "1120_P6000" }));
    expect(document.activeElement?.closest('[data-poll="hold"]')).toBeNull();
  });

  it("closes the trade with Back, and leaves the page on REVIEW", async () => {
    const { journal } = await review();
    await openTrade(journal, "1120_P6000");
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "closed trades" })).toBeTruthy();
  });
});
