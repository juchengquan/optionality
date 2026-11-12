/** One contract's draft (#331): what it starts as, what a save posts, and what it refuses before
 *  posting anything. The body is parsed with the route's own schema, `SpreadsIn`: one contract is
 *  saved as a spread of ONE leg through `POST /spreads`, so the form cannot drift from what that
 *  route takes, and what the route then does with it is held by its door scenarios. */
import { describe, expect, it } from "vitest";

import { SpreadsIn } from "backend/schemas";
import {
  CONTRACT_FIELDS, contractBody, contractName, contractNote, contractPreview, contractReplaces,
  contractSaveWords, newContract, refusalSpot, thresholdFault, type ContractDraft,
} from "../next/contract";
import type { Monitor } from "../api";

/** The New York trading day the form is opened on. */
const TODAY = "2026-11-11";

/** A put at 7150 on the 18 December expiry, its delta watched at 0.15. */
function put(over: Partial<ContractDraft> = {}): ContractDraft {
  return { ...newContract(TODAY), expiry: "2026-12-18", strike: "7150", threshold: "0.15", ...over };
}

const bodyOf = (d: ContractDraft) => {
  const out = contractBody(d, TODAY);
  if ("error" in out) throw new Error(out.error);
  expect(SpreadsIn.safeParse(out.body).success).toBe(true);
  return out.body;
};
const refusal = (d: ContractDraft) => contractBody(d, TODAY) as { error: string; at: string };

describe("a new contract draft", () => {
  it("is a put's delta, watched, |x| ≥, with its rule, opened on the New York trading day it is given", () => {
    expect(newContract(TODAY)).toMatchObject({
      held: false, rule: true, option_type: "PUT", field: "option_delta", direction: "above", compare: "abs",
      side: "short", contracts: "1", opened: TODAY, expiry: "", strike: "", threshold: "",
    });
  });

  it("offers the six fields today's form offers, IV among them: one contract is not a sum", () => {
    expect([...CONTRACT_FIELDS]).toEqual([
      "option_delta", "mid_price", "option_implied_volatility", "option_theta", "option_vega", "option_gamma",
    ]);
  });
});

describe("what a watched contract posts", () => {
  it("is a one-leg spread, watched, with the one Monitor naming that leg", () => {
    expect(bodyOf(put())).toEqual({
      strike_date: "2026-12-18",
      spreads: [{
        name: "1218_P7150", held: false, legs: [{ side: "short", option_type: "PUT", strike: 7150 }],
        monitors: [{ option_type: "PUT", strike: 7150, field: "option_delta", threshold: 0.15, direction: "above", compare: "abs" }],
      }],
    });
  });

  it("carries every field, direction and compare as chosen", () => {
    for (const field of CONTRACT_FIELDS) {
      const body = bodyOf(put({ field, direction: "below", compare: "signed", threshold: "-0.4", option_type: "CALL" }));
      expect(body.spreads[0]!.monitors).toEqual([
        { option_type: "CALL", strike: 7150, field, threshold: -0.4, direction: "below", compare: "signed" },
      ]);
    }
  });
});

