/** The writes that start from a rule's controls, as a model: renaming a combo and splitting a total
 *  entry across the holdings a rule covers (#336), and "Record as held" (#408), which prefills the add
 *  form from a watch rule — a spread or one contract — so its save replaces that rule. Pure — what
 *  each sends and what it says before sending; `NextRuleWrites.test.tsx` draws them. */
import { describe, expect, it } from "vitest";

import { MonitorPatch, SpreadsIn, TotalEntryIn } from "backend/schemas";
import type { Entry, Holding, Monitor } from "../shared/api";
import {
  contractCode, deltaEnabled, heldFromWatch, replaces, ruleWords, setSpread, spreadsBody, valueDirectionShown,
  valueEnabled, valueShown,
} from "../add";
import { contractBody, contractFromWatch, contractOfCode, contractReplaces, uniqueName } from "../contract";
import {
  draftOf, patchOf, recordOffered, renameNote, ruleOfEntry, ruleOfMonitor, splitOffered, splitPreview, splitCounts,
  spotOf, totalOf,
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

describe("Record as held (#408)", () => {
  const TODAY = "2026-11-10";

  it("reads a contract back from its code, as the service builds it", () => {
    expect(contractOfCode("US.SPXW261231C8000000")).toEqual({ option_type: "CALL", strike: 8000 });
    expect(contractOfCode(contractCode("2026-12-18", "PUT", 7150))).toEqual({ option_type: "PUT", strike: 7150 });
    expect(contractOfCode("1218_P7150")).toBeNull();
  });

  it("is offered on a watch rule — a spread or one contract — that nothing holds, and on nothing else", () => {
    expect(recordOffered(ruleOfEntry(LONE))).toBe(true);
    expect(recordOffered(ruleOfEntry(SPREAD))).toBe(true);
    // a rule on something held, linked to it or not
    expect(recordOffered(ruleOfEntry(HELD))).toBe(false);
    expect(recordOffered(ruleOfEntry({ ...LONE, held: true }))).toBe(false);
    expect(recordOffered({ ...ruleOfEntry(SPREAD), holdings: [{ id: "h", name: "h" }] })).toBe(false);
    // each condition alone: off, with nothing held
    expect(recordOffered({ ...ruleOfEntry(LONE), enabled: false })).toBe(false);
    expect(recordOffered({ ...ruleOfEntry(SPREAD), enabled: false })).toBe(false);
    // from `/monitors`, which does not say whether anything holds it: not guessed
    expect(recordOffered(ruleOfMonitor(MONITORS.find((m) => m.id === LONE.id)!))).toBe(false);
    expect(recordOffered(ruleOfMonitor(MONITORS.find((m) => m.id === "m-muted")!))).toBe(false);
  });

  it("names a contract apart from every holding on record, closed ones too", () => {
    expect(uniqueName("1231_C8000", [])).toBe("1231_C8000");
    expect(uniqueName("1231_C8000", ["1231_C8000"])).toBe("1231_C8000-2");
    expect(uniqueName("1231_C8000", ["1231_C8000", "1231_C8000-2", "x"])).toBe("1231_C8000-3");
  });

  describe("a watched contract", () => {
    it("opens as held, short, with its contract, its derived name and the watch rule as saved", () => {
      expect(contractFromWatch(ruleOfEntry(LONE), TODAY, ["1231_C8000"])).toEqual({
        held: true, rule: true, expiry: "2026-12-31", opened: TODAY, option_type: "CALL", strike: "8000",
        field: "option_delta", direction: "above", compare: "abs", threshold: "0.1", side: "short",
        entry: "", contracts: "1", name: "1231_C8000-2",
      });
      expect(contractFromWatch(ruleOfEntry(SPREAD), TODAY, [])).toBeNull();
    });

    it("carries the rule's own field, direction and compare, whatever they are", () => {
      const rule = { ...ruleOfEntry(LONE), field: "option_theta", direction: "below", compare: "signed", threshold: -0.05 };
      const d = contractFromWatch(rule, TODAY, [])!;
      expect([d.field, d.direction, d.compare, d.threshold]).toEqual(["option_theta", "below", "signed", "-0.05"]);
    });

    it("posts a spread of one leg, held, carrying THIS rule, which the form names as replaced — once the Entry is typed", () => {
      const rule = ruleOfEntry(LONE);
      const monitors: Monitor[] = MONITORS.map((m) => m.id === LONE.id
        ? { ...m, code: LONE.code, option_type: "CALL", strike: 8000, field: LONE.field, threshold: LONE.threshold, positions: [] } : m);
      const d = { ...contractFromWatch(rule, TODAY, [])!, side: "long" as const, entry: "5.2", contracts: "2" };
      expect(contractReplaces(d, monitors)).toEqual(["8000 call |Δ| ≥ 0.10"]);
      const out = contractBody(d, TODAY);
      expect(out).toEqual({
        body: {
          strike_date: "2026-12-31",
          spreads: [{
            name: "1231_C8000", held: true, legs: [{ side: "long", option_type: "CALL", strike: 8000 }],
            entry: -5.2, contracts: 2, opened_at: TODAY,
            monitors: [{ option_type: "CALL", strike: 8000, field: "option_delta", threshold: 0.1,
              direction: "above", compare: "abs" }],
          }],
        },
      });
      expect(SpreadsIn.safeParse((out as { body: unknown }).body).success).toBe(true);
    });

    it("posts what the door scenario's request posts, on the scenario's own world", () => {
      const s = scenario("post-spreads-records-one-contract-held-replacing-the-watch-rule-on-it");
      const book = bookOf(s);
      const sent = s.request.body as {
        strike_date: string;
        spreads: { opened_at: string; entry: number; contracts: number; name: string; monitors: { threshold: number }[] }[];
      };
      const watch = book.monitors.find((m) => m.positions.length === 0 && m.legs === null)!;
      const r = ruleOfMonitor(watch);
      const one = sent.spreads[0]!;
      const d = { ...contractFromWatch(r, one.opened_at, [])!, opened: one.opened_at, entry: String(Math.abs(one.entry)),
        contracts: String(one.contracts), name: one.name, side: (one.entry < 0 ? "long" : "short") as "long" | "short",
        // the one figure that scenario's owner changed: the watch rule's 0.15 held at 0.30
        threshold: String(one.monitors[0]!.threshold) };
      expect(watch.threshold).toBe(0.15);
      expect(contractBody(d, one.opened_at)).toEqual({ body: sent });
    });
  });

  describe("a watched spread", () => {
    /** The 6400/6350 put spread a door scenario watches, as `/monitors` serves it. */
    const WATCHED = {
      code: "dec-puts", strike_date: "2026-12-18",
      legs: [{ sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 }],
    };

    it("opens as held, with its expiry, its legs — each sign a side, each quantity kept — and its name", () => {
      const ratio = { ...WATCHED, legs: [...WATCHED.legs, { sign: -1, option_type: "CALL", strike: 7300, qty: 2 }] };
      const d = heldFromWatch(ratio, TODAY);
      expect([d.held, d.expiry, d.opened, d.spreads.length]).toEqual([true, "2026-12-18", TODAY, 1]);
      const s = d.spreads[0]!;
      expect(s.name).toBe("dec-puts");
      expect(s.legs.map((l) => [l.side, l.option_type, l.strike, l.qty])).toEqual([
        ["short", "PUT", "6400", "1"], ["long", "PUT", "6350", "1"], ["short", "CALL", "7300", "2"],
      ]);
      expect([s.entry, s.contracts]).toEqual(["", "1"]);
    });

    it("saves a credit with a holding's defaults, replacing both watch rules as the backend did on that world", () => {
      const s = scenario("post-spreads-replaces-the-watch-rules-a-held-spread-clashes-with");
      const book = bookOf(s);
      const watch = book.monitors.find((m) => m.legs)!;
      let d = heldFromWatch({ ...watch, legs: watch.legs! }, "2026-11-06");
      d = setSpread(d, d.spreads[0]!.key, { entry: "2.25" });
      const one = d.spreads[0]!;
      expect([valueEnabled(true, one), valueShown(true, one), deltaEnabled(one)]).toEqual([true, "4.50", true]);
      const out = spreadsBody(d) as { body: { strike_date: string; spreads: object[] } };
      const sent = (s.request.body as { spreads: { legs: object[] }[] }).spreads[0]!;
      expect(out.body.strike_date).toBe("2026-12-18");
      expect(out.body.spreads).toEqual([{
        name: "dec-puts", held: true, entry: 2.25, contracts: 1, opened_at: "2026-11-06", legs: sent.legs,
        // the stop at 2× the Entry, posted signed (#343), and the short leg at 0.30
        monitors: [{ threshold: -4.5, direction: "below", compare: "signed" }, { option_type: "PUT", strike: 6400, threshold: 0.3 }],
      }]);
      expect(SpreadsIn.safeParse(out.body).success).toBe(true);
      // named as replaced, the rules the scenario's service deleted
      const removed = s.expect.rows.monitors!.removed!.map((r) => r.id);
      expect(replaces(d, book.monitors)[0]).toEqual(
        book.monitors.filter((m) => removed.includes(m.id)).sort((a, b) => (a.legs ? 1 : 0) - (b.legs ? 1 : 0)).reverse().map(ruleWords));
    });

    it("starts a debit's value rule ON at ≤, empty, refused in words until the stop is typed — and then replaces the watch rule (owner, #408)", () => {
      const s = scenario("post-spreads-replaces-the-watch-rules-a-held-spread-clashes-with");
      const book = bookOf(s);
      const debit = { ...WATCHED, legs: WATCHED.legs.map((l) => ({ ...l, sign: -l.sign })) };
      const monitors = book.monitors.map((m) => (m.legs ? { ...m, legs: debit.legs } : m));
      let d = heldFromWatch(debit, "2026-11-06");
      d = setSpread(d, d.spreads[0]!.key, { entry: "-1.50" });
      const one = d.spreads[0]!;
      expect([valueEnabled(true, one), valueDirectionShown(true, one), valueShown(true, one)]).toEqual([true, "below", ""]);
      expect(spreadsBody(d)).toEqual({ error: "spread 1: type the value its Monitor watches for" });
      // named as replaced, not left to be adopted with its entry signal's threshold
      expect(replaces(d, monitors)[0]).toEqual(["dec-puts |value| ≥ 2.50"]);
      d = setSpread(d, one.key, { valueAt: "0.75" });
      const out = spreadsBody(d) as { body: { spreads: { monitors: object[] }[] } };
      expect(out.body.spreads[0]!.monitors).toEqual([
        { threshold: 0.75, direction: "below" }, { option_type: "PUT", strike: 6350, threshold: 0.3 },
      ]);
    });

    it("leaves a FRESH debit's value rule off, as #405 has it: only the prefill starts it on", () => {
      const d = heldFromWatch(WATCHED, TODAY);
      const fresh = { ...d.spreads[0]!, fromWatch: undefined, entry: "-1.50" };
      expect(valueEnabled(true, fresh)).toBe(false);
    });
  });

  it("names a replaced rule in the one vocabulary every rule is worded in (#404)", () => {
    const lone: Monitor = { ...MONITORS[0]!, legs: null, option_type: "PUT", strike: 7150 };
    const spread: Monitor = { ...lone, legs: [{ sign: -1, option_type: "PUT", strike: 7150 }] };
    const leg = (over: Partial<Monitor>) => ruleWords({ ...lone, ...over });
    expect(leg({ field: "mid_price", threshold: 30, compare: "abs", direction: "above" })).toBe("7150 put |value| ≥ 30.00");
    expect(leg({ field: "option_gamma", threshold: 0.0012, compare: "abs", direction: "above" })).toBe("7150 put |Γ| ≥ 0.0012");
    expect(leg({ field: "option_delta", threshold: -0.1, compare: "signed", direction: "below" })).toBe("7150 put Δ ≤ −0.10");
    const combo = (over: Partial<Monitor>) => ruleWords({ ...spread, code: "1218_P7150", ...over });
    expect(combo({ field: "mid_price", threshold: 1.8, compare: "abs", direction: "above" })).toBe("1218_P7150 |value| ≥ 1.80");
    expect(combo({ field: "mid_price", threshold: -4.5, compare: "signed", direction: "below" })).toBe("1218_P7150 cost to close ≥ 4.50");
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
