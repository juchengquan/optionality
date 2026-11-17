/** The saved image (#300) places a combo that only partly overlaps a holding where the book does
 *  (#346): among the watched spreads — the picture is drawn by its own tree, one plain table from either
 *  arrangement since #394, so it is held here rather than assumed from the page's. Since #400 the
 *  row is named alone, with no note in brackets: the page keeps its note, the table does not.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { entryName } from "../needs";
import { Still } from "../snapshot/Still";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

afterEach(cleanup);

function picture(privacy = false) {
  render(<Still quotes={OVERLAP_QUOTES} monitors={OVERLAP_MONITORS} holdings={OVERLAP_HOLDINGS} holdingsError={null}
                holdingsAt={null} session privacy={privacy} needs={[]} health={null} polledAt={null} error={null}
                references={[]} hidden={new Set()} takenAt={new Date("2026-11-16T15:00:00Z")} />);
}

/** A rule's name in the picture, from its id. */
const nameOf = (id: string) => entryName(OVERLAP_QUOTES.find((q) => q.id === id)!);

/** The name cells of a section, by the section's heading. */
function namesIn(title: string): string[] {
  const section = [...document.querySelectorAll(".nx-still section")].find((s) => s.querySelector("h2")!.textContent === title)!;
  return [...section.querySelectorAll("tbody tr:not([data-group])")].map((tr) => tr.children[0]!.textContent!);
}

describe.each([false, true])("the picture, privacy %s", (privacy) => {
  it("draws the partly overlapping combos among the watched spreads, after the held ones, each by its name alone", () => {
    picture(privacy);
    const book = namesIn("Book");
    // the held spreads first, "held" in the name cell, their own rule on their row; then the
    // combos that name a contract nobody holds, as watched spreads (2026-11-17)
    expect(book).toEqual([
      "1231_8050 held", nameOf("r-8050-delta"), "1231_7700 held", "1231_IC held", nameOf("r-ic-calls"),
      "1231_7200 held", nameOf("r-8100"), nameOf("w-8150-delta"), nameOf("w-7700"), nameOf("r-ratio"),
    ]);
    // no bracket note anywhere in the table (#400)
    for (const n of book) expect(n).not.toMatch(/[()]|shares|contains/);
  });
});
