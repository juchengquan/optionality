/** The redesigned page on a phone, under Playwright's iPhone profile (ADR 0023): touch, a coarse
 *  pointer and a 390px screen. Runs in the suite's `iphone` instance only.
 *
 *  What a phone needs that a desk does not: nothing pushed sideways, a 44pt target for every
 *  control, and 16px text in every box, below which iOS zooms the page when a box is focused.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { longBook, overflowsSideways, serveBook, settle } from "./nextBook";

async function show() {
  serveBook();
  render(<Next />);
  await settle();
}

afterEach(cleanup);

/** Every control a finger has to hit — on the whole document, not only inside the page: a
 *  confirmation dialog and a toast are drawn in portals beside it. */
function targets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(button, select, input, a)")]
    .filter((el) => el.getClientRects().length > 0 && el.getAttribute("type") !== "hidden");
}

/** A dialog opens with a zoom from 95%, and a box measured mid-animation is 95% of its size. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
}

function tooSmall(): string[] {
  return targets().flatMap((el) => {
    const r = el.getBoundingClientRect();
    return r.width < 44 || r.height < 44
      ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
      : [];
  });
}

function zooms(): string[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(select, input, textarea)")]
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map((el) => `${el.id || el.tagName} ${getComputedStyle(el).fontSize}`);
}

/** Until the page has come to rest: the same position twice, 150ms apart, within 4.5s. */
async function scrolled(): Promise<void> {
  for (let last = -1, i = 0; window.scrollY !== last && i < 30; i++) {
    last = window.scrollY;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("under the iPhone profile", () => {
  it("is a phone to the page: a coarse pointer, 390px wide", () => {
    // without this the profile could silently not apply and every test below measure a desktop
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    expect(document.documentElement.clientWidth).toBe(390);
  });

  it("chooses the cards", async () => {
    await show();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    expect(screen.getByRole("navigation", { name: "views" })).toBeTruthy();
  });

  it("lays every tab of the bottom bar on one row, and keeps the page's end clear of it", async () => {
    // With a fourth tab (#293) on a three-column grid, Settings wrapped to a second row: the bar
    // grew to two rows and covered the end of the page, which leaves room for one.
    await show();
    const bar = screen.getByRole("navigation", { name: "views" });
    const tabs = within(bar).getAllByRole("button");
    // three since #374: the book, whatever the hour, and no mode to pick
    expect(tabs.map((t) => t.textContent)).toEqual(["Book", "Add", "Settings"]);
    const tops = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)));
    expect(tops.size).toBe(1);
    // they share the bar between them, each a finger's width and height
    const b = bar.getBoundingClientRect();
    const widths = tabs.map((t) => t.getBoundingClientRect().width);
    expect(widths.reduce((x, y) => x + y, 0)).toBeGreaterThan(b.width - 1);
    for (const t of tabs) {
      const r = t.getBoundingClientRect();
      expect(r.width, `${t.textContent}'s width`).toBeGreaterThanOrEqual(44);
      expect(r.height, `${t.textContent}'s height`).toBeGreaterThanOrEqual(44);
      expect(Math.abs(r.width - b.width / tabs.length), `${t.textContent} takes its third`).toBeLessThan(1);
    }
    const lastRight = tabs.at(-1)!.getBoundingClientRect().right;
    expect(lastRight).toBeLessThanOrEqual(document.documentElement.clientWidth + 0.5);
    const main = document.querySelector<HTMLElement>(".nx-main")!;
    expect(parseFloat(getComputedStyle(main).paddingBottom))
      .toBeGreaterThanOrEqual(bar.getBoundingClientRect().height);
  });
});

