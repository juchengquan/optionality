/** The three writes #336 adds to a rule's editor, as a model: renaming a combo, splitting a total
 *  entry across the holdings a rule covers, and recording a holding of a watched contract. Pure —
 *  what each sends and what it says before sending; `NextRuleWrites.test.tsx` draws them. */
import { describe, expect, it } from "vitest";

import { MonitorPatch, SpreadsIn, TotalEntryIn } from "backend/schemas";
import type { Entry, Holding, Monitor } from "../shared/api";
import { contractCode, ruleWords } from "../add";
import {
  contractOfCode, draftOf, holdBody, holdDraft, holdLinks, holdOffered, holdToast, patchOf,
  renameNote, ruleOfEntry, ruleOfMonitor, splitOffered, splitPreview, splitCounts, spotOf, totalOf, uniqueName,
} from "../edit";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { CONDOR, splitBook } from "../testing/ruleEdits";
import { bookOf, scenario } from "../testing/scenarioBook";

const quote = (id: string) => QUOTES.find((q) => q.id === id)!;
const SPREAD = quote("w-dec18");
const LONE = quote("w-lone");
const HELD = quote("r-calls");

describe("renaming a combo", () => {
  it("sends the new name, trimmed, in a body the route takes", () => {
    const rule = ruleOfEntry(SPREAD);
    const out = patchOf(rule, { ...draftOf(rule), name: "  dec-put-spread " });
    expect(out).toEqual({ body: { name: "dec-put-spread" } });
    expect(MonitorPatch.safeParse((out as { body: object }).body).success).toBe(true);
  });

  it("opens on the name as saved, and sends no name when it is unchanged", () => {
    const rule = ruleOfEntry(SPREAD);
    expect(draftOf(rule).name).toBe("1218_P7150");
    expect(patchOf(rule, draftOf(rule))).toEqual({ body: null });
  });

  it("refuses a blank name beside the name, before asking: the route would take one", () => {
    const rule = ruleOfEntry(SPREAD);
    expect(patchOf(rule, { ...draftOf(rule), name: "   " })).toEqual({ error: "type a name", at: "name" });
  });

  it("never sends a name for a single contract, whose code is its contract's", () => {
    const rule = ruleOfEntry(LONE);
    expect(patchOf(rule, { ...draftOf(rule), name: "anything", threshold: "0.2" })).toEqual({ body: { threshold: 0.2 } });
  });

  it("files a name already taken beside the name, and the same words about a field beside the field", () => {
    const rule = ruleOfEntry(SPREAD);
    // the route checks the name first, against the rule's own field: `monitor for (NAME, FIELD)`
    expect(spotOf("monitor for (dec-wing, mid_price) already exists", { name: "dec-wing" }, rule)).toBe("name");
    // a field moved onto a (code, field) taken names the NEW field
    expect(spotOf("monitor for (dec-wing, option_delta) already exists", { name: "dec-wing", field: "option_delta" }, rule))
      .toBe("field");
    expect(spotOf("monitor for (1218_P7150, option_delta) already exists", { field: "option_delta" }, rule)).toBe("field");
    expect(spotOf("only combo monitors can be renamed; a single-leg code is derived from its contract", { name: "x" }, rule))
      .toBe("name");
  });

  it("says that a holding SHARING the name keeps it: the service renames the Monitor alone", () => {
    expect(renameNote(ruleOfEntry(HELD)))
      .toBe("Renames this Monitor only: the holding 1218_C7300 keeps its name — the service never renames a holding.");
    // linked to holdings named otherwise: nothing to say about their names
    expect(renameNote(ruleOfEntry(CONDOR))).toBeNull();
    expect(renameNote(ruleOfEntry(SPREAD))).toBeNull();
  });
});