describe("what a held contract posts", () => {
  it("is a one-leg spread, held, with its figures and its Monitor: a short's Entry received, positive", () => {
    expect(bodyOf(put({ held: true, entry: "2.40", contracts: "3" })).spreads[0]).toEqual({
      name: "1218_P7150", held: true, legs: [{ side: "short", option_type: "PUT", strike: 7150 }],
      entry: 2.4, contracts: 3, opened_at: TODAY,
      monitors: [{ option_type: "PUT", strike: 7150, field: "option_delta", threshold: 0.15, direction: "above", compare: "abs" }],
    });
  });

  it("signs a long's Entry as paid, negative, the way a Position's is", () => {
    expect(bodyOf(put({ held: true, side: "long", entry: "5", option_type: "CALL" })).spreads[0])
      .toMatchObject({ name: "1218_C7150", entry: -5, legs: [{ side: "long", option_type: "CALL", strike: 7150 }] });
  });

  it("keeps a blank Entry blank and a blank Opened null, never a guessed one", () => {
    expect(bodyOf(put({ held: true, entry: "", opened: "" })).spreads[0]).toMatchObject({ entry: null, opened_at: null });
  });

  it("records the holding with no rule when asked, and then needs no threshold", () => {
    expect(bodyOf(put({ held: true, rule: false, threshold: "" })).spreads[0]!.monitors).toEqual([]);
  });

  it("always has its rule when only watched: a watched contract with none would record nothing", () => {
    expect(bodyOf(put({ held: false, rule: false })).spreads[0]!.monitors).toHaveLength(1);
  });

  it("takes a typed name over the derived one", () => {
    expect(bodyOf(put({ held: true, name: " my put " })).spreads[0]!.name).toBe("my put");
  });
});

describe("the name", () => {
  it("is named as a spread is: the expiry's month and day, its type and the strike as a number", () => {
    expect(contractName("2026-12-18", "PUT", 7150)).toBe("1218_P7150");
    for (const typed of ["+7150", "7150.0", "07150", " 7150 "]) {
      expect(bodyOf(put({ strike: typed })).spreads[0]!.name).toBe("1218_P7150");
    }
    expect(bodyOf(put({ strike: "7152.5" })).spreads[0]!.name).toBe("1218_P7152.5");
  });
});

describe("what it refuses before asking the service", () => {
  it("an expiry, a strike and a threshold not typed, each beside its own box", () => {
    expect(refusal(put({ expiry: "" }))).toEqual({ error: "type the expiry", at: "expiry" });
    expect(refusal(put({ strike: "" }))).toEqual({ error: "type the strike", at: "strike" });
    expect(refusal(put({ strike: "-5" }))).toEqual({ error: "type the strike", at: "strike" });
    expect(refusal(put({ threshold: "" }))).toEqual({ error: "type a threshold", at: "threshold" });
    expect(refusal(put({ threshold: "0x10" }))).toEqual({ error: "the threshold is not a number", at: "threshold" });
  });

  it("an expiry already past, though today's own is taken", () => {
    expect(refusal(put({ expiry: "2026-11-10" }))).toEqual({ error: "that expiry has passed", at: "expiry" });
    expect(contractBody(put({ expiry: TODAY }), TODAY)).not.toHaveProperty("error");
  });

  it("an Opened after the expiry, or after today's New York trading day", () => {
    expect(refusal(put({ held: true, expiry: "2026-11-13", opened: "2026-11-14" })))
      .toEqual({ error: "Opened is after the expiry", at: "opened" });
    expect(refusal(put({ held: true, opened: "2026-11-12" })))
      .toEqual({ error: "Opened is after today's New York trading day", at: "opened" });
    expect(contractBody(put({ held: true, opened: "2026-11-02" }), TODAY)).not.toHaveProperty("error");
  });

  it("a signed threshold of exactly 0, and an |x| threshold that is not above 0", () => {
    expect(refusal(put({ compare: "signed", threshold: "0" }))).toEqual({ error: thresholdFault("signed", "0"), at: "threshold" });
    expect(refusal(put({ compare: "abs", threshold: "-0.2" })).error).toBe(thresholdFault("abs", "-0.2"));
    expect(contractBody(put({ compare: "signed", threshold: "-0.2" }), TODAY)).not.toHaveProperty("error");
  });

  it("a held contract's Entry that is not a number, or signed, and a count that is not whole", () => {
    expect(refusal(put({ held: true, entry: "abc" }))).toEqual({ error: "the Entry is not a number", at: "entry" });
    expect(refusal(put({ held: true, entry: "-2" })).at).toBe("entry");
    expect(refusal(put({ held: true, contracts: "1.5" }))).toEqual({ error: "contracts is a whole number, 1 or more", at: "contracts" });
    expect(refusal(put({ held: true, contracts: "0" })).at).toBe("contracts");
  });
});

