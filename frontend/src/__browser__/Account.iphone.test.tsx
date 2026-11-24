/** The account page on a phone (#471), under Playwright's iPhone profile: a card per holding, in
 *  every state it draws — nothing pushed sideways, every figure whole inside its card, a 44pt target
 *  for every control and 16px text in the cadence's box. Runs in the suite's `iphone` instance. */
import { cleanup, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { overflowsSideways } from "./nextBook";
import { hitBox } from "./targets";
import { cutShort, showAccount, STATES, VARIANTS } from "../testing/accountPage";

afterEach(() => { cleanup(); document.cookie = "ui_privacy=;path=/;max-age=0"; });

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
    expect(new Set(totals.map((t) => Math.round(t.getBoundingClientRect().top))).size).toBe(2);
    const card = document.querySelector<HTMLElement>('.nx-acct-card[data-holding="AAPL"]')!;
    const head = card.querySelector<HTMLElement>(".nx-acct-card-head")!.getBoundingClientRect();
    const figs = [...card.querySelectorAll<HTMLElement>(".nx-acct-figs > div")].map((d) => d.getBoundingClientRect());
    expect(figs.length).toBe(6);
    for (const f of figs) expect(f.top).toBeGreaterThanOrEqual(head.bottom - 0.5);
    expect(new Set(figs.map((f) => Math.round(f.top))).size).toBe(3);
  });
});
