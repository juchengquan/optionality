/** The one book on the phone, under the iPhone 13 profile (2026-11-17): nothing pushed sideways,
 *  each expiry's heading once, the "held" tag inside its card's name and the "contracts" label inside
 *  the page, uncovered. The behaviour is `__tests__/NextOneBook.test.tsx`'s. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { placed, serveOneBook } from "../testing/oneBookServe";

afterEach(cleanup);

describe("under the iPhone profile", () => {
  it("draws the one book inside the screen", async () => {
    serveOneBook();
    render(<Next />);
    await settle();
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    expect(document.documentElement.clientWidth).toBe(390);
    expect(overflowsSideways()).toBe(false);
    expect([...document.querySelectorAll(".nxp-expiry h3")].map((h) => h.textContent!.slice(0, 8)))
      .toEqual(["20261204", "20261218", "20261231"]);
    const tags = [...document.querySelectorAll("article [data-held]")];
    expect(tags).toHaveLength(3);
    for (const tag of tags) {
      const where = placed(tag, tag.closest("article")!);
      // the card's own button lies over its text by design (Cards.tsx: OpenCard): a tag under it is
      // still drawn, inside its card
      expect(where === null || where.startsWith("covered by nxp-open"), where ?? "").toBe(true);
    }
    const label = document.querySelector("[data-sub=contracts]")!;
    expect(placed(label, document.querySelector(".nxp-book")!)).toBeNull();
    for (const card of document.querySelectorAll<HTMLElement>("article[data-ref]")) {
      expect(card.scrollWidth, card.dataset.ref).toBeLessThanOrEqual(card.clientWidth + 0.5);
    }
  });
});
