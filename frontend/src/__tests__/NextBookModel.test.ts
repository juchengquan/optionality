/** Which rule sits where, and what is bracketed with what: the redesign's book as a model, before
 *  either arrangement draws it (ADR 0023; #289 the desk, #290 the phone). Both arrangements draw
 *  THIS, so the phone cannot group the owner's book differently from the desk. */
import { describe, expect, it } from "vitest";

import { namesUnheldContract, overlapOf, placeBook } from "../next/placement";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

describe("the holdings", () => {
  const book = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("come first, by expiry", () => {
    expect(book.holdings.map((g) => g.expiry)).toEqual(["2026-12-18", "2026-12-31"]);
  });

  it("bracket a condor's two held spreads on one expiry, calls then puts", () => {
    const dec18 = book.holdings[0]!;
    expect(dec18.rows).toHaveLength(1);
    expect(dec18.rows[0]!.map((p) => p.holding.id)).toEqual(["h-calls", "h-puts"]);
  });

  it("keep a 4-leg holding as one row of its own", () => {
    const dec31 = book.holdings[1]!;
    expect(dec31.rows.map((r) => r.map((p) => p.holding.id))).toEqual([["h-ic"]]);
  });

  it("carry the rules about each holding under it", () => {
    const calls = book.holdings[0]!.rows[0]![0]!;
    expect(ids(calls.rules)).toEqual(["r-calls"]);
    expect(ids(book.holdings[1]!.rows[0]![0]!.rules)).toEqual(["r-ic"]);
  });

  it("do not bracket two spreads on the same side, nor spreads on two expiries", () => {
    const [calls] = HOLDINGS.filter((h) => h.id === "h-calls");
    const twin = { ...calls!, id: "h-calls-2", name: "1218_C7400" };
    const later = { ...HOLDINGS[0]!, id: "h-puts-jan", strike_date: "2027-01-15" };
    const b = placeBook(QUOTES, [calls!, twin, later], MONITORS);
    expect(b.holdings.flatMap((g) => g.rows.map((r) => r.length))).toEqual([1, 1, 1]);
  });

  it("are null while not valued, and the rules about them are still shown, unplaced", () => {
    const b = placeBook(QUOTES, null, MONITORS);
    expect(b.holdings).toEqual([]);
    expect(ids(b.unplaced)).toEqual(["r-calls", "r-ic"]);
  });
});

describe("the watchlist", () => {
  const book = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("follows, by expiry, with only rules on nothing held", () => {
    expect(book.watchlist.map((g) => g.expiry)).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
    const all = book.watchlist.flatMap((g) => g.items.flatMap((i) => [i.entry, ...i.under]));
    expect(all.every((e) => !e.held)).toBe(true);
  });

  it("sits a short leg's delta rule under its spread", () => {
    const dec18 = book.watchlist[1]!;
    expect(dec18.items.map((i) => i.entry.id)).toEqual(["w-dec18"]);
    expect(ids(dec18.items[0]!.under)).toEqual(["w-dec18-delta"]);
  });

  it("lets a rule that matches no spread stand alone", () => {
    expect(book.watchlist[2]!.items.map((i) => i.entry.id)).toEqual(["w-dec31", "w-lone"]);
  });
});

describe("the rules that are off", () => {
  const book = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("are quarantined when the service switched them off, and muted otherwise", () => {
    expect(ids(book.quarantined)).toEqual(["q-unknown"]);
    expect(ids(book.muted)).toEqual(["m-expired", "m-muted"]);
  });
});