describe("splitting a total entry", () => {
  const { monitors, holdings } = splitBook();

  it("is offered on a rule covering more than one whole holding, and on no other", () => {
    expect(splitOffered(ruleOfEntry(CONDOR))).toBe(true);
    // one holding: its Entry is the holding's own, edited on the holding
    expect(splitOffered(ruleOfEntry(HELD))).toBe(false);
    expect(splitOffered(ruleOfEntry(SPREAD))).toBe(false);
    // part of a holding: that figure would be a fraction of someone else's credit
    expect(splitOffered(ruleOfEntry({ ...CONDOR, scope: "leg" }))).toBe(false);
    expect(splitOffered(ruleOfMonitor(monitors.find((m) => m.id === CONDOR.id)!))).toBe(true);
  });

  it("takes the total as a signed number, as an Entry is signed", () => {
    expect(totalOf("6.4")).toEqual({ entry: 6.4 });
    expect(totalOf("−1.25")).toEqual({ entry: -1.25 });
    expect(totalOf("-1.25")).toEqual({ entry: -1.25 });
    expect(totalOf(" ")).toEqual({ error: "type the total entry" });
    expect(totalOf("1e2")).toEqual({ error: "the total entry is not a number" });
    expect(TotalEntryIn.safeParse(totalOf("6.4")).success).toBe(true);
  });

  it("shows what each holding gets: the one with no rule of its own takes the rest", () => {
    // 1218_C7300 has its own rule (r-calls, over it alone), so its 2.00 stays; 1218_P6400 has none
    const p = splitPreview(ruleOfEntry(CONDOR), 6.4, monitors, holdings);
    expect(p).toEqual({
      why: null,
      rows: [
        { id: "h-calls", name: "1218_C7300", now: 2, after: 2, derived: false },
        { id: "h-puts", name: "1218_P6400", now: 2, after: 4.4, derived: true },
      ],
    });
  });

  it("rounds the derived Entry as the service does, to four places", () => {
    const p = splitPreview(ruleOfEntry(CONDOR), 2.3, monitors,
      holdings.map((h) => h.id === "h-calls" ? { ...h, entry: 2.1 } : h));
    expect(p.rows.find((r) => r.derived)!.after).toBe(0.2);
  });

  it("says before saving what the service would refuse, in its words", () => {
    const rule = ruleOfEntry(CONDOR);
    // every holding with a rule of its own
    const both = [...monitors, { ...monitors.find((m) => m.id === "r-calls")!, id: "r-puts", code: "1218_P6400",
      positions: [{ id: "h-puts", name: "1218_P6400" }] }];
    expect(splitPreview(rule, 6.4, both, holdings).why)
      .toBe("every wing here has a rule of its own — set them individually");
    // neither has
    const none = monitors.filter((m) => m.id !== "r-calls");
    expect(splitPreview(rule, 6.4, none, holdings).why)
      .toBe("cannot split a total across 2 wings that have no rule of their own");
    // the other wing's own credit is not recorded
    expect(splitPreview(rule, 6.4, monitors, holdings.map((h) => h.id === "h-calls" ? { ...h, entry: null } : h)).why)
      .toBe("set the other wings' credits first");
  });

  it("counts a rule over PART of a holding as no rule of that holding's own, as the service does", () => {
    // a leg rule linked to the put spread alone: scope "leg", so the put spread still has no rule
    // that watches it whole, and it is the one the split writes
    const leg = { ...monitors.find((m) => m.id === "r-calls")!, id: "r-put-leg", code: "US.SPXW261218P6400000",
      legs: null, scope: "leg", positions: [{ id: "h-puts", name: "1218_P6400" }] };
    const p = splitPreview(ruleOfEntry(CONDOR), 6.4, [...monitors, leg], holdings);
    expect(p.why).toBeNull();
    expect(p.rows.find((r) => r.derived)!.id).toBe("h-puts");
  });

  it("is held to the service: the scenario's world, previewed, writes what the backend wrote", () => {
    const s = scenario("post-monitors-id-total-entry-derives-the-one-wing-with-no-rule-of-its-own");
    const book = bookOf(s);
    const total = (s.request.body as { entry: number }).entry;
    const rule = ruleOfMonitor(book.monitors.find((m) => m.id === "mon-condor")!);
    const p = splitPreview(rule, total, book.monitors, book.holdings);
    const written = s.expect.rows.positions!.changed!.map((c) => [c.key.id, c.to.entry]);
    expect(p.rows.filter((r) => r.derived).map((r) => [r.id, r.after])).toEqual(written);
    // and every holding it keeps, the backend left alone
    expect(p.rows.filter((r) => !r.derived).every((r) => r.after === r.now)).toBe(true);
  });

  it("says when the holdings are held in different numbers, the counts hidden under privacy", () => {
    const rule = ruleOfEntry(CONDOR);
    expect(splitCounts(rule, holdings, false)).toBeNull();
    const two = holdings.map((h) => h.id === "h-puts" ? { ...h, contracts: 2 } : h);
    expect(splitCounts(rule, two, false)).toBe(
      "These holdings are held in different numbers (1218_C7300 ×1, 1218_P6400 ×2): the total is per contract, "
      + "and the service adds their Entries as they are, whatever the count.");
    expect(splitCounts(rule, two, true)).toBe(
      "These holdings are held in different numbers: the total is per contract, "
      + "and the service adds their Entries as they are, whatever the count.");
  });

  it("is honest about a holding it has not been told about", () => {
    const p = splitPreview(ruleOfEntry(CONDOR), 6.4, monitors, null);
    expect(p.rows.map((r) => [r.name, r.now, r.after])).toEqual([
      ["1218_C7300", undefined, undefined], ["1218_P6400", undefined, undefined],
    ]);
    expect(p.why).toBeNull();
  });
});

