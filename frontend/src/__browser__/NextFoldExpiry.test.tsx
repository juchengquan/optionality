/** The book's expiry groups folded on the desk (the owner, 2026-11-21), in a real layout engine: a
 *  click on a heading folds its rows out of the table and a key press on it opens them again, and a
 *  folded heading — its row count and its chips — is drawn inside the table, uncovered, at every
 *  width the desk is measured at. The behaviour is `__tests__/NextFoldExpiry.test.tsx`'s. */
import { cleanup, render } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { placed, serveOneBook } from "../testing/oneBookServe";

afterEach(async () => {
  cleanup();
  document.cookie = "ui_folded=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

const table = () => document.querySelector<HTMLElement>(".nxd-table")!;
const heads = () => [...document.querySelectorAll<HTMLButtonElement>("[data-section] [data-expiry] h3 button")];
const head = (section: string, expiry: string) =>
  document.querySelector<HTMLButtonElement>(`[data-section="${section}"] [data-expiry="${expiry}"] h3 button`)!;
const rowsOf = (b: HTMLElement) => [...document.getElementById(b.getAttribute("aria-controls")!)!.querySelectorAll<HTMLElement>(".nxd-row")];

describe("on the desk", () => {
  it("folds a group at a click and opens it at Enter, the rows below moving up and back", async () => {
    await page.viewport(1280, 900);
    serveOneBook();
    render(<Next />);
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
    const b = head("spreads", "2026-12-18");
    const below = () => head("spreads", "2026-12-31").getBoundingClientRect().top;
    const open = below();
    expect(rowsOf(b).every((r) => r.getBoundingClientRect().height > 0)).toBe(true);
    await userEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(rowsOf(b).every((r) => r.getBoundingClientRect().height === 0), "a folded row is not drawn").toBe(true);
    expect(below()).toBeLessThan(open);
    b.focus();
    await userEvent.keyboard("{Enter}");
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(below()).toBe(open);
    await userEvent.keyboard(" ");
    expect(b.getAttribute("aria-expanded"), "Space presses it too").toBe("false");
  });

  for (const width of [900, 1280]) {
    it(`draws every folded heading inside the table at ${width}px, its chips uncovered`, async () => {
      await page.viewport(width, 900);
      serveOneBook();
      render(<Next />);
      await settle();
      for (const b of heads()) await userEvent.click(b);
      expect(heads().every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
      // the one book's 12-18 spreads hold a holding at its stop and its own rule ringing
      expect(head("spreads", "2026-12-18").querySelectorAll(".nx-chip").length).toBeGreaterThan(1);
      expect(overflowsSideways()).toBe(false);
      for (const b of heads()) {
        expect(placed(b, table()), b.textContent!).toBeNull();
        for (const chip of b.querySelectorAll(".nx-chip")) expect(placed(chip, table()), chip.textContent!).toBeNull();
      }
    });
  }
});
