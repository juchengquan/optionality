/** What a leg IS, in colour (#391), on the phone under Playwright's iPhone profile: the add sheet
 *  draws the one form the desk does — its types in their hue, its sides by weight and sign, its
 *  modes neutral — and nothing in it is pushed past the screen's edge by a sign; the cards write
 *  each type letter in its colour and a short leg bold. The desk's half is `NextLegColours.test.tsx`. */
import { cleanup, render, screen, within } from "@testing-library/react";
import { commands, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { expectFormColours, resolved } from "./legColours";
import { serveAdding, serveBook, settle } from "./nextBook";

afterEach(async () => {
  cleanup();
  await commands.colorScheme("light");
});

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

for (const scheme of ["light", "dark"] as const) {
  describe(`the leg colours on the phone, in the ${scheme} scheme`, () => {
    it("tint the add sheet's types, choose one solid, draw its sides by weight and sign, and leave the modes neutral", async () => {
      await commands.colorScheme(scheme);
      serveAdding({ status: 201, body: {} });
      render(<Next />);
      await settle();
      await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Add" }));
      const sheet = await screen.findByRole("dialog", { name: "Add a spread or contract" });
      await animationsDone();
      const edge = document.documentElement.clientWidth;
      const past = () => [...sheet.querySelectorAll<HTMLElement>("button")]
        .filter((b) => b.getBoundingClientRect().right > edge + 0.5).map((b) => b.textContent);
      expect(past()).toEqual([]);
      await expectFormColours(sheet);
      expect(past()).toEqual([]);
    });

    it("colour each type letter on the cards and bold a short leg", async () => {
      await commands.colorScheme(scheme);
      serveBook();
      render(<Next />);
      await settle();
      const root = document.querySelector(".nx")!;
      expect(root.getAttribute("data-arrangement")).toBe("phone");
      const [call, put] = ["var(--call)", "var(--put)"].map((c) => resolved(root, c));
      const legs = root.querySelectorAll<HTMLElement>(".nxp-legs .nx-leg");
      expect(legs.length).toBeGreaterThan(0);
      for (const leg of legs) {
        const t = leg.querySelector<HTMLElement>(".nx-leg-t")!;
        expect(getComputedStyle(t).color, leg.textContent!).toBe(t.dataset.type === "CALL" ? call : put);
        const weight = Number(getComputedStyle(leg).fontWeight);
        if (leg.dataset.side === "short") expect(weight, leg.textContent!).toBeGreaterThanOrEqual(700);
        else expect(weight, leg.textContent!).toBeLessThan(600);
      }
    });
  });
}
