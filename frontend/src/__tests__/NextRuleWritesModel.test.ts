/** The three writes #336 adds to a rule's editor, as a model: renaming a combo, splitting a total
 *  entry across the holdings a rule covers, and recording a holding of a watched contract. Pure —
 *  what each sends and what it says before sending; `NextRuleWrites.test.tsx` draws them. */
import { describe, expect, it } from "vitest";

import { MonitorPatch, SpreadsIn, TotalEntryIn } from "backend/schemas";
import type { Entry, Holding, Monitor } from "../api";
import { contractCode } from "../next/add";
import {
  contractOfCode, draftOf, holdBody, holdDraft, holdOffered, holdReplaces, patchOf, renameNote,
  ruleOfEntry, ruleOfMonitor, splitOffered, splitPreview, spotOf, totalOf,
} from "../next/edit";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { CONDOR, splitBook } from "../testing/ruleEdits";

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

  it("says that a holding keeps its own name: the service renames the Monitor alone", () => {
    expect(renameNote(ruleOfEntry(HELD)))
      .toBe("Renames this Monitor only: the holding 1218_C7300 keeps its name — the service never renames a holding.");
    expect(renameNote(ruleOfEntry(CONDOR)))
      .toBe("Renames this Monitor only: the holdings 1218_C7300 and 1218_P6400 keep their names — the service never renames a holding.");
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
    expect(holdReplaces(ruleOfEntry(LONE), monitors)).toEqual(["8000 call |Δ| ≥ 0.10"]);
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
