/** The page on a phone, under Playwright's iPhone profile (ADR 0023): touch, a coarse
 *  pointer and a 390px screen. Runs in the suite's `iphone` instance only.
 *
 *  What a phone needs that a desk does not: nothing pushed sideways, a 44pt target for every
 *  control, and 16px text in every box, below which iOS zooms the page when a box is focused.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { declared, headerBottom, longBook, overflowsSideways, serveBook, settle } from "./nextBook";
import { hitBox } from "./targets";

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
  // until the page is still: no animation running and no dialog still in its starting style. One
  // snapshot of the animations missed a transition that had not begun yet, and a sheet measured
  // mid-rise read 669.5 for a bottom edge of 664 (review of #415)
  for (let i = 0; i < 60; i++) {
    const running = document.getAnimations();
    const starting = document.querySelector("[data-starting-style], [data-ending-style]");
    if (running.length === 0 && starting === null) {
      await new Promise((r) => setTimeout(r, 50));
      if (document.getAnimations().length === 0) return;
      continue;
    }
    await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => setTimeout(r, 25));
  }
}

function tooSmall(): string[] {
  return targets().flatMap((el) => {
    const r = hitBox(el);
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

  it("chooses the cards, with no bar of tabs under them (#410)", async () => {
    await show();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(document.querySelector(".nx-tabs")).toBeNull();
    // and nothing fixed to the bottom of the screen in its place
    const fixed = [...document.querySelectorAll<HTMLElement>(".nx *")]
      .filter((el) => getComputedStyle(el).position === "fixed");
    expect(fixed.map((el) => el.className)).toEqual([]);
  });

  it("leaves the end of the page the home indicator's room and no bar's", async () => {
    await show();
    const main = document.querySelector<HTMLElement>(".nx-main")!;
    // 1.5rem, as the desk ends; the 5rem a bar needed is gone
    expect(parseFloat(getComputedStyle(main).paddingBottom)).toBeLessThan(40);
    expect(declared(".nx-main", "padding-bottom").some((v) => v.includes("safe-area-inset-bottom"))).toBe(true);
  });
});

/** The phone's header (#374; #410): "optionality" and its buttons — the picture, the text, the
 *  refresh, and since #410 Add and Settings, which were tabs of a bar along the bottom — one row,
 *  inside the gutter, held at the top of the screen while the page scrolls. It never had the
 *  desk's switch; this holds it as it is. */
describe("the header", () => {
  for (const outside of [false, true]) {
    it(`is the title and five buttons on one row, inside the screen, ${outside ? "outside the session" : "in session"}`, async () => {
      if (outside) vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // Sunday 12:00 ET
      await show();
      const head = document.querySelector<HTMLElement>(".nx-head")!;
      const kids = [...head.children] as HTMLElement[];
      const [title, spacer, ...buttons] = kids;
      expect(title!.tagName).toBe("H1");
      expect(spacer!.classList.contains("nx-spacer")).toBe(true);
      expect(buttons.map((b) => b.getAttribute("aria-label")))
        .toEqual(["save as image", "copy as text", "refresh now", "add", "settings"]);
      expect(within(head).queryByRole("group")).toBeNull();
      expect(head.textContent).not.toMatch(/live|review|by the clock|your choice/i);
      const box = (el: Element) => el.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(head).columnGap);
      expect(box(spacer!).left - box(title!).right).toBeCloseTo(gap, 0);
      expect(new Set(kids.map((k) => Math.round(box(k).top + box(k).height / 2))).size, "not one row").toBe(1);
      const inner = box(head).right - parseFloat(getComputedStyle(head).paddingRight);
      expect(box(buttons.at(-1)!).right).toBeCloseTo(inner, 0);
      expect(inner).toBeLessThanOrEqual(document.documentElement.clientWidth - 16 + 0.5);
      for (const b of buttons) expect(Math.min(hitBox(b).width, hitBox(b).height)).toBeGreaterThanOrEqual(44);
      expect(overflowsSideways()).toBe(false);
      expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth);
    });
  }

  it("stays at the top of the screen while the page scrolls under it", async () => {
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    const head = document.querySelector<HTMLElement>(".nx-head")!;
    expect(getComputedStyle(head).position).toBe("sticky");
    window.scrollTo(0, 900);
    await settle();
    // the precondition: the page did scroll, past the header's own height many times
    expect(window.scrollY).toBeGreaterThan(800);
    expect(head.getBoundingClientRect().top).toBeCloseTo(0, 0);
    // opaque, and over the cards: what scrolls under it is hidden by it, never drawn through it
    expect(getComputedStyle(head).backgroundColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const { left, bottom } = head.getBoundingClientRect();
    const under = document.elementFromPoint(left + 4, bottom - 2)!;
    expect(head.contains(under), `drawn over the header: ${under.outerHTML.slice(0, 80)}`).toBe(true);
    // and still its buttons, each a finger's target
    expect(screen.getByRole("button", { name: "settings" }).getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  });

  it("keeps clear of the notch and the status bar: the safe area's top, and its sides", () => {
    // env() computes to 0px off a notched screen, so the rule is read instead of the box
    expect(declared(".nx-head", "padding-top").some((v) => v.includes("safe-area-inset-top")),
      `.nx-head padding-top: ${declared(".nx-head", "padding-top").join(" | ")}`).toBe(true);
    expect(declared(".nx-head", "padding-left").some((v) => v.includes("safe-area-inset-left"))).toBe(true);
    expect(declared(".nx-head", "padding-right").some((v) => v.includes("safe-area-inset-right"))).toBe(true);
  });
});

