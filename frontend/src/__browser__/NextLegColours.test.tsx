/** What a leg IS, in colour (#391, ADR 0023's fourth family), measured at the desk in a real
 *  browser: CALL teal and PUT orange, readable on both grounds as the attention colours are held;
 *  the add form's type buttons in their hue and its side buttons by weight and sign, the mode pairs
 *  neutral; and the book's legs with each type letter in its colour and a short leg bold. That
 *  every place draws its legs through `shared/Legs.tsx` is the jsdom suite's (`legMarks`); the
 *  phone's half of this is `NextLegColours.iphone.test.tsx`. */
import { cleanup, render, screen, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { Legs, SvgLeg } from "../shared/Legs";
import { expectFormColours, resolved } from "./legColours";
import { contrast, contrastOnTint, oklab, serveAdding, serveBook, settle, token } from "./nextBook";

const root = () => document.querySelector<HTMLElement>(".nx")!;

afterEach(async () => {
  cleanup();
  await commands.colorScheme("light");
  await page.viewport(1280, 900);
});

for (const scheme of ["light", "dark"] as const) {
  describe(`the leg colours, in the ${scheme} scheme`, () => {
    it("are readable as text on the page, as a tint's text, and under the page's ground as ink", async () => {
      await commands.colorScheme(scheme);
      serveBook();
      render(<Next />);
      await settle();
      const page = token(root(), "--background");
      const weak: string[] = [];
      for (const name of ["--call", "--put"]) {
        const c = token(root(), name);
        // a letter in the book, and a chosen type's ink on its solid fill: small text, 4.5:1
        const text = contrast(c, page);
        if (text < 4.5) weak.push(`${name} on the page: ${text.toFixed(2)}:1`);
        // an unchosen type's words on its 12% tint
        const tinted = contrastOnTint(c, page, 0.12);
        if (tinted < 4.5) weak.push(`${name} on its tint: ${tinted.toFixed(2)}:1`);
      }
      expect(weak).toEqual([]);
    });

    it("keep CALL and PUT well apart, and apart from each other in either direction setting", async () => {
      await commands.colorScheme(scheme);
      serveBook();
      render(<Next />);
      await settle();
      const [c, p] = ["--call", "--put"].map((n) => oklab(token(root(), n)));
      expect(Math.hypot(c!.L - p!.L, c!.a - p!.a, c!.b - p!.b)).toBeGreaterThanOrEqual(0.15);
      // a type is not a direction: flipping up to red moves neither
      const before = ["--call", "--put"].map((n) => token(root(), n));
      root().dataset.up = "red";
      expect(["--call", "--put"].map((n) => token(root(), n))).toEqual(before);
      // CALL is teal and PUT orange, never the other way round
      const hue = (x: { a: number; b: number }) => (Math.atan2(x.b, x.a) * 180 / Math.PI + 360) % 360;
      expect(hue(c!)).toBeGreaterThan(185);
      expect(hue(c!)).toBeLessThan(205);
      expect(hue(p!)).toBeGreaterThan(40);
      expect(hue(p!)).toBeLessThan(60);
    });

    it("tint the add form's types, choose one solid, draw its sides by weight and sign, and leave the modes neutral", async () => {
      await commands.colorScheme(scheme);
      await page.viewport(1440, 900);
      serveAdding({ status: 201, body: {} });
      render(<Next />);
      await settle();
      await userEvent.click(screen.getByRole("button", { name: "add" }));
      await expectFormColours(screen.getByRole("region", { name: "add a spread or contract" }));
    });

    it("colour each type letter in the book and bold a short leg, in text and in a chart", async () => {
      await commands.colorScheme(scheme);
      serveBook();
      render(<Next />);
      await settle();
      const [call, put] = ["var(--call)", "var(--put)"].map((c) => resolved(root(), c));
      const legs = root().querySelectorAll<HTMLElement>(".nxd-row [data-col='legs'] .nx-leg");
      expect(legs.length).toBeGreaterThan(0);
      for (const leg of legs) {
        const t = leg.querySelector<HTMLElement>(".nx-leg-t")!;
        expect(getComputedStyle(t).color, leg.textContent!).toBe(t.dataset.type === "CALL" ? call : put);
        const weight = Number(getComputedStyle(leg).fontWeight);
        if (leg.dataset.side === "short") expect(weight, leg.textContent!).toBeGreaterThanOrEqual(700);
        else expect(weight, leg.textContent!).toBeLessThan(600);
        // the sign and the strike keep the cell's own colour: only the letter is the type's
        expect(getComputedStyle(leg).color).not.toBe(call);
        expect(getComputedStyle(leg).color).not.toBe(put);
      }
      // a chart's leg names (the IV chart, the SPX chart) are SVG text, coloured by their fill
      cleanup();
      render(
        <div className="nx">
          <p><Legs legs={[{ short: true, option_type: "CALL", strike: 7400 }, { short: false, option_type: "PUT", strike: 6250 }]} /></p>
          <svg><SvgLeg leg={{ short: true, option_type: "PUT", strike: 6300 }} x={0} y={10} /></svg>
        </div>,
      );
      const tspan = root().querySelector<SVGElement>("svg .nx-leg-t")!;
      expect(getComputedStyle(tspan).fill).toBe(put);
      expect(Number(getComputedStyle(root().querySelector("svg .nx-leg")!).fontWeight)).toBeGreaterThanOrEqual(600);
      expect(within(root()).getByText("C").closest(".nx-leg")!.textContent).toBe("-C7400");
    });
  });
}