describe("the Live view", () => {
  it("pushes nothing sideways", async () => {
    await show();
    expect(overflowsSideways()).toBe(false);
  });

  it("gives every control a 44pt target", async () => {
    await show();
    expect(targets().length).toBeGreaterThan(3);
    expect(tooSmall()).toEqual([]);
  });

  it("shows the needs-you line as banners, a list inside the status region", async () => {
    await show();
    const banners = screen.getByRole("status", { name: "needs you" });
    expect(within(banners).getByRole("list")).toBeTruthy();
    expect(within(banners).getByText("1218_7150P entry signal")).toBeTruthy();
  });

  it("brings the row a banner is about into view when it is tapped", async () => {
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    window.scrollTo(0, 0);
    const row = document.querySelector<HTMLElement>('[data-ref="late"]')!;
    // the precondition the test is worth nothing without: the row starts well out of view
    expect(row.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    const banners = screen.getByRole("status", { name: "needs you" });
    fireEvent.click(within(banners).getByRole("button", { name: /0917_5800P entry signal/ }));
    await new Promise((r) => setTimeout(r, 900));
    // marked for a moment only, so read while the scroll is still under way
    expect(row.hasAttribute("data-revealed")).toBe(true);
    // the smooth scroll takes as long as the page is long, which the cards' strike strips (#297)
    // lengthened: wait for it to come to rest rather than for a fixed time
    await scrolled();
    const r = row.getBoundingClientRect();
    expect(r.top >= 0 && r.bottom <= window.innerHeight).toBe(true);
  });
});

/** A holding's sheet with its history (#374): open from the start outside the session — the
 *  burndown, the IV and SPX against the strikes — and shut in it. */
describe("a holding's sheet on the Book tab", () => {
  async function sheet(): Promise<HTMLElement> {
    serveBook();
    // the days with SPX on them, so where it was against the strikes is a chart to measure
    const served = window.fetch;
    window.fetch = (async (url: string, init?: RequestInit) => {
      const answer = await served(url, init);
      if (!/\/samples$/.test(String(url))) return answer;
      const days = await answer.json() as { samples: object[] };
      const spx = { ...days, samples: days.samples.map((d, i) => ({ ...d, spx: 7020 - 15 * i })) };
      return { ok: true, status: 200, json: () => Promise.resolve(spx) };
    }) as typeof fetch;
    render(<Next />);
    await settle();
    const card = document.querySelector<HTMLElement>("article.nxp-holding")!;
    fireEvent.click(within(card).getByRole("button", { name: /^details of / }));
    const dialog = await screen.findByRole("dialog");
    await animationsDone();
    await settle();
    return dialog;
  }
  const toggle = (d: HTMLElement) => within(d).getByRole("button", { name: "history" });

  it("opens with its history open outside the session, every chart inside the screen", async () => {
    vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // a Sunday: outside the session
    const d = await sheet();
    expect(toggle(d).getAttribute("aria-expanded")).toBe("true");
    const charts = [...d.querySelectorAll<SVGSVGElement>(".nx-hist svg")];
    // the burndown, the IV by leg, and SPX against the strikes
    expect(["burndown", "IV by leg", "SPX against the strikes"]
      .map((name) => within(d).queryByRole("group", { name }) !== null)).toEqual([true, true, true]);
    expect(charts).toHaveLength(3);
    const edge = document.documentElement.clientWidth;
    for (const svg of charts) {
      const r = svg.getBoundingClientRect();
      expect(r.left, "inside the screen's left").toBeGreaterThanOrEqual(0);
      expect(r.right, "inside the screen's right").toBeLessThanOrEqual(edge + 0.5);
      // across the sheet, not a thumbnail of it
      expect(r.width).toBeGreaterThan(300);
    }
    expect(d.scrollWidth).toBeLessThanOrEqual(d.clientWidth);
    expect(overflowsSideways()).toBe(false);
    expect(tooSmall()).toEqual([]);
    expect(zooms()).toEqual([]);
  });

  it("opens with its history shut in session, and draws none of it", async () => {
    const d = await sheet();
    expect(toggle(d).getAttribute("aria-expanded")).toBe("false");
    expect(d.querySelector(".nx-hist svg")).toBeNull();
    expect(overflowsSideways()).toBe(false);
    expect(tooSmall()).toEqual([]);
  });
});

describe("the Settings tab", () => {
  async function settings() {
    await show();
    fireEvent.click(within(screen.getByRole("navigation", { name: "views" }))
      .getByRole("button", { name: "Settings" }));
    await settle();
  }

  it("pushes nothing sideways", async () => {
    await settings();
    expect(overflowsSideways()).toBe(false);
  });

  it("gives every control a 44pt target, the References form's included", async () => {
    await settings();
    expect(document.querySelectorAll(".nx select").length).toBeGreaterThanOrEqual(5);
    expect(tooSmall()).toEqual([]);
  });

  it("gives the remove confirmation's buttons 44pt targets, though it is drawn outside the page", async () => {
    await settings();
    fireEvent.click(screen.getByRole("button", { name: /remove/ }));
    const dialog = await screen.findByRole("alertdialog");
    await animationsDone();
    expect(within(dialog).getAllByRole("button").length).toBeGreaterThanOrEqual(2);
    expect(tooSmall()).toEqual([]);
  });

  it("gives a refusal's toast a 44pt close button", async () => {
    await settings();
    fireEvent.change(screen.getByLabelText("code"), { target: { value: "US.SPY" } });
    fireEvent.click(screen.getByRole("button", { name: "keep it" }));
    await screen.findByText("refused by the test service");
    await animationsDone();
    expect(tooSmall()).toEqual([]);
  });

  it("sets every box in 16px text, so iOS does not zoom on focus", async () => {
    await settings();
    expect(zooms()).toEqual([]);
  });
});
