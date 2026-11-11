/** Which rule sits where, and what is bracketed with what: the redesign's book as a model, before
 *  either arrangement draws it (ADR 0023; #289 the desk, #290 the phone). Both arrangements draw
 *  THIS, so the phone cannot group the owner's book differently from the desk. */
import { describe, expect, it } from "vitest";

import { placeBook } from "../next/placement";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

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
