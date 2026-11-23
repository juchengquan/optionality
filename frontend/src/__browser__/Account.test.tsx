/** The account page at the desk (#471), measured in a real layout engine: at the narrowest desk and
 *  a wide one, in every state it draws, nothing pushed sideways and every row's figures whole. The
 *  phone is `Account.iphone.test.tsx`. */
import { cleanup, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { overflowsSideways } from "./nextBook";
import { cutShort, showAccount, STATES, VARIANTS } from "../testing/accountPage";

afterEach(async () => {
  cleanup();
  document.cookie = "ui_privacy=;path=/;max-age=0";
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
});
