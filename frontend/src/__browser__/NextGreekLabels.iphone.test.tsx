/** No label with a Greek letter set in capitals, MEASURED under Playwright's iPhone profile: the
 *  cards and every card's sheet. The desk's is `NextGreekLabels.test.tsx`. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { greekInCapitals, serveGreeks } from "../testing/greekLabels";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

describe("Greek letters as written, on the phone", () => {
  it("on the cards and in every sheet, its figures' labels position Δ Γ Θ ν included", async () => {
    serveGreeks();
    render(<Next />);
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    const found = greekInCapitals();
    const opens = [...document.querySelectorAll<HTMLButtonElement>(".nxp-open")].map((b) => b.getAttribute("aria-label")!);
    expect(opens.length).toBeGreaterThan(5);
    let labels = 0;
    for (const label of opens) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await settle();
      const sheet = screen.getByRole("dialog");
      found.push(...greekInCapitals(sheet).map((f) => `${label}: ${f}`));
      expect(sheet.scrollWidth, label).toBeLessThanOrEqual(sheet.clientWidth);
      expect(overflowsSideways(), label).toBe(false);
      for (const dt of sheet.querySelectorAll<HTMLElement>("dt")) {
        if (/[Ͱ-Ͽ]/.test(dt.textContent!)) { labels++; expect(dt.innerText).toBe(dt.textContent); }
      }
      window.history.back();
      await settle();
      await settle();
    }
    expect(labels).toBeGreaterThan(20);
    expect(found).toEqual([]);
  });
});