describe("the threshold's fault, said beside the box as it is typed", () => {
  it("names a signed 0 and an |x| that is not above 0, and nothing else", () => {
    expect(thresholdFault("signed", "0")).toBe("a signed threshold is never exactly 0: use e.g. ±0.01");
    expect(thresholdFault("signed", "-0.00")).toBe("a signed threshold is never exactly 0: use e.g. ±0.01");
    expect(thresholdFault("abs", "0")).toBe("|x| compares the size, so the threshold is above 0");
    expect(thresholdFault("abs", "-1")).toBe("|x| compares the size, so the threshold is above 0");
    expect(thresholdFault("signed", "0.01")).toBeNull();
    expect(thresholdFault("abs", "")).toBeNull();
    expect(thresholdFault("abs", "abc")).toBeNull();
  });
});

describe("where the route's refusal is said", () => {
  it("beside the box it is about, in `POST /spreads`'s own words", () => {
    expect(refusalSpot("position '1218_P7150' already exists")).toBe("name");
    expect(refusalSpot("monitor for (US.SPXW261218P7150000, option_delta) already exists")).toBe("field");
    expect(refusalSpot("signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01")).toBe("threshold");
    expect(refusalSpot("contract does not exist: US.SPXW261218P7150000 — check strike and expiry")).toBe("form");
  });
});

describe("the watch rule a held contract replaces", () => {
  const watching: Monitor = {
    id: "w1", code: "US.SPXW261218P7150000", strike_date: "2026-12-18", option_type: "PUT", strike: 7150,
    field: "option_delta", threshold: 0.15, direction: "above", compare: "abs", legs: null, enabled: true,
    scope: null, positions: [], disabled_reason: null, triggered: false, last_value: null,
    last_checked_at: null, created_at: null,
  };

  it("is named, worded as the spread form words one, when held on the same field", () => {
    expect(contractReplaces(put({ held: true }), [watching])).toEqual(["7150 put |Δ| ≥ 0.15"]);
  });

  it("is nothing when watched, on another field, owned by a holding, or with no rule", () => {
    expect(contractReplaces(put(), [watching])).toEqual([]);
    expect(contractReplaces(put({ held: true, field: "mid_price" }), [watching])).toEqual([]);
    expect(contractReplaces(put({ held: true }), [{ ...watching, positions: [{ id: "p", name: "x" }] }])).toEqual([]);
    expect(contractReplaces(put({ held: true, rule: false }), [watching])).toEqual([]);
  });
});

describe("the payoff preview", () => {
  it("is drawn for a held contract once its strike is typed, per contract, at its signed Entry", () => {
    expect(contractPreview(put({ held: true, side: "long", entry: "5", contracts: "4" }))).toEqual({
      legs: [{ side: "long", option_type: "PUT", strike: 7150 }], entry: -5, contracts: 1,
    });
  });

  it("is not drawn for a watched one, which has no side, nor before the strike", () => {
    expect(contractPreview(put())).toBeNull();
    expect(contractPreview(put({ held: true, strike: "" }))).toBeNull();
  });

  it("says when no Entry is given, rather than claiming a credit of nothing", () => {
    expect(contractNote(put({ held: true, entry: "" }))).toBe("per contract — no Entry given, so drawn at 0");
    expect(contractNote(put({ held: true, entry: "2.4" }))).toBe("per contract, at a credit of 2.40");
    expect(contractNote(put({ held: true, entry: "5", side: "long" }))).toBe("per contract, at a debit of 5.00");
  });
});

describe("the save button's words", () => {
  it("says what a save makes, never a count of contracts", () => {
    expect(contractSaveWords(put())).toBe("Watch it + 1 Monitor");
    expect(contractSaveWords(put({ held: true, contracts: "7" }))).toBe("Record holding + 1 Monitor");
    expect(contractSaveWords(put({ held: true, rule: false }))).toBe("Record holding");
  });
});
