/** The inspector's sections in their one order (part J of the owner's standard, 2026-11-16), MEASURED
 *  at a desk's widths: every holding's and watched row's inspector draws its sections in the list's
 *  order, each inside the inspector, pushing nothing sideways. The phone's sheet is `.iphone.`'s. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { serveGreeks } from "../testing/greekLabels";
import { overflowsSideways, settle } from "./nextBook";
import { inListOrder, sectionsIn } from "./sections";

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("one section order, measured on the desk", () => {
  it.each([1440, 900])("in every inspector at %ipx: in the list's order, inside the inspector", async (width) => {
    await page.viewport(width, 900);
    serveGreeks();
    render(<Next />);
    await settle();
    const names = [...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].map((b) => b.textContent!);
    expect(names.length).toBeGreaterThan(8);
    let holdings = 0;
    for (const name of names) {
      fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === name)!);
      await settle();
      const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
      const { order, past } = sectionsIn(insp);
      expect(inListOrder(order), `${name}: ${order.join(" ")}`).toBe(true);
      expect(past, name).toEqual([]);
      expect(insp.scrollWidth, name).toBeLessThanOrEqual(insp.clientWidth);
      expect(overflowsSideways(), name).toBe(false);
      if (order.includes("actions")) holdings++;
    }
    expect(holdings).toBeGreaterThan(2);
  });
});
