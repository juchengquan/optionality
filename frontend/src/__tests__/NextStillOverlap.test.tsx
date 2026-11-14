/** The saved image (#300) places a combo that only partly overlaps a holding where the book does
 *  (#346): in the watchlist — the picture is drawn by its own tree, one plain table from either
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
  it("draws the partly overlapping combos in the watchlist, each by its name alone", () => {
    picture(privacy);
    const watch = namesIn("Watchlist");
    const held = namesIn("Holdings");
    for (const id of ["r-8100", "w-7700", "r-ratio"]) expect(watch).toContain(nameOf(id));
    // a wing of a held condor names nothing unheld, and a rule on held contracts stays under them
    for (const id of ["r-8050", "r-8050-delta", "r-7700", "r-ic-calls"]) expect(held).toContain(nameOf(id));
    // no bracket note anywhere in the table (#400)
    for (const n of [...watch, ...held]) expect(n).not.toMatch(/[()]|shares|contains/);
  });
});
