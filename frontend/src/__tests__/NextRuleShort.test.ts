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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../shared/api";
import {
  fieldWords, sentence, shortDistance, shortFigure, shortRule, shortSentence, storedRuleWords, type RuleShape,
} from "../needs";

afterEach(() => { vi.useRealTimers(); });

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

/** One vocabulary (#404): the full sentence — the picture, the copied text, every hover title and
 *  accessible name — words a rule with the short form's words, so it is held to the same golden
 *  cases. The one difference is a held credit's stop, which the sentence says in full. */
describe("the full sentence words a rule as the short form does (#404)", () => {
  const shorts = cases.filter((c) => c.fn === "ruleShort");
  const fields = ["mid_price", "option_delta", "option_gamma", "option_theta", "option_vega", "option_implied_volatility"];

  it("has the domain's cases for a price and a delta, on a spread and on a contract", () => {
    const has = (field: string, combo: boolean) =>
      shorts.some((c) => (c.args[0] as RuleShape).field === field && (c.args[0] as RuleShape).combo === combo);
    for (const field of ["mid_price", "option_delta"]) for (const combo of [true, false]) expect(has(field, combo)).toBe(true);
  });

  for (const c of shorts) {
    it(`${c.name}`, () => {
      const r = c.args[0] as RuleShape;
      const words = storedRuleWords(r.field, r.combo, r.compare, r.direction, r.threshold);
      expect(words.replace(/^cost to close ≥/, "close ≥")).toBe(c.expect);
    });
  }

  it("names each field as the domain's short form does, a price as value and the Greeks as letters", () => {
    expect(fields.map((f) => [fieldWords(f), fieldWords(f, true)]))
      .toEqual([["value", "value"], ["Δ", "Δ"], ["Γ", "Γ"], ["Θ", "Θ"], ["ν", "ν"], ["IV", "IV"]]);
  });

  it("writes the issue's sentences, with a real minus and the short form's places", () => {
    expect(sentence(entry({ threshold: 5.51, watched: null, distance: null }))).toBe("|value| ≥ 5.51 — no figure");
    expect(sentence(entry({ ...delta, watched: -0.087, distance: 0.113 }))).toBe("|Δ| ≥ 0.20 — now \u22120.087, 0.113 away");
    expect(sentence(entry({ legs: undefined, threshold: 30, watched: 26.41, distance: 3.59 })))
      .toBe("|value| ≥ 30.00 — now 26.41, 3.59 away");
    expect(sentence(entry({ ...delta, compare: "signed", direction: "below", threshold: -0.1, watched: -0.05, distance: 0.05 })))
      .toBe("Δ ≤ \u22120.10 — now \u22120.050, 0.050 away");
  });

  it("says a held credit's stop as the cost to close, and never as a negative value", () => {
    const stop = { threshold: -9.44, direction: "below", compare: "signed" };
    expect(sentence(entry({ ...stop, watched: -3.05, distance: 6.39 }))).toBe("cost to close ≥ 9.44 — now 3.05, 6.39 away");
    expect(storedRuleWords("mid_price", true, "signed", "below", -4.5)).toBe("cost to close ≥ 4.50");
  });

  it("writes no ASCII minus anywhere in a sentence", () => {
    const e = entry({ ...delta, compare: "signed", direction: "below", threshold: -0.1, watched: -0.25, distance: -0.15 });
    expect(sentence(e)).not.toMatch(/-/);
  });
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
    expect(shortSentence(entry({}))).toBe("|value| ≥ 4.51   2.10  ↑2.41");
    expect(shortSentence(entry({ ...delta, watched: -0.087, distance: 0.113 }))).toBe("|Δ| ≥ 0.20   −0.087  ↑0.113");
    expect(shortSentence(entry({ ...delta, watched: -0.25, distance: -0.05 }))).toBe("|Δ| ≥ 0.20   −0.250  ▲ past 0.050");
  });

  it("points a below rule's arrow down, and marks it past with the down marker", () => {
    expect(shortSentence(entry({ ...delta, direction: "below", watched: 0.3, distance: 0.1 }))).toBe("|Δ| ≤ 0.20   0.300  ↓0.100");
    expect(shortSentence(entry({ ...delta, direction: "below", watched: 0.15, distance: -0.05 }))).toBe("|Δ| ≤ 0.20   0.150  ▼ past 0.050");
  });

  it("says at it compactly", () => {
    expect(shortSentence(entry({ watched: 4.51, distance: 0 }))).toBe("|value| ≥ 4.51   4.51  ▲ at");
  });

  it("bars a magnitude and not a signed figure", () => {
    expect(shortSentence(entry({ ...delta, compare: "signed", watched: 0.1, distance: 0.1 }))).toBe("Δ ≥ 0.20   0.100  ↑0.100");
  });

  it("says a held credit's signed stop as close, and its figure as the cost", () => {
    expect(shortSentence(entry({ threshold: -9.44, direction: "below", compare: "signed", watched: -3.05, distance: 6.39 })))
      .toBe("close ≥ 9.44   3.05  ↑6.39");
  });

  it("draws a dash for no figure, and the last reading in the session with its New York weekday", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // Sunday 12:00 New York
    expect(shortSentence(entry({ watched: null, distance: null }))).toBe("|value| ≥ 4.51   —");
    // 05:14:59 Singapore on Saturday is 16:14 New York on Friday
    expect(shortSentence(entry({ threshold: 5.51, watched: null, distance: null,
      last_reading: { value: 3.05, at: "2026-11-14 05:14:59+08:00" } }))).toBe("|value| ≥ 5.51   —  last 3.05 Fri 16:14 ET");
  });

  it("dates a last reading older than six days, where a weekday would name the wrong week (#400)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));
    // Friday 6 Nov 16:14 New York, nine days before
    expect(shortSentence(entry({ threshold: 5.51, watched: null, distance: null,
      last_reading: { value: 3.05, at: "2026-11-07 05:14:59+08:00" } }))).toBe("|value| ≥ 5.51   —  last 3.05 Fri 6 Nov 16:14 ET");
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
