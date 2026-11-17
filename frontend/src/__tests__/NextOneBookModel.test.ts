/** The book (the owner, 2026-11-17): holdings and watches together, in two sections — Spreads, then
 *  Contracts — each by expiry. The model every surface draws — the desk, the phone, the saved picture
 *  and Copy as text — so the order is decided here once. */
import { describe, expect, it } from "vitest";

import { ownRule, placeBook } from "../placement";
import { entry, holding, HOLDINGS, MONITORS, QUOTES, side } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id);

describe("the book in two sections (the owner, 2026-11-17)", () => {
  const { book, sections } = placeBook(QUOTES, HOLDINGS, MONITORS);
  const expiries = (k: "spreads" | "contracts") => sections.find((x) => x.kind === k)?.expiries ?? [];

  it("is Spreads, then Contracts, each by expiry, the earliest first", () => {
    expect(sections.map((x) => [x.kind, x.title])).toEqual([["spreads", "Spreads"], ["contracts", "Contracts"]]);
    expect(expiries("spreads").map((g) => g.expiry)).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
    expect(expiries("contracts").map((g) => g.expiry)).toEqual(["2026-12-31"]);
  });

  it("puts the held spreads first in Spreads, then the watched spreads; no contract among them", () => {
    const [dec04, dec18, dec31] = expiries("spreads");
    expect(dec04!.held).toEqual([]);
    expect(dec04!.spreads.map((i) => i.entry.id)).toEqual(["w-dec04"]);
    expect(dec18!.held.map((b) => b.map((p) => p.holding.id))).toEqual([["h-calls", "h-puts"]]);
    expect(dec18!.spreads.map((i) => i.entry.id)).toEqual(["w-dec18"]);
    expect(dec31!.held.map((b) => b.map((p) => p.holding.id))).toEqual([["h-ic"]]);
    expect(dec31!.spreads.map((i) => i.entry.id)).toEqual(["w-dec31"]);
    expect(expiries("spreads").flatMap((g) => g.contracts)).toEqual([]);
  });

  it("puts the lone contracts in Contracts, and no spread", () => {
    expect(expiries("contracts").flatMap((g) => g.contracts.map((i) => i.entry.id))).toEqual(["w-lone"]);
    expect(expiries("contracts").flatMap((g) => g.spreads)).toEqual([]);
  });

  it("puts a holding of one contract in Contracts, a holding of more in Spreads", () => {
    const lone = holding("h-7700", { name: "1231_7700", strike_date: "2026-12-31", legs: [side("short", "CALL", 7700)] });
    const two = placeBook(QUOTES, [...HOLDINGS, lone], MONITORS).sections;
    const [spreads, contracts] = two;
    expect(spreads!.expiries.flatMap((g) => g.held.flat().map((p) => p.holding.id))).toEqual(["h-calls", "h-puts", "h-ic"]);
    expect(contracts!.expiries.flatMap((g) => g.held.flat().map((p) => p.holding.id))).toEqual(["h-7700"]);
  });

  it("omits a section with nothing in it", () => {
    const noLone = QUOTES.filter((q) => q.id !== "w-lone");
    expect(placeBook(noLone, HOLDINGS, MONITORS).sections.map((x) => x.kind)).toEqual(["spreads"]);
  });

  it("lists every expiry block in drawn order as `book`: Spreads' then Contracts'", () => {
    expect(book).toEqual([...expiries("spreads"), ...expiries("contracts")]);
  });

  it("keeps a leg's rule under its watched spread", () => {
    expect(ids(expiries("spreads")[1]!.spreads[0]!.under)).toEqual(["w-dec18-delta"]);
  });

  it("says each expiry's DTE from its first row", () => {
    expect(book.map((g) => g.dte)).toEqual([38, 38, 38, 38]);
  });

  it("is the watchlist alone while the holdings are not valued", () => {
    const b = placeBook(QUOTES, null, MONITORS);
    expect(b.book.flatMap((g) => g.held)).toEqual([]);
    expect(b.sections.map((x) => x.expiries.map((g) => g.expiry)))
      .toEqual([["2026-12-04", "2026-12-18", "2026-12-31"], ["2026-12-31"]]);
  });

  it("is empty with nothing held or watched", () => {
    const empty = placeBook([], [], []);
    expect(empty.book).toEqual([]);
    expect(empty.sections).toEqual([]);
  });
});