describe("recording a holding of a watched contract", () => {
  const TODAY = "2026-11-10";

  it("reads a contract back from its code, as the service builds it", () => {
    expect(contractOfCode("US.SPXW261231C8000000")).toEqual({ option_type: "CALL", strike: 8000 });
    expect(contractOfCode(contractCode("2026-12-18", "PUT", 7150))).toEqual({ option_type: "PUT", strike: 7150 });
    expect(contractOfCode("1218_P7150")).toBeNull();
  });

  it("is offered on a single contract nothing holds, and on nothing else", () => {
    expect(holdOffered(ruleOfEntry(LONE))).toBe(true);
    // a spread is #293's: re-added as held, it replaces the watch rule
    expect(holdOffered(ruleOfEntry(SPREAD))).toBe(false);
    // already held, by a holding linked or not
    expect(holdOffered(ruleOfEntry({ ...LONE, held: true }))).toBe(false);
    // each condition alone: off, with nothing held; and on, with something held
    expect(holdOffered({ ...ruleOfEntry(LONE), enabled: false })).toBe(false);
    expect(holdOffered({ ...ruleOfEntry(LONE), held: true, enabled: true })).toBe(false);
    // on, from `/monitors`, which does not say whether anything holds it: not guessed
    expect(holdOffered(ruleOfMonitor(MONITORS.find((m) => m.id === LONE.id)!))).toBe(false);
    // `/monitors` does not say whether a contract is held, so it is not guessed
    expect(holdOffered(ruleOfMonitor(MONITORS.find((m) => m.id === "m-muted")!))).toBe(false);
  });

  it("starts on a short, opened today, named as the add form names one contract", () => {
    expect(holdDraft(ruleOfEntry(LONE), TODAY))
      .toEqual({ side: "short", entry: "", contracts: "1", opened: TODAY, name: "1231_C8000" });
  });

  it("posts a spread of one leg, held, carrying THIS rule as it is saved, so the route replaces it", () => {
    const rule = ruleOfEntry(LONE);
    const out = holdBody(rule, { ...holdDraft(rule, TODAY), side: "long", entry: "5.2", contracts: "2" }, TODAY);
    expect(out).toEqual({
      body: {
        strike_date: "2026-12-31",
        spreads: [{
          name: "1231_C8000", held: true, legs: [{ side: "long", option_type: "CALL", strike: 8000 }],
          // paid, so negative: the side signs what moved
          entry: -5.2, contracts: 2, opened_at: TODAY,
          monitors: [{ option_type: "CALL", strike: 8000, field: "option_delta", threshold: 0.1,
            direction: "above", compare: "abs" }],
        }],
      },
    });
    expect(SpreadsIn.safeParse((out as { body: unknown }).body).success).toBe(true);
  });

  it("carries the rule's own direction and compare, whatever they are", () => {
    const rule = { ...ruleOfEntry(LONE), direction: "below", compare: "signed", threshold: -0.05 };
    const out = holdBody(rule, holdDraft(rule, TODAY), TODAY) as { body: { spreads: { monitors: object[] }[] } };
    expect(out.body.spreads[0]!.monitors).toEqual([{ option_type: "CALL", strike: 8000, field: "option_delta",
      threshold: -0.05, direction: "below", compare: "signed" }]);
  });

  it("names it apart from every holding on record, closed ones too", () => {
    expect(uniqueName("1231_C8000", [])).toBe("1231_C8000");
    expect(uniqueName("1231_C8000", ["1231_C8000"])).toBe("1231_C8000-2");
    expect(uniqueName("1231_C8000", ["1231_C8000", "1231_C8000-2", "x"])).toBe("1231_C8000-3");
  });

  it("refuses what the add form refuses, beside the box", () => {
    const rule = ruleOfEntry(LONE);
    const d = holdDraft(rule, TODAY);
    expect(holdBody(rule, { ...d, entry: "-1" }, TODAY))
      .toEqual({ error: "type the Entry as what was received: the side signs it", at: "entry" });
    expect(holdBody(rule, { ...d, contracts: "0" }, TODAY))
      .toEqual({ error: "contracts is a whole number, 1 or more", at: "contracts" });
    expect(holdBody(rule, { ...d, opened: "2026-11-11" }, TODAY))
      .toEqual({ error: "Opened is after today's New York trading day", at: "opened" });
  });

  it("names the watch rule it replaces, in the add form's words", () => {
    const monitors: Monitor[] = MONITORS.map((m) => m.id === LONE.id
      ? { ...m, option_type: "CALL", strike: 8000, field: LONE.field, threshold: LONE.threshold } : m);
    expect(holdLinks(ruleOfEntry(LONE), monitors, null).replaced.map(ruleWords)).toEqual(["8000 call |Δ| ≥ 0.10"]);
  });
});

