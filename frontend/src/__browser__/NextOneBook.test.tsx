/** The one book on the desk, in a real layout engine (2026-11-17): at 900, 1024, 1280 and 1440px, the
 *  inspector shut and open, nothing is pushed sideways, every row stays inside the table, and the
 *  "held" tag and the "contracts" label are drawn, inside the table and uncovered — the widest name
 *  cell now carries a Level's chip, its own rule's chip and distance as well as the tag. The
 *  behaviour is `__tests__/NextOneBook.test.tsx`'s. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { notAChip, overflowsSideways, settle } from "./nextBook";
import { placed, serveOneBook } from "../testing/oneBookServe";

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

const table = () => document.querySelector<HTMLElement>(".nxd-table")!;
const row = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;

describe.each([900, 1024, 1280, 1440])("at %ipx", (width) => {
  for (const open of [false, true]) {
    it(`draws the one book inside the table, the inspector ${open ? "open" : "shut"}`, async () => {
      await page.viewport(width, 900);
      serveOneBook();
      render(<Next />);
      await settle();
      expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
      if (open) {
        fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300 held" }));
        await settle();
        expect(document.querySelector(".nxd-inspector")).toBeTruthy();
      }
      expect(overflowsSideways()).toBe(false);
      expect(table().scrollWidth).toBeLessThanOrEqual(table().clientWidth);
      const edge = table().getBoundingClientRect().right;
      const out = [...document.querySelectorAll<HTMLElement>(".nxd-row [data-col]")]
        .filter((c) => c.getBoundingClientRect().right > edge + 0.5)
        .map((c) => `${c.closest<HTMLElement>(".nxd-row")!.dataset.ref} ${c.dataset.col}`);
      expect(out).toEqual([]);
      const tags = [...document.querySelectorAll(".nxd-row [data-held]")];
      expect(tags).toHaveLength(3);
      for (const tag of tags) expect(placed(tag, tag.closest("[data-col]")!), tag.closest<HTMLElement>(".nxd-row")!.dataset.ref).toBeNull();
      for (const tag of tags) expect(notAChip(tag), tag.closest<HTMLElement>(".nxd-row")!.dataset.ref).toBeNull();
      const label = document.querySelector("[data-sub=contracts]")!;
      expect(placed(label, table())).toBeNull();
      // one heading per expiry
      expect([...document.querySelectorAll(".nxd-expiry h3")].map((h) => h.textContent!.slice(0, 8)))
        .toEqual(["20261204", "20261218", "20261231"]);
    });
  }
});
