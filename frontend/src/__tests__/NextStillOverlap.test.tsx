/** The saved image (#300) places a combo that only partly overlaps a holding where the book does
 *  (#346): in the watchlist, with its note, on either arrangement — the picture is drawn by its own
 *  tree, so it is held here rather than assumed from the page's. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Arrangement } from "../next/arrangement";
import { Still } from "../next/snapshot/Still";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

afterEach(cleanup);

function picture(arrangement: Arrangement, privacy = false) {
  render(<Still arrangement={arrangement} quotes={OVERLAP_QUOTES} monitors={OVERLAP_MONITORS}
                holdings={OVERLAP_HOLDINGS} holdingsError={null} holdingsAt={null} mode="live"
                privacy={privacy} entryStyle="opportunity" needs={[]} health={null} polledAt={null}
                error={null} references={[]} />);
}

/** The section a ref is drawn in, by the heading that opens it. */
function sectionOf(ref: string): string | null {
  const el = [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((e) => e.dataset.ref === ref);
  // the nearest section that has a heading of its own: an expiry's sits inside its section's
  for (let s = el?.closest("section"); s; s = s.parentElement?.closest("section")) {
    const h2 = s.querySelector("h2");
    if (h2) return h2.textContent;
  }
  return null;
}

const NOTES = ["shares C8100 with 1231_8050", "contains 1231_7700's C7700", "contains 1231_7200's C7200 and C7250"];
const notes = () => [...document.querySelectorAll("[data-overlap]")].map((n) => n.textContent);

describe.each(["desk", "phone"] as Arrangement[])("the picture from the %s", (arrangement) => {
  it("draws the partly overlapping combos in the watchlist with their notes", () => {
    picture(arrangement);
    expect(sectionOf("r-8100")).toBe("Watchlist");
    expect(sectionOf("w-7700")).toBe("Watchlist");
    expect(sectionOf("r-8050")).toBe("Holdings");
    expect(sectionOf("r-8050-delta")).toBe("Holdings");
    expect(sectionOf("r-7700")).toBe("Holdings");
    // a wing of a held condor names nothing unheld; a ratio's second C7250 is held by nobody
    expect(sectionOf("r-ic-calls")).toBe("Holdings");
    expect(sectionOf("r-ratio")).toBe("Watchlist");
    expect(notes()).toEqual(NOTES);
  });

  it("keeps the notes under privacy, which have no $ in them", () => {
    picture(arrangement, true);
    expect(notes()).toEqual(NOTES);
  });
});
