/** The hyphen-minus guard over the WHOLE page (review of #418): `NumberFormat.test.tsx` walks the
 *  book's table, inspectors, cards and sheets; this walks everything else the page draws a figure
 *  in, from the page itself (`<Next />`) behind a service — the References strip, the price map, the
 *  closed trades, a holding's edit form with its quantity's payoff comparison and its close form, a
 *  rule's editor with its total Entry split, and every payoff's crosshair readout and tooltip. Text
 *  and every title and aria-label alike (`saidBy`).
 *
 *  Copy as text is NOT walked: it writes a figure's minus as the hyphen on purpose (the owner,
 *  2026-11-16, `MARKDOWN_FIGURE_MINUS`), and `NextPlainView.test.tsx` holds it to that.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hyphenSigns, saidBy } from "../testing/hyphens";
import { walkDesk, walkPhone, type Read } from "../testing/pageWalk";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of ["ui_arrangement", "ui_price_map", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

/** What a place says, kept with where it was read. */
function reading(): { said: string[]; read: Read } {
  const said: string[] = [];
  const read: Read = (where, root) => { said.push(...hyphenSigns(saidBy(root)).map((s) => `${where}: ${s}`)); };
  return { said, read };
}

describe("no figure signed with a hyphen-minus, anywhere on the page (review of #418)", () => {
  it("on the desk: the References, the price map, the closed trades, the holding forms, the split and the crosshairs", async () => {
    const { said, read } = reading();
    await walkDesk(read);
    expect(said).toEqual([]);
  }, 60_000);

  it("on the phone: the References, the closed trades, the holding forms in the sheet and the crosshairs", async () => {
    const { said, read } = reading();
    await walkPhone(read);
    expect(said).toEqual([]);
  }, 60_000);
});
