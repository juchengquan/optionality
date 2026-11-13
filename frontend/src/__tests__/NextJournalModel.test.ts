/** The closed trades' journal (#296, #373), as a model: which rows of `GET /positions` are in
 *  it, in what order, and how a figure nobody recorded is said. The page is
 *  `NextJournal.test.tsx`; this is what it draws from. */
import { describe, expect, it } from "vitest";

import type { Recorded } from "../shared/api";
import { journalOf, madeWords, storedWords } from "../next/journal";

const row = (id: string, over: Partial<Recorded>): Recorded => ({
  id, name: id, strategy: null, strike_date: "2026-12-18", contracts: 1, entry: 2,
  legs: [{ side: "short", option_type: "PUT", strike: 6400 }, { side: "long", option_type: "PUT", strike: 6350 }],
  created_at: null, opened_at: "2026-11-03", closed_on: null, exit: null, realized_points: null, ...over,
});

describe("the journal", () => {
  it("holds only the closed holdings, never one still held", () => {
    const rows = [row("held", {}), row("done", { closed_on: "2026-11-09", exit: 1, realized_points: 1 })];
    expect(journalOf(rows).map((t) => t.id)).toEqual(["done"]);
  });

  it("is newest first by the day each closed, then by name, whatever order they were served in", () => {
    const rows = [
      row("a", { name: "1218_P6400", closed_on: "2026-11-05" }),
      row("b", { name: "1231_IC", closed_on: "2026-11-10" }),
      row("c", { name: "1218_C7300", closed_on: "2026-11-10" }),
      row("d", { name: "1120_P6000", closed_on: "2026-11-07" }),
    ];
    expect(journalOf(rows).map((t) => t.name)).toEqual(["1218_C7300", "1231_IC", "1120_P6000", "1218_P6400"]);
    expect(journalOf([...rows].reverse()).map((t) => t.name))
      .toEqual(["1218_C7300", "1231_IC", "1120_P6000", "1218_P6400"]);
  });

  it("changes nothing it was handed", () => {
    const rows = [row("a", { closed_on: "2026-11-05" }), row("b", { closed_on: "2026-11-10" })];
    journalOf(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("a figure, said", () => {
  it("says an Exit or an Entry nobody recorded as unknown, never 0", () => {
    expect(storedWords(null)).toBe("unknown");
    expect(storedWords(0)).toBe("0");
    // as STORED: 1.225 is not 1.23, and a sum's float noise is trimmed
    expect(storedWords(1.225)).toBe("1.225");
    expect(storedWords(2.35 - 1.15)).toBe("1.2");
    expect(storedWords(-7)).toBe("-7");
  });

  it("says what a trade made in points as served, unknown where the service could not say, and hides it under privacy", () => {
    expect(madeWords(7, false)).toBe("7 pts");
    expect(madeWords(-1.5, false)).toBe("-1.5 pts");
    expect(madeWords(0, false)).toBe("0 pts");
    // as stored, with only a sum's float noise trimmed: 0.004 is not "0.00", which reads as even
    expect(madeWords(0.004, false)).toBe("0.004 pts");
    expect(madeWords(2.35 - 1.15, false)).toBe("1.2 pts");
    expect(madeWords(null, false)).toBe("unknown");
    // across the contracts held, so under privacy it would give the size away (#325)
    expect(madeWords(7, true)).toBe("••• pts");
    expect(madeWords(null, true)).toBe("unknown");
  });
});
