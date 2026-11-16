/** The sheet's sections in their one order (part J), MEASURED under Playwright's iPhone profile: every
 *  card's sheet draws its sections in the list's order — the desk's inspector's — each inside the
 *  sheet, nothing pushed sideways, and every control in the holding's actions and the rules a 44pt
 *  target, the sheet's own close button ("close sheet") among them. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { serveGreeks } from "../testing/greekLabels";
import { overflowsSideways, settle } from "./nextBook";
import { inListOrder, sectionsIn } from "./sections";
import { tooSmall } from "./targets";

afterEach(cleanup);

describe("one section order, measured on the phone", () => {
  it("in every card's sheet: in the list's order, inside the sheet, every action a 44pt target", async () => {
    serveGreeks();
    render(<Next />);
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    const opens = [...document.querySelectorAll<HTMLButtonElement>(".nxp-open")].map((b) => b.getAttribute("aria-label")!);
    expect(opens.length).toBeGreaterThan(5);
    const small: string[] = [];
    for (const label of opens) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await settle();
      const sheet = screen.getByRole("dialog");
      const { order, past } = sectionsIn(sheet);
      expect(inListOrder(order), `${label}: ${order.join(" ")}`).toBe(true);
      expect(past, label).toEqual([]);
      expect(sheet.scrollWidth, label).toBeLessThanOrEqual(sheet.clientWidth);
      expect(overflowsSideways(), label).toBe(false);
      const controls = sheet.querySelectorAll<HTMLElement>(
        "[data-section='actions'] button, [data-section='rules'] button, button[aria-label='close sheet']");
      small.push(...tooSmall(controls).map((s) => `${label}: ${s}`));
      window.history.back();
      await settle();
      await settle();
    }
    expect(small).toEqual([]);
  });
});
