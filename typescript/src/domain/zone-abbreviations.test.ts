/** How ICU names a zone, against how tzdata names it (testdata/zone-abbreviations.json).
 *
 *  `displayTimeShort` is the one formatting in the port that cannot be made exact, and the five
 *  zones where the two libraries disagree were measured once by a differential that no longer
 *  exists (`diff-api`, #145) and then visited by nothing at all: no unit test, and one golden case
 *  in the owner's own zone, which is a zone where they AGREE. A documented divergence that nothing
 *  asserts is a comment, and comments do not fail.
 *
 *  So the table is data both suites read. This file asserts the `ts` column — ICU's answer, which
 *  is what the bot actually prints — and that the rows claiming to agree really do. The Python
 *  asserts the `py` column from the same rows (python/tests/test_zone_abbreviations.py). A change
 *  in ICU fails here, a change in tzdata fails there, and `display_time_short` cannot be quietly
 *  taught to match ICU without a row failing first.
 *
 *  Where they agree the case belongs in testdata/golden/ as well, and those rows are there — the
 *  Python must reproduce them exactly. Where they do not agree a golden case is impossible, which
 *  is why this file exists outside that mechanism rather than as a tolerance inside it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { displayTimeShort } from "./timefmt.ts";

interface Row { zone: string; at: string; ts: string; py: string; note: string }

const TABLE = JSON.parse(
  readFileSync(new URL("../../../testdata/zone-abbreviations.json", import.meta.url), "utf8"),
) as { rows: Row[] };

describe("the zone abbreviations, as ICU gives them", () => {
  it("has rows on both sides of the divergence", () => {
    // a table that drifted to all-agreeing would make every assertion below vacuous while staying
    // green, and the disagreements are the whole reason it exists
    const differ = TABLE.rows.filter((r) => r.ts !== r.py);
    expect(TABLE.rows.length).toBeGreaterThanOrEqual(13);
    expect(differ.length).toBeGreaterThanOrEqual(7);
    expect(new Set(differ.map((r) => r.zone)).size).toBe(5);
  });

  for (const row of TABLE.rows) {
    it(`prints ${row.ts} for ${row.zone}`, () => {
      expect(displayTimeShort(new Date(row.at), row.zone)).toBe(row.ts);
    });
  }

  it("agrees with tzdata on an offset-named zone and disagrees where tzdata has a name", () => {
    // the shape of the divergence, not just its contents: ICU's answer is numeric exactly where it
    // differs from Python's, and that is the ONE rule behind all seven rows
    for (const row of TABLE.rows.filter((r) => r.ts !== r.py)) {
      expect(row.ts, `${row.zone} at ${row.at}`).toMatch(/ [+-]\d{2}(\d{2})?$/);
      expect(row.py, `${row.zone} at ${row.at}`).toMatch(/ [A-Z]{3,5}$/);
    }
  });

  it("is the same zone on both sides of a daylight boundary, and parts there", () => {
    // Europe/London is the sharpest row: a zone is not agreeing or disagreeing, an INSTANT is.
    // ICU has GMT and does not have BST, so the same DISPLAY_TZ reads exactly to Python in January
    // and differs from it in July — which no per-zone table would have caught.
    const london = TABLE.rows.filter((r) => r.zone === "Europe/London");
    expect(london).toHaveLength(2);
    const [winter, summer] = london as [Row, Row];
    expect(winter.ts).toBe(winter.py);
    expect(summer.ts).not.toBe(summer.py);
    expect(displayTimeShort(new Date(winter.at), "Europe/London")).toBe("2026-01-15 12:00 GMT");
    expect(displayTimeShort(new Date(summer.at), "Europe/London")).toBe("2026-07-15 13:00 +01");
  });
});
