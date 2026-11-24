/** The account page at the desk (#471), measured in a real layout engine: at the narrowest desk and
 *  a wide one, in every state it draws, nothing pushed sideways and every row's figures whole. The
 *  phone is `Account.iphone.test.tsx`. */
import { cleanup, screen } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { overflowsSideways } from "./nextBook";
import { cutShort, foldAll, openCombos, showAccount, STATES, VARIANTS } from "../testing/accountPage";

afterEach(async () => {
  cleanup();
  document.cookie = "ui_privacy=;path=/;max-age=0";
  document.cookie = "ui_account_folded=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

describe("the account page on the desk", () => {
  for (const width of [900, 1280]) for (const [name, answer] of Object.entries(STATES)) {
    it(`at ${width}px, ${name}: nothing sideways, every row whole`, async () => {
      await page.viewport(width, 900);
      await showAccount(answer);
      expect(document.querySelector<HTMLElement>(".nx-acct")!.dataset.arrangement).toBe("desk");
      expect(overflowsSideways()).toBe(false);
      expect(cutShort()).toEqual([]);
      for (const table of document.querySelectorAll<HTMLElement>(".nx-acct-table")) {
        expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(document.documentElement.clientWidth);
      }
    });
  }

  for (const width of [900, 1280]) for (const [name, show] of Object.entries(VARIANTS)) {
    it(`at ${width}px, ${name}: nothing sideways, every row whole`, async () => {
      await page.viewport(width, 900);
      await show();
      expect(overflowsSideways()).toBe(false);
      expect(cutShort()).toEqual([]);
      expect(document.querySelectorAll("[data-holding]").length).toBeGreaterThan(0);
    });
  }

  it("draws a table per kind, a row per holding, its figures right-aligned in their columns", async () => {
    await page.viewport(1280, 900);
    await showAccount(STATES["two currencies"]);
    const stocks = screen.getByRole("region", { name: "Stocks" });
    const table = stocks.querySelector("table")!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent))
      .toEqual(["symbol", "qty", "avg cost", "mark", "value", "P&L", "P&L %", "weight"]);
    // a column's figures end at one edge, row under row
    const rights = [...table.querySelectorAll<HTMLElement>("tbody td:nth-child(5)")].map((td) => {
      const r = td.getBoundingClientRect();
      return Math.round(r.right - parseFloat(getComputedStyle(td).paddingRight));
    });
    const ends = [...table.querySelectorAll<HTMLElement>("tbody td:nth-child(5)")].map((td) =>
      Math.round([...td.children].at(-1)!.getBoundingClientRect().right));
    expect(ends).toEqual(rights);
  });

  it("folds a section at a click and opens it at Enter and Space, what is under it moving up and back", async () => {
    await page.viewport(1280, 900);
    await showAccount(STATES.loaded);
    const fold = screen.getByRole("region", { name: "Stocks" }).querySelector<HTMLButtonElement>(".nx-acct-fold")!;
    const below = () => screen.getByRole("region", { name: "Options" }).getBoundingClientRect().top;
    const open = below();
    await userEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(below()).toBeLessThan(open - 60);
    expect(document.querySelector('[data-holding="AAPL"]')!.getBoundingClientRect().height, "a folded row is not drawn").toBe(0);
    fold.focus();
    await userEvent.keyboard("{Enter}");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(below()).toBe(open);
    await userEvent.keyboard(" ");
    expect(fold.getAttribute("aria-expanded"), "Space presses it too").toBe("false");
  });

  it("folds an underlying, the next one moving up", async () => {
    await page.viewport(1280, 900);
    await showAccount(STATES.combos);
    const fold = document.querySelector<HTMLButtonElement>('[data-underlying="QQQ"] .nx-acct-fold')!;
    const below = () => document.querySelector<HTMLElement>('[data-underlying="SPX"]')!.getBoundingClientRect().top;
    const open = below();
    await userEvent.click(fold);
    expect(below()).toBeLessThan(open - 40);
  });

  it("opens a combined row at a click on it and at Enter on its button, its legs drawn under it in its columns", async () => {
    await page.viewport(1280, 900);
    await showAccount(STATES.combos);
    const row = document.querySelector<HTMLElement>('[data-expiry="20270219"] [data-combo]')!;
    const button = row.querySelector<HTMLButtonElement>(".nx-acct-combo-toggle")!;
    const legs = () => [...row.parentElement!.querySelectorAll<HTMLElement>("[data-leg]")];
    expect(legs().every((l) => l.getBoundingClientRect().height === 0)).toBe(true);
    const next = () => document.querySelector<HTMLElement>('[data-expiry="20270319"] [data-combo]')!.getBoundingClientRect().top;
    const closed = next();
    await userEvent.click(row.querySelector<HTMLElement>('[data-fig="mark"]')!);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(legs()).toHaveLength(4);
    let top = row.getBoundingClientRect().bottom - 0.5;
    for (const leg of legs()) {
      const r = leg.getBoundingClientRect();
      expect(r.height).toBeGreaterThan(0);
      expect(r.top).toBeGreaterThanOrEqual(top);
      top = r.bottom - 0.5;
      // each leg's value in the row's value column
      const cell = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-fig="value"]')!.closest("td")!.getBoundingClientRect();
      expect(Math.round(cell(leg).left)).toBe(Math.round(cell(row).left));
    }
    expect(next()).toBeGreaterThan(closed + 60);
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(next()).toBe(closed);
  });

  for (const width of [900, 1280]) {
    it(`draws every folded heading and every opened combined row inside the screen at ${width}px`, async () => {
      await page.viewport(width, 900);
      await showAccount(STATES["large combos"]);
      await openCombos();
      expect(overflowsSideways()).toBe(false);
      expect(cutShort()).toEqual([]);
      for (const b of document.querySelectorAll<HTMLElement>(".nx-acct-combo-toggle")) {
        expect(b.getBoundingClientRect().right, b.textContent!).toBeLessThanOrEqual(b.closest("th")!.getBoundingClientRect().right + 0.5);
      }
      await foldAll();
      for (const b of document.querySelectorAll<HTMLElement>(".nx-acct-fold")) {
        expect(b.getAttribute("aria-expanded")).toBe("false");
        expect(b.getBoundingClientRect().right, b.textContent!).toBeLessThanOrEqual(document.documentElement.clientWidth);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }
});
