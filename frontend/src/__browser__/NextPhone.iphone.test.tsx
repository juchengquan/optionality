/** The phone's cards and detail sheet (#290), MEASURED under Playwright's iPhone profile — touch,
 *  `isMobile`, a 390px screen — on the owner-shaped book both arrangements are held to. Runs in the
 *  suite's `iphone` instance only.
 *
 *  What is measured, not read from the code: nothing pushes the page sideways, every target a
 *  finger hits is 44pt, a tap ANYWHERE on a card reaches it (its text lets taps through to the
 *  button laid over it), Back closes the sheet and leaves the page where it was, and a holding's
 *  history fits the sheet, shut in session and open from the start outside it (#374).
 */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";

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

function serveOwnerBook(quotes: object[] = QUOTES, holdings: object[] = HOLDINGS): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    // the payoff's POST is a read, and is answered (#291)
    const payoff = payoffAnswer(String(url).replace(/^.*\/api/, ""));
    // and a holding's samples (#295), a read too: an empty list in their place would break the page
    const read = payoff ?? samplesAnswer(String(url).replace(/^.*\/api/, ""))
      // and the pace split (#333), read once when a holding is opened
      ?? volAnswer(String(url).replace(/^.*\/api/, ""));
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({
        ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }),
      });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? quotes : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? holdings : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** The Book tab: in session unless the test pins another instant (session.setup.ts). */
async function show(quotes: object[] = QUOTES, holdings: object[] = HOLDINGS) {
  serveOwnerBook(quotes, holdings);
  render(<Next />);
  await settle();
  window.scrollTo(0, 0);
}

