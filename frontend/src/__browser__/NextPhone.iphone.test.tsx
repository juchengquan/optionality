/** The phone's cards, detail sheet and REVIEW pages (#290), MEASURED under Playwright's iPhone
 *  profile — touch, `isMobile`, a 390px screen — on the owner-shaped book both arrangements are
 *  held to. Runs in the suite's `iphone` instance only.
 *
 *  What is measured, not read from the code: nothing pushes the page sideways, every target a
 *  finger hits is 44pt, a tap ANYWHERE on a card reaches it (its text lets taps through to the
 *  button laid over it), Back closes the sheet and leaves the page where it was, and REVIEW's
 *  pages are each one screen wide.
 */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, settle } from "./nextBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES } from "../testing/ownerBook";

afterEach(cleanup);

/** The owner-shaped book (`testing/ownerBook.ts`), the same fixture the desk's table is held to,
 *  so "the same book as A" is a fact about the data rather than a claim. Served from this file
 *  rather than a helper beside `nextBook.ts`, because a non-test module may not import test
 *  support (`make check-test-support`). Every write is refused: a layout suite never changes it. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

function serveOwnerBook(quotes: object[] = QUOTES): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    // the payoff's POST is a read, and is answered (#291)
    const payoff = payoffAnswer(String(url).replace(/^.*\/api/, ""));
    if (payoff) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoff) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({
        ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }),
      });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? quotes : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

async function show(view: "Live" | "Review" = "Live", quotes: object[] = QUOTES) {
  serveOwnerBook(quotes);
  render(<Next />);
  await settle();
  // the mode follows the real clock here; the tab makes it this test's
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: view }));
  await settle();
  window.scrollTo(0, 0);
}

const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>(".nx [data-ref]")].find((el) => el.dataset.ref === ref)!;

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

/** Every control a finger has to hit, on the whole document: the sheet is drawn in a portal. */
function tooSmall(): string[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(button, select, input, a)")]
    .filter((el) => el.getClientRects().length > 0 && el.getAttribute("type") !== "hidden")
    .flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
        : [];
    });
}

/** Anything inside a box that reaches past the screen's right edge. */
function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => !el.closest(".nxp-track")) // the pager's track scrolls sideways by design
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("the Live cards", () => {
  it("push nothing sideways", async () => {
    await show();
    expect(card("h-calls")).toBeTruthy();
    expect(overflowsSideways()).toBe(false);
    expect(pastTheEdge(document.querySelector(".nx")!)).toEqual([]);
  });

  it("give every control a 44pt target, each card's included", async () => {
    await show();
    // three holdings and four watched rules: every card is a target, and is measured as one
    expect(document.querySelectorAll(".nxp-open").length).toBe(7);
    expect(tooSmall()).toEqual([]);
  });

  it("are one target each: a tap on a card's figures opens it", async () => {
    await show();
    // its large P&L, the part of the card a thumb lands on: what is under the thumb there is the
    // card's button, and a tap at that point (forced, since the figure itself takes no taps) opens it
    const figure = card("h-calls").querySelector<HTMLElement>(".nxp-hero [data-money]")!;
    figure.scrollIntoView({ block: "center" });
    const r = figure.getBoundingClientRect();
    const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(under?.getAttribute("aria-label")).toBe("details of 1218_C7300");
    await userEvent.click(figure, { force: true });
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "1218_C7300" })).toBeTruthy();
  });

  it("are reached from a banner, brought into view and marked", async () => {
    await show();
    const target = card("w-dec04");
    // worth nothing unless the card starts out of view
    expect(target.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    const banners = screen.getByRole("status", { name: "needs you" });
    await userEvent.click(within(banners).getByRole("button", { name: /1204_P6900 entry signal/ }));
    await new Promise((r) => setTimeout(r, 900));
    const r = target.getBoundingClientRect();
    expect(target.hasAttribute("data-revealed")).toBe(true);
    expect(r.top >= 0 && r.bottom <= window.innerHeight).toBe(true);
  });
});