describe("a holding's own rule", () => {
  const to = (id: string, name: string) => [{ id, name }];

  it("is the rule linked to it alone over all of it, and comes first among its rules", () => {
    const { book } = placeBook(QUOTES, HOLDINGS, MONITORS);
    const calls = book[1]!.held[0]![0]!;
    expect(ownRule(calls.holding, calls.rules)?.id).toBe("r-calls");
    expect(ownRule(book[2]!.held[0]![0]!.holding, book[2]!.held[0]![0]!.rules)?.id).toBe("r-ic");
  });

  it("is none for a holding with no rule linked to it alone over all of it", () => {
    const { book } = placeBook(QUOTES, HOLDINGS, MONITORS);
    const puts = book[1]!.held[0]![1]!;
    expect(ownRule(puts.holding, puts.rules)).toBeNull();
  });

  it("is first even where a second rule arrived before it", () => {
    const second = entry("r-calls-delta", {
      code: "US.SPXW261218C7300000", strike_date: "2026-12-18", option_type: "CALL", field: "option_delta",
      threshold: 0.3, held: true, scope: "leg", positions: to("h-calls", "1218_C7300"),
      quote: { name: "SPXW 261218 7300.00C", option_delta: 0.33 },
    });
    const { book } = placeBook([second, ...QUOTES], HOLDINGS, MONITORS);
    expect(ids(book[1]!.held[0]![0]!.rules)).toEqual(["r-calls", "r-calls-delta"]);
  });

  it("is the price rule of two rules over all of it, the other a rule under it, whichever came first", () => {
    const calls = QUOTES.find((q) => q.id === "r-calls")!;
    const delta = { ...calls, id: "r-calls-d", code: "1218_C7300", field: "option_delta" };
    for (const quotes of [[delta, ...QUOTES], [...QUOTES, delta]]) {
      const { book } = placeBook(quotes, HOLDINGS, MONITORS);
      const p = book[1]!.held[0]![0]!;
      expect(ownRule(p.holding, p.rules)?.id).toBe("r-calls");
      expect(ids(p.rules)).toEqual(["r-calls", "r-calls-d"]);
    }
  });

  it("is still its own when renamed, and never one that covers another holding too", () => {
    const renamed = QUOTES.map((q) => (q.id === "r-calls" ? { ...q, code: "my stop" } : q));
    const p = placeBook(renamed, HOLDINGS, MONITORS).book[1]!.held[0]![0]!;
    expect(ownRule(p.holding, p.rules)?.id).toBe("r-calls");
    // a condor rule over the condor held as two spreads is linked to both: neither's own
    const condor = entry("r-condor", { code: "1218_IC", strike_date: "2026-12-18", held: true, scope: "all",
      legs: [{ sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
             { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 }] as never,
      positions: [...to("h-calls", "1218_C7300"), ...to("h-puts", "1218_P6400")] });
    const [calls, puts] = placeBook([...QUOTES, condor], HOLDINGS, MONITORS).book[1]!.held[0]!;
    expect(ownRule(calls!.holding, calls!.rules)?.id).toBe("r-calls");
    expect(ownRule(puts!.holding, puts!.rules)).toBeNull();
  });

  it("is the live book's value rule, and the delta on its short leg is not; a lone call's mid rule is its own", () => {
    const { book } = placeBook(OVERLAP_QUOTES, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
    const held = book.flatMap((g) => g.held.flat());
    const h8050 = held.find((p) => p.holding.id === "h-8050")!;
    expect(ownRule(h8050.holding, h8050.rules)?.id).toBe("r-8050");
    expect(ids(h8050.rules)).toEqual(["r-8050", "r-8050-delta"]);
    const h7700 = held.find((p) => p.holding.id === "h-7700")!;
    expect(ownRule(h7700.holding, h7700.rules)?.id).toBe("r-7700");
    // a wing of a held condor watches part of it (scope leg): a rule under it
    const hIc = held.find((p) => p.holding.id === "h-ic")!;
    expect(ownRule(hIc.holding, hIc.rules)).toBeNull();
  });
});

describe("a contract rule on a held leg, as the service serves it", () => {
  // held, linked to the holding with scope leg (`holdsAnyOf`, `adoptOrphanMonitors`)
  const onLeg = entry("r-p6400", {
    code: "US.SPXW261218P6400000", strike_date: "2026-12-18", option_type: "PUT", field: "option_delta",
    threshold: 0.3, held: true, scope: "leg", positions: [{ id: "h-puts", name: "1218_P6400" }],
    quote: { name: "SPXW 261218 6400.00P", option_delta: -0.21 },
  });

  it("sits under its holding", () => {
    const { book } = placeBook([...QUOTES, onLeg], HOLDINGS, MONITORS);
    expect(ids(book[1]!.held[0]![1]!.rules)).toEqual(["r-p6400"]);
    expect(book[1]!.contracts).toEqual([]);
  });

  it("sits under its holding though a watched spread names that leg too", () => {
    const both = { ...onLeg, in_combos: ["w-dec18"] };
    const { book } = placeBook([...QUOTES, both], HOLDINGS, MONITORS);
    expect(ids(book[1]!.held[0]![1]!.rules)).toEqual(["r-p6400"]);
    expect(ids(book[1]!.spreads[0]!.under)).toEqual(["w-dec18-delta"]);
  });

  it("is a rule on held contracts while the holdings are not valued", () => {
    const b = placeBook([...QUOTES, onLeg], null, MONITORS);
    expect(ids(b.unplaced)).toContain("r-p6400");
    expect(b.book.flatMap((g) => g.contracts).map((i) => i.entry.id)).not.toContain("r-p6400");
  });
});

describe("each rule drawn once (2026-11-17)", () => {
  it("draws a leg rule in two watched spreads under the first, and the second says where", () => {
    const other = { ...QUOTES.find((q) => q.id === "w-dec18")!, id: "w-dec18b", code: "1218_P7150b",
      legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7050 }] } as never;
    const leg = QUOTES.map((q) => (q.id === "w-dec18-delta" ? { ...q, in_combos: ["w-dec18", "w-dec18b"] } : q));
    const { book } = placeBook([...leg, other], HOLDINGS, MONITORS);
    const [a, b] = book[1]!.spreads;
    expect(a!.elsewhere).toEqual([]);
    expect(ids(b!.under)).toEqual(["w-dec18-delta"]);
    expect(b!.elsewhere!.map((e) => [e.entry.id, e.in])).toEqual([["w-dec18-delta", "1218_P7150"]]);
  });

  it("draws a condor rule over a condor held as two spreads under the first holding", () => {
    const condor = entry("r-condor", { code: "1218_IC", strike_date: "2026-12-18", held: true, scope: "all",
      legs: [{ sign: -1, option_type: "CALL", strike: 7300 }] as never,
      positions: [{ id: "h-calls", name: "1218_C7300" }, { id: "h-puts", name: "1218_P6400" }] });
    const [calls, puts] = placeBook([...QUOTES, condor], HOLDINGS, MONITORS).book[1]!.held[0]!;
    expect(calls!.elsewhere).toEqual([]);
    expect(ids(calls!.rules)).toContain("r-condor");
    expect(ids(puts!.rules)).toEqual(["r-condor"]);
    expect(puts!.elsewhere!.map((e) => [e.entry.id, e.in])).toEqual([["r-condor", "1218_C7300"]]);
  });
});

describe("the live book's partial overlap (#346)", () => {
  it("draws the combo that shares a contract among the same expiry's watched spreads, keeping what it shares", () => {
    // the note is no longer drawn on its row (2026-11-17), but the inspector and sheet still say it
    const { sections } = placeBook(OVERLAP_QUOTES, OVERLAP_HOLDINGS, OVERLAP_MONITORS);
    expect(sections.map((x) => [x.kind, x.expiries.length])).toEqual([["spreads", 1], ["contracts", 1]]);
    const [g] = sections[0]!.expiries;
    expect(g!.held.flat().map((p) => p.holding.id)).toEqual(["h-8050", "h-ic", "h-7200"]);
    // the lone held call is a contract, though a watched spread contains it
    expect(sections[1]!.expiries[0]!.held.flat().map((p) => p.holding.id)).toEqual(["h-7700"]);
    expect(g!.spreads.map((i) => [i.entry.id, i.overlap])).toEqual([
      ["r-8100", "shares C8100 with 1231_8050"],
      ["w-7700", "contains 1231_7700's C7700"],
      ["r-ratio", "contains 1231_7200's C7200 and C7250"],
    ]);
  });
});
