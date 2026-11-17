/** ONE book (the owner, 2026-11-17): holdings and watches together, by expiry. The model every
 *  surface draws — the desk, the phone, the saved picture and Copy as text — so the order is decided
 *  here once: each expiry once; under it the held spreads, the watched spreads, the lone contracts. */
import { describe, expect, it } from "vitest";

import { ownRule, placeBook } from "../placement";
import { entry, HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id);

describe("the one book", () => {
  const { book } = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("has each expiry once, the earliest first, whether it holds, watches or both", () => {
    expect(book.map((g) => g.expiry)).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
  });

  it("puts the held spreads first, then the watched spreads, then the lone contracts", () => {
    const [dec04, dec18, dec31] = book;
    expect(dec04!.held).toEqual([]);
    expect(dec04!.spreads.map((i) => i.entry.id)).toEqual(["w-dec04"]);
    expect(dec18!.held.map((b) => b.map((p) => p.holding.id))).toEqual([["h-calls", "h-puts"]]);
    expect(dec18!.spreads.map((i) => i.entry.id)).toEqual(["w-dec18"]);
    expect(dec31!.held.map((b) => b.map((p) => p.holding.id))).toEqual([["h-ic"]]);
    expect(dec31!.spreads.map((i) => i.entry.id)).toEqual(["w-dec31"]);
    expect(dec31!.contracts.map((i) => i.entry.id)).toEqual(["w-lone"]);
  });

  it("has lone contracts only where an expiry has some", () => {
    expect(book.map((g) => g.contracts.length)).toEqual([0, 0, 1]);
  });

  it("keeps a leg's rule under its watched spread", () => {
    expect(ids(book[1]!.spreads[0]!.under)).toEqual(["w-dec18-delta"]);
  });

  it("says each expiry's DTE from its first row", () => {
    expect(book.map((g) => g.dte)).toEqual([38, 38, 38]);
  });

  it("is the watchlist alone while the holdings are not valued", () => {
    const b = placeBook(QUOTES, null, MONITORS);
    expect(b.book.flatMap((g) => g.held)).toEqual([]);
    expect(b.book.map((g) => g.expiry)).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
  });

  it("is empty with nothing held or watched", () => {
    expect(placeBook([], [], []).book).toEqual([]);
  });
});

describe("a holding's own rule", () => {
  it("is the combo named as the holding, and comes first among its rules", () => {
    const { book } = placeBook(QUOTES, HOLDINGS, MONITORS);
    const calls = book[1]!.held[0]![0]!;
    expect(ownRule(calls.holding, calls.rules)?.id).toBe("r-calls");
    expect(ownRule(book[2]!.held[0]![0]!.holding, book[2]!.held[0]![0]!.rules)?.id).toBe("r-ic");
  });

  it("is none for a holding with no rule named as it", () => {
    const { book } = placeBook(QUOTES, HOLDINGS, MONITORS);
    const puts = book[1]!.held[0]![1]!;
    expect(ownRule(puts.holding, puts.rules)).toBeNull();
  });

  it("is first even where a second rule arrived before it", () => {
    const second = entry("r-calls-delta", {
      code: "US.SPXW261218C7300000", strike_date: "2026-12-18", option_type: "CALL", field: "option_delta",
      threshold: 0.3, held: true, scope: "leg", positions: [{ id: "h-calls", name: "1218_C7300" }],
      quote: { name: "SPXW 261218 7300.00C", option_delta: 0.33 },
    });
    const { book } = placeBook([second, ...QUOTES], HOLDINGS, MONITORS);
    expect(ids(book[1]!.held[0]![0]!.rules)).toEqual(["r-calls", "r-calls-delta"]);
  });

  it("is the live book's value rule, and the delta on its short leg is not", () => {
    const { book } = placeBook(OVERLAP_QUOTES, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
    const h8050 = book[0]!.held.flat().find((p) => p.holding.id === "h-8050")!;
    expect(ownRule(h8050.holding, h8050.rules)?.id).toBe("r-8050");
    expect(ids(h8050.rules)).toEqual(["r-8050", "r-8050-delta"]);
    // a single contract named as the holding would be no own rule: only a combo is
    const h7700 = book[0]!.held.flat().find((p) => p.holding.id === "h-7700")!;
    expect(ownRule(h7700.holding, h7700.rules)).toBeNull();
  });
});

describe("a watched contract on a held leg", () => {
  // a delta rule on 1218_P6400's short leg, which the service links to nothing
  const onLeg = entry("w-p6400", {
    code: "US.SPXW261218P6400000", strike_date: "2026-12-18", option_type: "PUT", field: "option_delta",
    threshold: 0.3, quote: { name: "SPXW 261218 6400.00P", option_delta: -0.21 },
  });

  it("sits under the holding, as a leg's rule sits under its watched spread", () => {
    const { book } = placeBook([...QUOTES, onLeg], HOLDINGS, MONITORS);
    const puts = book[1]!.held[0]![1]!;
    expect(ids(puts.rules)).toEqual(["w-p6400"]);
    expect(book[1]!.contracts).toEqual([]);
  });

  it("stands alone among the contracts while the holdings are not valued", () => {
    const { book } = placeBook([...QUOTES, onLeg], null, MONITORS);
    expect(book[1]!.contracts.map((i) => i.entry.id)).toEqual(["w-p6400"]);
  });

  it("stays under a watched spread with that leg, which comes first", () => {
    const both = { ...onLeg, in_combos: ["w-dec18"] };
    const { book } = placeBook([...QUOTES, both], HOLDINGS, MONITORS);
    expect(ids(book[1]!.spreads[0]!.under)).toEqual(["w-dec18-delta", "w-p6400"]);
    expect(book[1]!.held[0]![1]!.rules).toEqual([]);
  });

  it("on another expiry's contract of the same strike stays a lone contract", () => {
    const later = { ...onLeg, id: "w-p6400-jan", code: "US.SPXW270115P6400000", strike_date: "2027-01-15" };
    const { book } = placeBook([...QUOTES, later], HOLDINGS, MONITORS);
    expect(book.at(-1)!.contracts.map((i) => i.entry.id)).toEqual(["w-p6400-jan"]);
  });
});

describe("the live book's partial overlap (#346)", () => {
  it("draws the combo that shares a contract among the same expiry's watched spreads, with its note", () => {
    const { book } = placeBook(OVERLAP_QUOTES, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
    expect(book).toHaveLength(1);
    const [g] = book;
    expect(g!.held.flat().map((p) => p.holding.id)).toEqual(["h-8050", "h-7700", "h-ic", "h-7200"]);
    expect(g!.spreads.map((i) => [i.entry.id, i.overlap])).toEqual([
      ["r-8100", "shares C8100 with 1231_8050"],
      ["w-7700", "contains 1231_7700's C7700"],
      ["r-ratio", "contains 1231_7200's C7200 and C7250"],
    ]);
  });
});