describe("the detail sheet", () => {
  async function openSheet(ref: string) {
    await show();
    window.scrollTo(0, 400);
    await settle();
    await userEvent.click(within(card(ref)).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    await animationsDone();
    return sheet;
  }

  it("rises from the bottom, inside the screen, pushing nothing sideways", async () => {
    const sheet = await openSheet("h-ic");
    const r = sheet.getBoundingClientRect();
    expect(Math.round(r.bottom)).toBe(window.innerHeight);
    expect(r.top).toBeGreaterThan(0);
    expect(r.left).toBe(0);
    expect(overflowsSideways()).toBe(false);
    expect(pastTheEdge(sheet)).toEqual([]);
  });

  for (const [ref, what] of [["h-ic", "a held condor"], ["w-dec18", "a watched spread"]] as const) {
    it(`draws ${what}'s payoff at expiry inside the screen, scrolling nothing sideways (#291)`, async () => {
      const sheet = await openSheet(ref);
      const payoff = await within(sheet).findByRole("group", { name: "payoff at expiry" });
      const svg = await waitFor(() => {
        const found = payoff.querySelector<SVGSVGElement>("svg");
        if (!found) throw new Error("no chart yet");
        return found;
      });
      // drawn across the sheet's width, not a thumbnail of it
      expect(svg.getBoundingClientRect().width).toBeGreaterThan(300);
      expect(payoff.querySelector("[data-marker='spx']")).toBeTruthy();
      expect(pastTheEdge(sheet)).toEqual([]);
      // and no label cut by the chart's own edge, which clips rather than overflows
      const box = svg.getBoundingClientRect();
      expect([...svg.querySelectorAll("text")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
      }).map((t) => t.textContent)).toEqual([]);
      expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
      expect(overflowsSideways()).toBe(false);
    });
  }

  it("colours a fired entry's progress bar as the card does, though it is drawn outside the page", async () => {
    const sheet = await openSheet("w-dec04");
    const bar = within(sheet).getByRole("progressbar").firstElementChild as HTMLElement;
    const onCard = card("w-dec04").querySelector<HTMLElement>(".nxp-progress > span")!;
    // a probe in the sheet painted with the entry token, as the page resolves it there
    const probe = document.createElement("span");
    probe.style.background = "var(--entry)";
    sheet.append(probe);
    const entry = getComputedStyle(probe).backgroundColor;
    probe.remove();
    expect(getComputedStyle(bar).backgroundColor).toBe(entry);
    expect(getComputedStyle(onCard).backgroundColor).toBe(getComputedStyle(bar).backgroundColor);
  });

  it("gives its controls 44pt targets", async () => {
    await openSheet("w-dec18");
    expect(tooSmall()).toEqual([]);
  });

  it("closes on the browser's Back without leaving the page, where it was", async () => {
    await openSheet("h-calls");
    const href = location.href;
    const scrolled = window.scrollY;
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(location.href).toBe(href);
    expect(document.querySelector(".nx")).toBeTruthy();
    expect(card("h-calls")).toBeTruthy();
    expect(Math.abs(window.scrollY - scrolled)).toBeLessThan(2);
  });

  it("closes on its own button and gives its Back entry back, so the next Back is not swallowed", async () => {
    await show();
    // the entry the page is on, marked, so "back where it was" is a fact rather than a guess
    history.replaceState({ before: "the sheet" }, "");
    await userEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    await screen.findByRole("dialog");
    await animationsDone();
    expect(history.state?.panel).toBe(true);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    // the entry it pushed was taken back off: the page is on the entry it was on before
    await waitFor(() => expect(history.state?.before).toBe("the sheet"));
  });
});

describe("REVIEW", () => {
  const track = () => document.querySelector<HTMLElement>(".nxp-track")!;
  const pages = () => [...document.querySelectorAll<HTMLElement>("[data-page]")];
  const review = () => screen.getByRole("region", { name: "Review" });

  it("is one holding per screen", async () => {
    await show("Review");
    expect(pages().map((p) => p.dataset.ref)).toEqual(["h-calls", "h-puts", "h-ic"]);
    for (const p of pages()) expect(Math.round(p.getBoundingClientRect().width)).toBe(document.documentElement.clientWidth);
    expect(Math.round(pages()[0]!.getBoundingClientRect().left)).toBe(0);
    expect(overflowsSideways()).toBe(false);
  });

  it("pages forward with the arrow, the next holding brought fully onto the screen", async () => {
    await show("Review");
    await userEvent.click(within(review()).getByRole("button", { name: "next holding" }));
    await waitFor(() => expect(Math.round(pages()[1]!.getBoundingClientRect().left)).toBe(0), { timeout: 2000 });
    expect(within(review()).getByText("2 of 3")).toBeTruthy();
    expect(overflowsSideways()).toBe(false);
  });

  it("follows a swipe: the index is where the track came to rest", async () => {
    await show("Review");
    track().scrollTo({ left: 2 * track().clientWidth });
    await waitFor(() => expect(within(review()).getByText("3 of 3")).toBeTruthy());
    expect(within(review()).getByRole("button", { name: "next holding" }).hasAttribute("disabled")).toBe(true);
  });

  it("follows a banner to a rule two pages ahead: the page it is on, fully on the screen", async () => {
    // the 4-leg condor's rule rings; its holding is the third page
    const ringing = QUOTES.map((q) => q.id === "r-ic" ? { ...q, triggered: true, watched: 6.4, distance: -0.4 } : q);
    await show("Review", ringing);
    expect(within(review()).getByText("1 of 3")).toBeTruthy();
    const banners = screen.getByRole("status", { name: "needs you" });
    await userEvent.click(within(banners).getByRole("button", { name: /1231_IC ringing/ }));
    await new Promise((r) => setTimeout(r, 1200));
    expect(within(review()).getByText("3 of 3")).toBeTruthy();
    expect(Math.round(pages()[2]!.getBoundingClientRect().left)).toBe(0);
    const row = card("r-ic");
    const r = row.getBoundingClientRect();
    expect(row.hasAttribute("data-revealed")).toBe(true);
    expect(r.left >= 0 && r.right <= window.innerWidth).toBe(true);
    expect(r.top >= 0 && r.bottom <= window.innerHeight).toBe(true);
  });

  it("gives every control a 44pt target", async () => {
    await show("Review");
    expect(tooSmall()).toEqual([]);
  });
});
