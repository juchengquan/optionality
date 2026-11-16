/** No label with a Greek letter set in capitals (the owner's standard, 2026-11-16): an upper-case ν
 *  is "Ν", which reads as the letter N. MEASURED on the desk — the table and every row's inspector,
 *  every figure's label read as the browser draws it. The phone's is `.iphone.`'s. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { greekInCapitals, headingsInCapitals, serveGreeks } from "../testing/greekLabels";
import { overflowsSideways, settle } from "./nextBook";

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("Greek letters as written, on the desk", () => {
  it.each([1440, 900])("in the table and in every inspector at %ipx, its figures' labels position Δ Γ Θ ν included", async (width) => {
    await page.viewport(width, 900);
    serveGreeks();
    render(<Next />);
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
    // and no heading, label or button in capitals set by CSS (part H)
    const found = [...greekInCapitals(), ...headingsInCapitals()];
    const names = [...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].map((b) => b.textContent!);
    expect(names.length).toBeGreaterThan(8);
    let labels = 0;
    for (const name of names) {
      fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === name)!);
      await settle();
      const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
      found.push(...[...greekInCapitals(insp), ...headingsInCapitals(insp)].map((f) => `${name}: ${f}`));
      // the figures in their new order push nothing sideways
      expect(insp.scrollWidth, name).toBeLessThanOrEqual(insp.clientWidth);
      expect(overflowsSideways(), name).toBe(false);
      // and what the eye reads is what the source says: "position ν", never "POSITION Ν"
      for (const dt of insp.querySelectorAll<HTMLElement>("dt")) {
        if (/[Ͱ-Ͽ]/.test(dt.textContent!)) { labels++; expect(dt.innerText).toBe(dt.textContent); }
      }
    }
    // worth nothing unless it read some: a holding's four position greeks and a contract's four
    expect(labels).toBeGreaterThan(20);
    expect(found).toEqual([]);
  });
});