describe("the book", () => {
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
    // on the screen, and below the sticky header rather than under it (#410)
    expect(r.top, `the row's top ${r.top}, the header's bottom ${headerBottom()}`).toBeGreaterThanOrEqual(headerBottom());
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("lands a row clear of the header when it is brought into view from below, at its start (#410)", async () => {
    // a row near the page's top, reached from far down, as a sheet's closing or a centred scroll near
    // the page's top brings one: without the document's scroll-padding it lands under the header
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    const first = document.querySelector<HTMLElement>("article[data-ref]")!;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await settle();
    expect(first.getBoundingClientRect().bottom).toBeLessThan(0);
    first.scrollIntoView({ block: "start" });
    await settle();
    expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(headerBottom());
  });

  it("brings a card back clear of the header after its sheet closes on Back (#410)", async () => {
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    const card = [...document.querySelectorAll<HTMLElement>("article[data-ref]")][6]!;
    // the card half under the header, where a thumb can still reach its lower half
    window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - headerBottom() + 30);
    await settle();
    expect(card.getBoundingClientRect().top).toBeLessThan(headerBottom());
    const opener = within(card).getByRole("button", { name: /^details of / });
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    await animationsDone();
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await animationsDone();
    await scrolled();
    expect(card.getBoundingClientRect().top, "under the header after Back").toBeGreaterThanOrEqual(headerBottom());
  });
});

/** A holding's sheet with its history (#374): open from the start outside the session — the
 *  burndown and the IV — and shut in it. */
describe("a holding's sheet on the book", () => {
  async function sheet(): Promise<HTMLElement> {
    serveBook();
    render(<Next />);
    await settle();
    const card = document.querySelector<HTMLElement>("article.nxp-holding")!;
    fireEvent.click(within(card).getByRole("button", { name: /^details of / }));
    const dialog = await screen.findByRole("dialog");
    await animationsDone();
    await settle();
    return dialog;
  }
  const toggle = (d: HTMLElement) => within(d).getByRole("button", { name: "History" });

  it("opens with its history open outside the session, every chart inside the screen", async () => {
    vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // a Sunday: outside the session
    const d = await sheet();
    expect(toggle(d).getAttribute("aria-expanded")).toBe("true");
    const charts = [...d.querySelectorAll<SVGSVGElement>(".nx-hist svg")];
    // the burndown and the IV by leg, and no SPX against the strikes (dropped 2026-11-17)
    expect(["burndown", "IV by leg", "SPX against the strikes"]
      .map((name) => within(d).queryByRole("group", { name }) !== null)).toEqual([true, true, false]);
    expect(charts).toHaveLength(2);
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

/** Settings on the phone (#410): a bottom sheet over the book, as the Add sheet is — the same
 *  component — where it was a screen in the book's place. */
describe("the Settings sheet", () => {
  async function settings() {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    await animationsDone();
    await settle();
    return sheet;
  }

  it("rises from the bottom over the book, which stays where it was under it", async () => {
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    window.scrollTo(0, 600);
    await settle();
    const at = window.scrollY;
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    await animationsDone();
    await settle();
    expect(sheet.dataset.side).toBe("bottom");
    expect(sheet.classList.contains("nxp-sheet"), "the Add sheet's own look").toBe(true);
    const r = sheet.getBoundingClientRect();
    expect(r.bottom).toBeCloseTo(window.innerHeight, 0);
    expect(r.left).toBeCloseTo(0, 0);
    expect(r.width).toBeCloseTo(document.documentElement.clientWidth, 0);
    // never the whole screen: the book shows above it
    expect(r.top).toBeGreaterThan(window.innerHeight * 0.1);
    expect(sheet.scrollHeight > sheet.clientHeight || r.height < window.innerHeight * 0.86).toBe(true);
    expect(document.querySelector('[data-ref="late"]'), "the book is still drawn under it").toBeTruthy();
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await animationsDone();
    expect(window.scrollY).toBe(at);
  });

  it("closes by its Close button, as the Add sheet does", async () => {
    const sheet = await settings();
    fireEvent.click(within(sheet).getByRole("button", { name: "close sheet" }));
    // gone once its exit has played out, which a loaded suite can stretch past waitFor's 1s
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(), { timeout: 3000 });
  });

  it("pushes nothing sideways", async () => {
    const sheet = await settings();
    expect(overflowsSideways()).toBe(false);
    expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
  });

  it("gives every control a 44pt target, the References form's included", async () => {
    const sheet = await settings();
    expect(sheet.querySelectorAll("select").length).toBeGreaterThanOrEqual(5);
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
    fireEvent.click(screen.getByRole("button", { name: "add reference" }));
    await screen.findByText("refused by the test service");
    await animationsDone();
    expect(tooSmall()).toEqual([]);
  });

  it("sets every box in 16px text, so iOS does not zoom on focus", async () => {
    await settings();
    expect(zooms()).toEqual([]);
  });
});