/** A Sunday, outside the session: a holding's sheet opens with its history open (#374). */
const outsideTheSession = () => vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));

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
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("the cards", () => {
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

describe("a holding's history in its sheet: on demand in session (#353), open outside it (#374)", () => {
  for (const [ref, days, session] of [
    ["h-calls", 7, true], ["h-ic", 2, true], ["h-calls", 7, false], ["h-ic", 2, false],
  ] as const) {
    it(`draws ${ref}'s three charts inside the screen ${session ? "when opened in session" : "at once outside the session"}, every target still 44pt`, async () => {
      if (!session) outsideTheSession();
      await show();
      await userEvent.click(within(card(ref)).getByRole("button", { name: /details of/ }));
      const sheet = await screen.findByRole("dialog");
      await animationsDone();
      const toggle = within(sheet).getByRole("button", { name: "history" });
      expect(toggle.getAttribute("aria-expanded")).toBe(session ? "false" : "true");
      if (session) {
        expect(sheet.querySelector(".nx-hist")).toBeNull();
        await userEvent.click(toggle);
      }
      await waitFor(() => expect(sheet.querySelectorAll(".nx-hist svg")).toHaveLength(3));
      await settle();
      expect(sheet.querySelectorAll("[data-sample]")).toHaveLength(days);
      for (const svg of sheet.querySelectorAll<SVGSVGElement>(".nx-hist svg")) {
        const r = svg.getBoundingClientRect();
        // across the sheet, not a thumbnail of it
        expect(r.width).toBeGreaterThan(300);
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
      expect(pastTheEdge(sheet)).toEqual([]);
      expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
      expect(overflowsSideways()).toBe(false);
      expect(tooSmall()).toEqual([]);
    });
  }
});

describe("the pace explained, in a holding's sheet (#333)", () => {
  /** every holding with an exit schedule, so each sheet has a gap to explain */
  const scheduled = HOLDINGS.map((h) => ({ ...h, schedule: { dte_at_open: 45, on_pace: 1.84, pace_gap: 0.47,
    target: 1, stop: 4, target_dte: 11, manage_by_dte: 21, reached: null, manage_by_due: false } }));

  // the call spread's split is declined with the route's longest sentence and what would cover it;
  // the put spread's is split whole
  for (const ref of ["h-calls", "h-puts"]) {
    it(`fits ${ref}'s inside the screen, scrolling nothing sideways`, async () => {
      await show(QUOTES, scheduled);
      await userEvent.click(within(card(ref)).getByRole("button", { name: /details of/ }));
      const sheet = await screen.findByRole("dialog");
      await animationsDone();
      const pace = within(sheet).getByRole("region", { name: "the pace explained" });
      await waitFor(() => expect(pace.querySelector("[data-split]")).toBeTruthy());
      // worth nothing unless it is there to be measured, across the sheet rather than squeezed
      expect(pace.getBoundingClientRect().width).toBeGreaterThan(300);
      expect(pace.textContent).toMatch(/opened at 45 DTE/);
      expect(pastTheEdge(sheet)).toEqual([]);
      expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
      expect(overflowsSideways()).toBe(false);
      // it adds no control, and leaves every one on the sheet a finger's width
      expect(pace.querySelectorAll("button, a, input, select")).toHaveLength(0);
      expect(tooSmall()).toEqual([]);
    });
  }
});

describe("the book outside the session (#374)", () => {
  it("is the same cards, no pager, nothing pushed sideways and every target 44pt", async () => {
    outsideTheSession();
    await show();
    expect(document.querySelector("[data-page], .nxp-pager, .nxp-track")).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>("article.nxp-holding")].map((a) => a.dataset.ref))
      .toEqual(["h-calls", "h-puts", "h-ic"]);
    expect(overflowsSideways()).toBe(false);
    expect(pastTheEdge(document.querySelector(".nx")!)).toEqual([]);
    expect(tooSmall()).toEqual([]);
  });

  it("follows a banner to a holding's rule: its card brought into view and marked", async () => {
    // the 4-leg condor's rule rings, its own alarm said at every hour; its holding is the third card
    const ringing = QUOTES.map((q) => q.id === "r-ic" ? { ...q, triggered: true, watched: 6.4, distance: -0.4 } : q);
    outsideTheSession();
    await show(ringing);
    const banners = screen.getByRole("status", { name: "needs you" });
    await userEvent.click(within(banners).getByRole("button", { name: /1231_IC ringing/ }));
    await new Promise((r) => setTimeout(r, 1200));
    const row = card("r-ic");
    const r = row.getBoundingClientRect();
    expect(row.hasAttribute("data-revealed")).toBe(true);
    expect(r.left >= 0 && r.right <= window.innerWidth).toBe(true);
    expect(r.top >= 0 && r.bottom <= window.innerHeight).toBe(true);
  });

  it("says why a day is not the close when it is tapped in the sheet, from anywhere near it", async () => {
    outsideTheSession();
    await show();
    await userEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    await animationsDone();
    await waitFor(() => expect(sheet.querySelectorAll(".nx-bd [data-sample]").length).toBeGreaterThan(0));
    const svg = sheet.querySelector<SVGSVGElement>(".nx-hist svg")!;
    svg.scrollIntoView({ block: "center" });
    await settle();
    const said = sheet.querySelector(".nx-hist-said")!;
    // the first day, h-calls' opening day, was recorded that evening: tapped beside it, not on it,
    // since a finger is wider than the days are apart
    const first = sheet.querySelector<SVGCircleElement>("[data-sample] [data-mark]")!.getBoundingClientRect();
    const box = svg.getBoundingClientRect();
    await userEvent.click(svg, { position: { x: first.left - box.left + 6, y: first.top - box.top + 14 } });
    expect(said.textContent).toMatch(/^3 Nov · 45 DTE .* not the close: observed 20:30 New York, after the 16:15 close/);
  });
});

/** "market closed — valued at 01:00" and its refresh (#371), on the Book tab outside the session: not
 *  clipped, nothing pushed sideways, and the button a 44pt target. */
describe("the market-closed line on the phone", () => {
  const stamped = HOLDINGS.map((h) => ({ ...h, fetched_at: "2026-11-16 01:00:12+08:00" }));
  it("fits on the Book tab, with its refresh a 44pt target", async () => {
    outsideTheSession();
    await show(QUOTES, stamped);
    const line = document.querySelector<HTMLElement>(".nx-mkt-closed")!;
    expect(line.textContent).toBe("market closed — valued at 01:00refresh");
    const button = within(line).getByRole("button", { name: "refresh the valuation" });
    const b = button.getBoundingClientRect();
    expect(b.width, "the refresh's width").toBeGreaterThanOrEqual(44);
    expect(b.height, "the refresh's height").toBeGreaterThanOrEqual(44);
    const box = line.getBoundingClientRect();
    for (const el of [line, ...line.querySelectorAll<HTMLElement>("*")]) {
      const r = el.getBoundingClientRect();
      expect(r.left >= box.left - 0.5 && r.right <= box.right + 0.5, `${el.tagName} inside the line`).toBe(true);
    }
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    expect(pastTheEdge(line)).toEqual([]);
    expect(tooSmall()).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});

/** Outside the session the Level chips say when the holding was valued (#354, #371), and got longer
 *  for it: measured on the cards, in the sheet and with the longest of the three Levels, at the
 *  iPhone's 390px. */
describe("a Level's chip outside the session, with its valuation's time", () => {
  const levelled = HOLDINGS.map((h) => ({
    ...h, fetched_at: "2026-11-16 00:59:05+08:00",
    schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4, target_dte: 11,
      manage_by_dte: 21, reached: h.id === "h-ic" ? "target" : "stop", manage_by_due: false },
  }));
  it("fits on each card and in the sheet, pushing nothing sideways", async () => {
    outsideTheSession();
    await show(QUOTES, levelled);
    for (const ref of ["h-calls", "h-puts", "h-ic"]) {
      const chip = card(ref).querySelector<HTMLElement>(".nx-chip")!;
      expect(chip.textContent).toMatch(/^at (stop|target) · as valued at 00:59$/);
      const box = card(ref).getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      expect(r.left >= box.left && r.right <= box.right, `${ref}'s chip inside its card`).toBe(true);
    }
    expect(overflowsSideways()).toBe(false);

    await userEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    await animationsDone();
    expect(sheet.querySelector(".nx-chip")!.textContent).toBe("at stop · as valued at 00:59");
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});