// the fixture's own shape, checked once, so a test above cannot pass on a fixture that drifted
it("splitBook links the condor to both holdings and r-calls to one", () => {
  const { monitors, holdings }: { monitors: Monitor[]; holdings: Holding[] } = splitBook();
  expect(monitors.find((m) => m.id === CONDOR.id)!.positions.map((p) => p.id)).toEqual(["h-calls", "h-puts"]);
  expect(monitors.find((m) => m.id === "r-calls")!.positions.map((p) => p.id)).toEqual(["h-calls"]);
  expect(holdings).toEqual(HOLDINGS);
  expect((CONDOR as Entry).scope).toBe("all");
});

describe("what recording a holding does to the other rules (#336)", () => {
  const CS = "post-spreads-records-one-contract-held-and-a-watched-spread-holding-it-is-linked-to-it";

  it("names what the service replaces and what it links, as the backend did on the same world", () => {
    const s = scenario(CS);
    const book = bookOf(s);
    const rule = ruleOfMonitor(book.monitors.find((m) => m.id === "mon-c7300")!);
    const links = holdLinks(rule, book.monitors, book.holdings);
    const rows = s.expect.rows;
    expect(links.replaced.map((m) => m.id)).toEqual(rows.monitors!.removed!.map((r) => r.id));
    const made = new Set(rows.monitors!.added!.map((m) => m.id));
    const linked = rows.monitor_positions!.added!.filter((l) => !made.has(l.monitor_id)).map((l) => l.monitor_id);
    expect(links.linked.map((l) => l.monitor.id)).toEqual(linked);
    // and how: the scope the backend wrote on each
    expect(links.linked.map((l) => [l.monitor.id, l.scope]))
      .toEqual(rows.monitors!.changed!.map((c) => [c.key.id, c.to.scope]));
    expect(links.known).toBe(true);
  });

  it("says which of them the page will draw in the Watchlist: a combo not on exactly what is held (#346)", () => {
    const s = scenario(CS);
    const book = bookOf(s);
    const rule = ruleOfMonitor(book.monitors.find((m) => m.id === "mon-c7300")!);
    const links = holdLinks(rule, book.monitors, book.holdings);
    expect(links.linked.length).toBeGreaterThan(0);
    expect(links.linked.map((l) => [l.monitor.id, l.watchlist]))
      .toEqual(links.linked.map((l) => [l.monitor.id, Boolean(l.monitor.legs)]));
    // a combo on exactly the new holding's one contract cannot be: a combo has two legs or more
    expect(links.linked.some((l) => l.watchlist)).toBe(true);
  });

  it("links nothing to it where another holding holds the contract too: the service calls that ambiguous", () => {
    const book = bookOf(scenario(CS));
    const rule = ruleOfMonitor(book.monitors.find((m) => m.id === "mon-c7300")!);
    const other = { ...HOLDINGS[1]!, id: "h-other", strike_date: "2026-12-18",
      legs: [{ side: "long", option_type: "CALL", strike: 7300 }, { side: "short", option_type: "CALL", strike: 7400 }] } as Holding;
    expect(holdLinks(rule, book.monitors, [other]).linked).toEqual([]);
  });

  it("says it cannot know while the holdings are not read", () => {
    const book = bookOf(scenario(CS));
    const rule = ruleOfMonitor(book.monitors.find((m) => m.id === "mon-c7300")!);
    const links = holdLinks(rule, book.monitors, null);
    expect(links.known).toBe(false);
    expect(links.replaced.map((m) => m.id)).toEqual(["mon-c7300"]);
  });

  it("says in the toast what was made, replaced and linked, from the service's answer and its rules after", () => {
    const added = { positions: [{ id: "p1", name: "1218_C7300" }], monitors: [{ id: "m-new", code: "c", field: "option_delta" }],
      replaced: [{ id: "mon-c7300", code: "c", field: "option_delta" }] };
    const after = [
      { ...MONITORS[0]!, id: "m-new", positions: [{ id: "p1", name: "1218_C7300" }] },
      { ...MONITORS[0]!, id: "mon-cs", code: "cs", legs: [{ sign: -1, option_type: "CALL", strike: 7300 }],
        field: "mid_price", positions: [{ id: "p1", name: "1218_C7300" }] },
      { ...MONITORS[0]!, id: "other", positions: [] },
    ] as Monitor[];
    expect(holdToast(added, after)).toBe("recorded 1218_C7300, replacing 1 watch rule; also linked to it: cs spread value");
    expect(holdToast(added, null)).toBe("recorded 1218_C7300, replacing 1 watch rule");
  });
});