describe("a combo that only partly overlaps a holding (#346)", () => {
  const book = placeBook(OVERLAP_QUOTES, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
  const under = (id: string) => book.holdings.flatMap((g) => g.rows.flat())
    .find((p) => p.holding.id === id)!.rules.map((r) => r.id);
  const items = () => book.watchlist.flatMap((g) => g.items);

  it("is drawn in the watchlist when it names a contract its holdings do not hold", () => {
    expect(under("h-8050")).toEqual(["r-8050", "r-8050-delta"]);
    expect(items().map((i) => i.entry.id)).toEqual(["r-8100", "w-7700", "r-ratio"]);
  });

  it("keeps under the holding every rule on nothing but what it holds", () => {
    // its own value rule, and a single contract on its short leg
    expect(under("h-8050")).toContain("r-8050");
    expect(under("h-8050")).toContain("r-8050-delta");
    expect(under("h-7700")).toEqual(["r-7700"]);
    // a wing of a held condor watches risk on something held: scope leg, and it stays
    expect(under("h-ic")).toEqual(["r-ic-calls"]);
    // a ratio's second C7250 is held by nobody: the holding is left with no rule
    expect(under("h-7200")).toEqual([]);
  });

  it("says which contracts it shares with which holding, on every arrangement of the overlap", () => {
    const note = (id: string) => items().find((i) => i.entry.id === id)!.overlap;
    // scope leg: the holding holds part of it
    expect(note("r-8100")).toBe("shares C8100 with 1231_8050");
    // scope all, larger than the holding: it contains all of the holding and more
    expect(note("w-7700")).toBe("contains 1231_7700's C7700");
    expect(note("r-ratio")).toBe("contains 1231_7200's C7200 and C7250");
  });

  it("carries the leg rules of a moved combo under it, as a watched spread's", () => {
    expect(items().find((i) => i.entry.id === "r-8100")!.under.map((r) => r.id)).toEqual(["w-8150-delta"]);
  });

  it("leaves a holding with no rule left still drawn", () => {
    const lone = OVERLAP_QUOTES.filter((q) => q.id !== "r-7700");
    const b = placeBook(lone, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
    const h = b.holdings.flatMap((g) => g.rows.flat()).find((p) => p.holding.id === "h-7700");
    expect(h?.rules).toEqual([]);
    expect(b.watchlist.flatMap((g) => g.items).map((i) => i.entry.id)).toContain("w-7700");
  });

  it("stays unplaced, as today, while the holdings are not valued", () => {
    const b = placeBook(OVERLAP_QUOTES, null, OVERLAP_MONITORS);
    expect(b.unplaced.map((e) => e.id))
      .toEqual(["r-8050", "r-8050-delta", "r-8100", "r-7700", "w-7700", "r-ic-calls", "r-ratio"]);
    expect(b.watchlist.flatMap((g) => g.items).every((i) => i.overlap === null)).toBe(true);
  });

  it("gives every watched rule nothing held no note", () => {
    const b = placeBook(QUOTES, HOLDINGS, MONITORS);
    expect(b.watchlist.flatMap((g) => g.items).map((i) => i.overlap)).toEqual([null, null, null, null]);
  });
});

describe("namesUnheldContract: the one predicate every surface asks (#346)", () => {
  const [h8050, h7700, hIc, h7200] = OVERLAP_HOLDINGS;
  const calls = (...strikes: number[]) => ({
    strike_date: "2026-12-31", legs: strikes.map((strike) => ({ option_type: "CALL", strike })),
  });

  it("is false for a combo on exactly the holding's contracts, whatever its signs or order", () => {
    expect(namesUnheldContract(calls(8050, 8100), [h8050!])).toBe(false);
    expect(namesUnheldContract(calls(8100, 8050), [h8050!])).toBe(false);
  });

  it("is false for a wing of a held condor: every contract it names is held", () => {
    expect(namesUnheldContract(calls(7400, 7450), [hIc!])).toBe(false);
  });

  it("is true for a combo the holding holds only part of, or one holding more than the holding", () => {
    expect(namesUnheldContract(calls(8100, 8150), [h8050!])).toBe(true);
    expect(namesUnheldContract(calls(7700, 7750), [h7700!])).toBe(true);
  });

  it("counts a contract named twice twice: a 1×2 ratio over a 1×1 holding names one unheld", () => {
    expect(namesUnheldContract(calls(7200, 7250, 7250), [h7200!])).toBe(true);
    expect(namesUnheldContract(calls(7200, 7250), [h7200!])).toBe(false);
    // held twice over, by two holdings taken together, it is all held
    expect(namesUnheldContract(calls(7200, 7250, 7250), [h7200!, h7200!])).toBe(false);
  });

  it("is true for the same strikes on another expiry, or on the other side", () => {
    expect(namesUnheldContract({ ...calls(8050, 8100), strike_date: "2027-01-15" }, [h8050!])).toBe(true);
    const puts = { strike_date: "2026-12-31",
      legs: [{ option_type: "PUT", strike: 8050 }, { option_type: "PUT", strike: 8100 }] };
    expect(namesUnheldContract(puts, [h8050!])).toBe(true);
  });

  it("is false for a combo that is exactly the holdings it is linked to, taken together", () => {
    // a condor rule over a condor held as two spreads: every contract held
    const [puts, callSide] = HOLDINGS;
    const condor = { strike_date: "2026-12-18", legs: [...callSide!.legs, ...puts!.legs] };
    expect(namesUnheldContract(condor, [callSide!, puts!])).toBe(false);
    expect(namesUnheldContract(condor, [callSide!])).toBe(true);
  });
});

describe("overlapOf: the note, or null where the rule stays (#346)", () => {
  const byId = (id: string) => OVERLAP_QUOTES.find((q) => q.id === id)!;
  const rule = (strikes: number[], positions: { id: string; name: string }[]) => ({
    strike_date: "2026-12-31", positions,
    legs: strikes.map((strike, i) => ({ sign: i === 0 ? -1 : 1, option_type: "CALL", strike })),
  });

  it("is null for a rule that stays, and a single contract is never an overlap", () => {
    expect(overlapOf(byId("r-8050"), OVERLAP_HOLDINGS)).toBeNull();
    expect(overlapOf(byId("r-8050-delta"), OVERLAP_HOLDINGS)).toBeNull();
    expect(overlapOf(byId("r-ic-calls"), OVERLAP_HOLDINGS)).toBeNull();
    expect(overlapOf(byId("r-8100"), OVERLAP_HOLDINGS)).toBe("shares C8100 with 1231_8050");
  });

  it("names each holding it is linked to, in the order linked, joined", () => {
    const two = rule([7700, 7750, 8100], [{ id: "h-8050", name: "1231_8050" }, { id: "h-7700", name: "1231_7700" }]);
    expect(overlapOf(two, OVERLAP_HOLDINGS)).toBe("shares C8100 with 1231_8050; contains 1231_7700's C7700");
  });

  it("says only that it is linked where it shares no contract with the holding", () => {
    const apart = rule([9000, 9050], [{ id: "h-8050", name: "1231_8050" }]);
    expect(overlapOf(apart, OVERLAP_HOLDINGS)).toBe("linked to 1231_8050");
  });

  it("is null while any holding it is linked to is not valued: nothing whole to compare", () => {
    expect(overlapOf(byId("r-8100"), [])).toBeNull();
    // linked to two, one valued: the unvalued one might hold what the valued one does not, so the
    // rule is drawn where it always was rather than moved on half the evidence
    const two = rule([7700, 7750, 8100], [{ id: "h-8050", name: "1231_8050" }, { id: "h-7700", name: "1231_7700" }]);
    expect(overlapOf(two, OVERLAP_HOLDINGS.filter((h) => h.id !== "h-7700"))).toBeNull();
  });
});
