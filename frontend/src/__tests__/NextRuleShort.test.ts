/** A rule in its short form (#388): what the page draws, with the full sentence as its title and
 *  accessible name.
 *
 *  The words are the domain's — `typescript/src/domain/alarm.ts`, which writes the same rule into
 *  every Telegram message — and the page cannot import them (the frontend reaches only the backend,
 *  ADR 0021). So this holds the page's copy to the domain's GOLDEN CASES, case for case: a rewording
 *  on either side fails here until the other follows, as a domain change fails the Python port.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Entry } from "../shared/api";
import { sentence, shortDistance, shortFigure, shortRule, shortSentence, type RuleShape } from "../needs";

const GOLDEN = [".", ".."].map((d) => resolve(process.cwd(), d, "testdata/golden/alarm.json"))
  .find((f) => existsSync(f))!;
const cases = (JSON.parse(readFileSync(GOLDEN, "utf8")) as { cases: { fn: string; name: string; args: unknown[]; expect: unknown }[] }).cases;

describe("the page's short form is the domain's, case for case", () => {
  const ours: Record<string, (...args: never[]) => string> = {
    ruleShort: shortRule, figureShort: shortFigure, distanceShort: shortDistance,
  };
  for (const fn of Object.keys(ours)) {
    it(`has the domain's cases for ${fn}`, () => {
      expect(cases.filter((c) => c.fn === fn).length).toBeGreaterThan(5);
    });
  }
  for (const c of cases.filter((x) => x.fn in ours)) {
    it(`${c.fn}: ${c.name}`, () => {
      expect((ours[c.fn] as (...args: unknown[]) => string)(...c.args)).toBe(c.expect);
    });
  }
});

function entry(over: Record<string, unknown>): Entry {
  return {
    held: false, id: "e1", code: "1218_7150P", strike_date: "2026-12-18", option_type: "CMB",
    field: "mid_price", threshold: 4.51, direction: "above", compare: "abs", triggered: false,
    quote: null, legs: [], combo_value: 2.1, dte: 38, scope: null, positions: [],
    cost_to_close: null, entry: null, pnl: null, fill: 47, schedule: null,
    watched: 2.1, distance: 2.41, in_combos: [],
    ...over,
  } as unknown as Entry;
}
const delta = { legs: undefined, field: "option_delta", threshold: 0.2 };

describe("a rule's short line", () => {
  it("is the rule, the figure and the distance, as the owner's examples write them", () => {
    expect(shortSentence(entry({}))).toBe("|val| ≥ 4.51   2.10  ↑2.41");
    expect(shortSentence(entry({ ...delta, watched: -0.087, distance: 0.113 }))).toBe("|Δ| ≥ 0.20   −0.087  ↑0.113");
    expect(shortSentence(entry({ ...delta, watched: -0.25, distance: -0.05 }))).toBe("|Δ| ≥ 0.20   −0.250  ▲ past 0.050");
  });

  it("points a below rule's arrow down, and marks it past with the down marker", () => {
    expect(shortSentence(entry({ ...delta, direction: "below", watched: 0.3, distance: 0.1 }))).toBe("|Δ| ≤ 0.20   0.300  ↓0.100");
    expect(shortSentence(entry({ ...delta, direction: "below", watched: 0.15, distance: -0.05 }))).toBe("|Δ| ≤ 0.20   0.150  ▼ past 0.050");
  });

  it("says at it compactly", () => {
    expect(shortSentence(entry({ watched: 4.51, distance: 0 }))).toBe("|val| ≥ 4.51   4.51  ▲ at");
  });

  it("bars a magnitude and not a signed figure", () => {
    expect(shortSentence(entry({ ...delta, compare: "signed", watched: 0.1, distance: 0.1 }))).toBe("Δ ≥ 0.20   0.100  ↑0.100");
  });

  it("says a held credit's signed stop as close, and its figure as the cost", () => {
    expect(shortSentence(entry({ threshold: -9.44, direction: "below", compare: "signed", watched: -3.05, distance: 6.39 })))
      .toBe("close ≥ 9.44   3.05  ↑6.39");
  });

  it("draws a dash for no figure, and the last reading in the session with its New York weekday", () => {
    expect(shortSentence(entry({ watched: null, distance: null }))).toBe("|val| ≥ 4.51   —");
    // 05:14:59 Singapore on Saturday is 16:14 New York on Friday
    expect(shortSentence(entry({ threshold: 5.51, watched: null, distance: null,
      last_reading: { value: 3.05, at: "2026-11-14 05:14:59+08:00" } }))).toBe("|val| ≥ 5.51   —  last 3.05 Fri 16:14");
  });

  it("is always narrower than the sentence it stands for", () => {
    for (const e of [entry({}), entry({ ...delta, watched: -0.25, distance: -0.05 }), entry({ watched: null, distance: null })]) {
      expect(shortSentence(e).length).toBeLessThan(sentence(e).length);
    }
  });

  it("writes a draft's typed threshold as typed", () => {
    const r: Omit<RuleShape, "threshold"> = { field: "option_delta", combo: false, compare: "abs", direction: "above" };
    expect(shortRule({ ...r, threshold: "0.2" })).toBe("|Δ| ≥ 0.2");
    expect(shortRule({ ...r, threshold: "…" })).toBe("|Δ| ≥ …");
  });
});
