/** The account page on a phone (#471), under Playwright's iPhone profile: a card per holding, in
 *  every state it draws — nothing pushed sideways, every figure whole inside its card, a 44pt target
 *  for every control and 16px text in the cadence's box. Runs in the suite's `iphone` instance. */
import { cleanup, screen, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { overflowsSideways } from "./nextBook";
import { hitBox } from "./targets";
import { chevron, cutShort, totalsCut, foldAll, openCombos, showAccount, STATES, VARIANTS } from "../testing/accountPage";

afterEach(() => {
  cleanup();
  document.cookie = "ui_privacy=;path=/;max-age=0";
  document.cookie = "ui_account_folded=;path=/;max-age=0";
});

describe("the account page on an iPhone", () => {
  it("is a phone to the page: a coarse pointer, 390px wide", () => {
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    expect(document.documentElement.clientWidth).toBe(390);
  });

  for (const [name, answer] of Object.entries(STATES)) {
    it(`${name}: cards, nothing sideways, every figure whole`, async () => {
      await showAccount(answer);
      expect(document.querySelector<HTMLElement>(".nx-acct")!.dataset.arrangement).toBe("phone");
      expect(overflowsSideways()).toBe(false);
      expect(document.querySelector(".nx-acct table")).toBeNull();
      expect(cutShort()).toEqual([]);
      expect(totalsCut()).toEqual([]);
      for (const card of document.querySelectorAll<HTMLElement>(".nx-acct-card")) {
        expect(card.scrollWidth, card.dataset.holding).toBeLessThanOrEqual(card.clientWidth);
      }
    });
  }

  for (const [name, show] of Object.entries(VARIANTS)) {
    it(`${name}: cards, nothing sideways, every figure whole`, async () => {
      await show();
      expect(overflowsSideways()).toBe(false);
      expect(cutShort()).toEqual([]);
      expect(document.querySelectorAll(".nx-acct-card").length).toBeGreaterThan(0);
    });
  }

  it("keeps its own title on the phone, beside the way back and the refresh, at 320px too", async () => {
    await page.viewport(320, 664);
    try {
      await showAccount(STATES.loaded);
      const title = screen.getByRole("heading", { level: 1, name: "Account" });
      expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
      expect(title.getBoundingClientRect().width).toBeGreaterThan(40);
      expect(overflowsSideways()).toBe(false);
    } finally {
      await page.viewport(390, 664);
    }
  });

  it("gives the way back, the refresh and the cadence each a 44pt target, the cadence 16px text", async () => {
    await showAccount(STATES.loaded);
    const head = document.querySelector<HTMLElement>(".nx-head")!;
    const controls = [
      within(head).getByRole("link", { name: "back to the book" }),
      within(head).getByRole("button", { name: "refresh now" }),
      screen.getByLabelText("refresh every"),
    ];
    for (const c of controls) {
      const r = hitBox(c);
      expect(Math.min(r.width, r.height), c.getAttribute("aria-label") ?? c.id).toBeGreaterThanOrEqual(44);
    }
    expect(parseFloat(getComputedStyle(screen.getByLabelText("refresh every")).fontSize)).toBeGreaterThanOrEqual(16);
    // the header one row, inside the screen
    const kids = [...head.children] as HTMLElement[];
    expect(new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2))).size).toBe(1);
    expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth);
  });

  it("lays the totals two by two, and a card's figures two by two under its name and quantity", async () => {
    await showAccount(STATES.loaded);
    const totals = [...document.querySelectorAll<HTMLElement>(".nx-acct-total-figs > div")];
    // five since #478, daily P&L the last, alone on its row
    expect(totals).toHaveLength(5);
    expect(new Set(totals.map((t) => Math.round(t.getBoundingClientRect().top))).size).toBe(3);
    const card = document.querySelector<HTMLElement>('.nx-acct-card[data-holding="AAPL"]')!;
    const head = card.querySelector<HTMLElement>(".nx-acct-card-head")!.getBoundingClientRect();
    const figs = [...card.querySelectorAll<HTMLElement>(".nx-acct-figs > div")].map((d) => d.getBoundingClientRect());
    expect(figs.length).toBe(7);
    for (const f of figs) expect(f.top).toBeGreaterThanOrEqual(head.bottom - 0.5);
    expect(new Set(figs.map((f) => Math.round(f.top))).size).toBe(4);
  });

  it("draws Options, then Stocks folded, then Other, one under the next", async () => {
    await showAccount(STATES.loaded, { asItStarts: true });
    const boxes = ["Options", "Stocks", "Other"].map((name) => screen.getByRole("region", { name }).getBoundingClientRect());
    expect(boxes[0]!.bottom).toBeLessThanOrEqual(boxes[1]!.top + 0.5);
    expect(boxes[1]!.bottom).toBeLessThanOrEqual(boxes[2]!.top + 0.5);
    const stocks = screen.getByRole("region", { name: "Stocks" });
    expect(stocks.querySelector(".nx-acct-fold")!.getAttribute("aria-expanded")).toBe("false");
    expect(stocks.querySelector<HTMLElement>('[data-holding="AAPL"]')!.getBoundingClientRect().height, "a folded row is not drawn").toBe(0);
  });

  it("folds a section at a tap, what is under it moving up, and opens it again", async () => {
    await showAccount(STATES.loaded);
    const fold = screen.getByRole("region", { name: "Stocks" }).querySelector<HTMLButtonElement>(".nx-acct-fold")!;
    // Other's distance from Stocks' heading, which a scroll to reach the heading moves with it
    const below = () => screen.getByRole("region", { name: "Other" }).getBoundingClientRect().top - fold.getBoundingClientRect().top;
    const open = below();
    await userEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(below()).toBeLessThan(open - 100);
    await userEvent.click(fold);
    expect(below()).toBe(open);
  });

  it("opens a combined card at a tap on it, its legs inside it, and closes it again", async () => {
    await showAccount(STATES.combos);
    const card = document.querySelector<HTMLElement>('[data-expiry="20270219"] [data-combo]')!;
    const closed = card.getBoundingClientRect().height;
    await userEvent.click(card.querySelector<HTMLElement>('[data-fig="value"]')!);
    const legs = [...card.querySelectorAll<HTMLElement>("[data-leg]")];
    expect(legs).toHaveLength(4);
    const box = card.getBoundingClientRect();
    expect(box.height).toBeGreaterThan(closed + 200);
    for (const leg of legs) {
      const r = leg.getBoundingClientRect();
      expect(r.left).toBeGreaterThanOrEqual(box.left);
      expect(r.right).toBeLessThanOrEqual(box.right);
    }
    await userEvent.click(card.querySelector<HTMLElement>(".nx-acct-combo-toggle")!);
    expect(card.getBoundingClientRect().height).toBe(closed);
  });

  it("draws every folded heading and every opened combined card inside 390px, nothing sideways", async () => {
    await showAccount(STATES["large combos"]);
    await openCombos();
    expect(overflowsSideways()).toBe(false);
    expect(cutShort()).toEqual([]);
    for (const card of document.querySelectorAll<HTMLElement>(".nx-acct-card")) {
      expect(card.scrollWidth, card.dataset.holding).toBeLessThanOrEqual(card.clientWidth);
    }
    await foldAll();
    for (const b of document.querySelectorAll<HTMLElement>(".nx-acct-fold")) {
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(b.getBoundingClientRect().right, b.textContent!).toBeLessThanOrEqual(390);
      expect(b.scrollWidth).toBeLessThanOrEqual(b.clientWidth);
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("gives every fold and every combined card's button a 44pt target", async () => {
    await showAccount(STATES.combos);
    const buttons = [...document.querySelectorAll<HTMLElement>(".nx-acct-fold, .nx-acct-combo-toggle")];
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) {
      const r = hitBox(b);
      expect(Math.min(r.width, r.height), b.textContent!).toBeGreaterThanOrEqual(44);
    }
    // and with every underlying folded, one heading straight under the next
    for (const b of document.querySelectorAll<HTMLElement>("[data-underlying] .nx-acct-fold")) await userEvent.click(b);
    for (const b of document.querySelectorAll<HTMLElement>(".nx-acct-fold")) {
      const r = hitBox(b);
      expect(Math.min(r.width, r.height), `${b.textContent!}, folded`).toBeGreaterThanOrEqual(44);
    }
  });

  // the owner, 2026-11-24 (#478): an opened combined row's arrow was drawn as a corner (⌟), caught
  // half-turned; it points down from the moment the row opens, as an opened heading's does
  it("points an opened combined row's arrow down at once, as an opened heading's, and a closed one's right", async () => {
    expect(document.documentElement.clientWidth).toBe(390);
    await showAccount(STATES.combos);
    const row = document.querySelector<HTMLElement>('[data-expiry="20270219"] [data-combo]')!;
    const button = row.querySelector<HTMLButtonElement>(".nx-acct-combo-toggle")!;
    expect(chevron(button).points, "closed").toBe("right");
    const heading = document.querySelector<HTMLElement>('[data-section="options"] .nx-acct-fold')!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(chevron(heading).points, "an opened heading").toBe("down");
    await userEvent.click(row.querySelector<HTMLElement>('[data-fig="value"]')!);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // as soon as it is open, as its legs are, and still a while after
    for (const when of ["at once", "a moment later"]) {
      const c = chevron(button);
      expect(c.points, `${when}: ${c.box}, ${c.transform}`).toBe("down");
      const m = new DOMMatrix(c.transform);
      expect([Math.round(m.a), Math.round(m.b)], when).toEqual([0, 1]);
      await new Promise((r) => setTimeout(r, 300));
    }
    await userEvent.click(button);
    expect(chevron(button).points, "closed again").toBe("right");
  });
});
