/** The add form's draft (#293): what it starts as, what a save posts, and what it refuses before
 *  posting anything. The body is parsed with the route's own schema, `SpreadsIn`, so the form
 *  cannot drift from what `POST /spreads` takes. */
import { describe, expect, it } from "vitest";

import { SpreadsIn } from "backend/schemas";
import {
  addSpread, contractCode, derivedName, flipSide, newDraft, previewOf, replaces, setLeg, spreadsBody,
  stopWarning, valueDefault, valueEnabled, valueHint, type AddDraft,
} from "../next/add";
import type { Monitor } from "../api";

/** The condor the audit timed: two spreads on one expiry, each with its credit. */
function condor(held = true): AddDraft {
  let d = newDraft("2026-11-11");
  d = { ...d, held, expiry: "2026-12-18" };
  d = addSpread(d, "call");
  const [p, c] = d.spreads;
  d = setLeg(d, p!.key, 0, { strike: "7150" });
  d = setLeg(d, p!.key, 1, { strike: "7100" });
  d = setLeg(d, c!.key, 0, { strike: "7700" });
  d = setLeg(d, c!.key, 1, { strike: "7750" });
  return {
    ...d,
    spreads: d.spreads.map((s, i) => ({ ...s, entry: i === 0 ? "1.50" : "1.25" })),
  };
}

const bodyOf = (d: AddDraft) => {
  const out = spreadsBody(d);
  if ("error" in out) throw new Error(out.error);
  return out.body;
};

describe("a new draft", () => {
  it("is one put spread, held, opened on the New York trading day it is given", () => {
    const d = newDraft("2026-11-11");
    expect(d.held).toBe(true);
    expect(d.opened).toBe("2026-11-11");
    expect(d.expiry).toBe("");
    expect(d.spreads).toHaveLength(1);
    expect(d.spreads[0]!.legs.map((l) => [l.side, l.option_type])).toEqual([["short", "PUT"], ["long", "PUT"]]);
    expect([valueEnabled(d.held, d.spreads[0]!), d.spreads[0]!.deltaOn]).toEqual([true, true]);
  });

  it("adds a call spread, and a condor as ONE four-leg holding", () => {
    const d = addSpread(addSpread(newDraft("2026-11-11"), "call"), "condor");
    expect(d.spreads.map((s) => s.legs.map((l) => `${l.side[0]}${l.option_type[0]}`).join(" "))).toEqual([
      "sP lP", "sC lC", "sP lP sC lC",
    ]);
    expect(new Set(d.spreads.map((s) => s.key)).size).toBe(3);
  });
});

describe("the body a save posts", () => {
  it("is the condor as two held spreads with their four Monitors, the expiry said once", () => {
    const body = bodyOf(condor());
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      strike_date: "2026-12-18",
      spreads: [
        {
          name: "1218_P7150_P7100", held: true, entry: 1.5, contracts: 1, opened_at: "2026-11-11",
          legs: [
            { side: "short", option_type: "PUT", strike: 7150 },
            { side: "long", option_type: "PUT", strike: 7100 },
          ],
          // the stop at 2x the Entry, and the short leg's delta at 0.30
          monitors: [{ threshold: 3 }, { option_type: "PUT", strike: 7150, threshold: 0.3 }],
        },
        {
          name: "1218_C7700_C7750", held: true, entry: 1.25, contracts: 1, opened_at: "2026-11-11",
          legs: [
            { side: "short", option_type: "CALL", strike: 7700 },
            { side: "long", option_type: "CALL", strike: 7750 },
          ],
          monitors: [{ threshold: 2.5 }, { option_type: "CALL", strike: 7700, threshold: 0.3 }],
        },
      ],
    });
  });

  it("leaves out a default that was switched off", () => {
    const d = condor();
    const off = { ...d, spreads: d.spreads.map((s, i) => (i === 0 ? { ...s, valueOn: false } : { ...s, deltaOn: false })) };
    const body = bodyOf(off);
    expect(body.spreads.map((s) => s.monitors)).toEqual([
      [{ option_type: "PUT", strike: 7150, threshold: 0.3 }],
      [{ threshold: 2.5 }],
    ]);
  });

  it("takes a threshold typed over the default", () => {
    const d = condor();
    const typed = { ...d, spreads: d.spreads.map((s) => ({ ...s, valueAt: "4", deltaAt: "0.25" })) };
    expect(bodyOf(typed).spreads[0]!.monitors).toEqual([
      { threshold: 4 }, { option_type: "PUT", strike: 7150, threshold: 0.25 },
    ]);
  });

  it("watches a spread at the thresholds typed, and carries no holding's figures", () => {
    const d = condor(false);
    const typed = { ...d, spreads: d.spreads.map((s) => ({ ...s, entry: "", valueAt: "1.8", deltaAt: "0.15" })) };
    const body = bodyOf(typed);
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.spreads[0]).toEqual({
      name: "1218_P7150_P7100", held: false,
      legs: [
        { side: "short", option_type: "PUT", strike: 7150 },
        { side: "long", option_type: "PUT", strike: 7100 },
      ],
      monitors: [{ threshold: 1.8 }, { option_type: "PUT", strike: 7150, threshold: 0.15 }],
    });
  });

  it("gives a delta Monitor to EVERY short leg of a four-leg holding", () => {
    let d = addSpread({ ...newDraft("2026-11-11"), expiry: "2026-12-18", spreads: [] }, "condor");
    const key = d.spreads[0]!.key;
    ["7150", "7100", "7700", "7750"].forEach((k, i) => { d = setLeg(d, key, i, { strike: k }); });
    d = { ...d, spreads: [{ ...d.spreads[0]!, entry: "2.75" }] };
    expect(bodyOf(d).spreads[0]!.monitors).toEqual([
      { threshold: 5.5 },
      { option_type: "PUT", strike: 7150, threshold: 0.3 },
      { option_type: "CALL", strike: 7700, threshold: 0.3 },
    ]);
  });

  it("names a spread by its expiry and strikes unless a name was typed", () => {
    expect(derivedName("2026-12-18", condor().spreads[0]!.legs)).toBe("1218_P7150_P7100");
    const d = condor();
    expect(bodyOf({ ...d, spreads: [{ ...d.spreads[0]!, name: " my put " }] }).spreads[0]!.name).toBe("my put");
  });
});

describe("what it refuses before posting", () => {
  const refused = (d: AddDraft) => {
    const out = spreadsBody(d);
    return "error" in out ? out.error : null;
  };

  it("an expiry not typed", () => {
    expect(refused({ ...condor(), expiry: "" })).toBe("type the expiry");
  });

  it("a strike not typed", () => {
    const d = condor();
    expect(refused(setLeg(d, d.spreads[1]!.key, 1, { strike: "" }))).toBe("spread 2: type every strike");
  });

  it("a held spread's stop with no Entry to double", () => {
    const d = condor();
    expect(refused({ ...d, spreads: [{ ...d.spreads[0]!, entry: "" }] }))
      .toBe("spread 1: type the Entry, or the value its Monitor watches for");
  });

  it("a watched spread's thresholds left blank", () => {
    expect(refused({ ...condor(false), spreads: [{ ...condor(false).spreads[0]!, entry: "" }] }))
      .toBe("spread 1: type the value its Monitor watches for");
  });

  it("a watched spread with every Monitor switched off", () => {
    const d = condor(false);
    expect(refused({ ...d, spreads: [{ ...d.spreads[0]!, valueOn: false, deltaOn: false }] }))
      .toBe("spread 1 is watched and has no Monitor: switch one on");
  });

  it("a count that is not a whole number of contracts", () => {
    const d = condor();
    expect(refused({ ...d, spreads: [{ ...d.spreads[0]!, contracts: "1.5" }] }))
      .toBe("spread 1: contracts is a whole number, 1 or more");
  });
});

describe("the preview", () => {
  it("draws each spread at its Entry, per contract, once every strike is typed", () => {
    const d = condor();
    expect(previewOf(d, d.spreads[0]!)).toEqual({
      legs: [
        { side: "short", option_type: "PUT", strike: 7150 },
        { side: "long", option_type: "PUT", strike: 7100 },
      ],
      entry: 1.5, contracts: 1,
    });
    const blank = setLeg(d, d.spreads[0]!.key, 0, { strike: "" });
    expect(previewOf(blank, blank.spreads[0]!)).toBeNull();
  });

  it("changes when a leg's side is flipped", () => {
    const d = condor();
    const flipped = flipSide(d, d.spreads[0]!.key, 1);
    expect(previewOf(flipped, flipped.spreads[0]!)!.legs[1]!.side).toBe("short");
  });

  it("draws a watched spread at the value it watches for", () => {
    const d = condor(false);
    const s = { ...d.spreads[0]!, valueAt: "1.8" };
    expect(previewOf(d, s)!.entry).toBe(1.8);
  });

  it("doubles the Entry for a held spread's stop, to the cent", () => {
    expect(valueDefault(true, { ...condor().spreads[0]!, entry: "1.333" })).toBe("2.67");
    expect(valueDefault(false, condor().spreads[0]!)).toBe("");
  });
});

describe("a debit spread's stop", () => {
  /** A long put spread, bought for 1.50: its value FALLS when it loses. */
  const debit = () => {
    const d = condor();
    return { ...d, spreads: [{ ...d.spreads[0]!, entry: "-1.50", legs: d.spreads[0]!.legs.map((l) => ({ ...l, side: l.side === "short" ? "long" as const : "short" as const })) }] };
  };

  it("starts switched OFF, with no threshold, because 2x the Entry above would fire on a gain", () => {
    const d = debit();
    expect(valueEnabled(true, d.spreads[0]!)).toBe(false);
    expect(valueDefault(true, d.spreads[0]!)).toBe("");
    expect(valueHint(true, d.spreads[0]!)).toBe("a debit spread's stop is a fall in its value: set one by hand");
    expect(bodyOf(d).spreads[0]!.monitors).toEqual([{ option_type: "PUT", strike: 7100, threshold: 0.3 }]);
  });

  it("can still be switched on by hand, and then wants its threshold typed", () => {
    const d = debit();
    const on = { ...d, spreads: [{ ...d.spreads[0]!, valueOn: true }] };
    expect(valueEnabled(true, on.spreads[0]!)).toBe(true);
    expect(spreadsBody(on)).toEqual({ error: "spread 1: type the value its Monitor watches for" });
  });

  it("keeps a credit spread's on, saying it is the stop", () => {
    expect(valueEnabled(true, condor().spreads[0]!)).toBe(true);
    expect(valueHint(true, condor().spreads[0]!)).toBe("2× the Entry: the stop");
  });
});

describe("a stop that can never fire", () => {
  it("is warned of when 2x the credit is at or past what the spread can cost to close", () => {
    const d = condor();
    const wide = { ...d.spreads[0]!, entry: "1.50" };
    expect(stopWarning(true, wide)).toBeNull();
    const rich = { ...d.spreads[0]!, entry: "25" };
    expect(stopWarning(true, rich)).toBe("the stop at 50.00 can never fire: this spread costs at most 50.00 to close");
    // a condor as one holding costs at most its wider side
    let c = addSpread({ ...newDraft("2026-11-11"), expiry: "2026-12-18", spreads: [] }, "condor");
    ["7150", "7100", "7700", "7800"].forEach((k, i) => { c = setLeg(c, c.spreads[0]!.key, i, { strike: k }); });
    expect(stopWarning(true, { ...c.spreads[0]!, entry: "60" })).toBe(
      "the stop at 120.00 can never fire: this spread costs at most 100.00 to close");
  });

  it("is not warned of for a watched spread, a debit, a stop switched off, or a naked leg", () => {
    const d = condor();
    expect(stopWarning(false, { ...d.spreads[0]!, entry: "25", valueAt: "60" })).toBeNull();
    expect(stopWarning(true, { ...d.spreads[0]!, entry: "25", valueOn: false })).toBeNull();
    expect(stopWarning(true, { ...d.spreads[0]!, entry: "-25" })).toBeNull();
    const naked = { ...d.spreads[1]!, entry: "25", legs: [d.spreads[1]!.legs[0]!] };
    expect(stopWarning(true, naked)).toBeNull();
  });
});

describe("a watched spread's preview, signed by its structure", () => {
  it("draws a credit spread at the value watched for, as a credit", () => {
    const d = condor(false);
    expect(previewOf(d, { ...d.spreads[0]!, valueAt: "1.8" })!.entry).toBe(1.8);
  });

  it("draws a debit spread at the value watched for, as a debit", () => {
    const d = condor(false);
    const s = flipSide(flipSide(d, d.spreads[0]!.key, 0), d.spreads[0]!.key, 1).spreads[0]!;
    expect(previewOf(d, { ...s, valueAt: "1.8" })!.entry).toBe(-1.8);
  });
});

describe("the watch rules a held spread will replace", () => {
  const rule = (over: Partial<Monitor>): Monitor => ({
    id: "m", code: "", strike_date: "2026-12-18", option_type: "PUT", strike: 0, field: "option_delta",
    threshold: 0.15, direction: "above", compare: "abs", legs: null, enabled: true, scope: null, positions: [],
    disabled_reason: null, triggered: false, last_value: null, last_checked_at: null, created_at: null, ...over,
  });
  const value = rule({ id: "v", code: "1218_P7150_P7100", option_type: "CMB", field: "mid_price", threshold: 1.8,
    legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 }] });
  const delta = rule({ id: "d", code: contractCode("2026-12-18", "PUT", 7150), strike: 7150 });

  it("are the Monitors on what it makes that no holding owns, said as the issue words them", () => {
    expect(contractCode("2026-12-18", "PUT", 7150)).toBe("US.SPXW261218P7150000");
    const d = condor();
    expect(replaces(d, [value, delta])).toEqual([
      ["1218_P7150_P7100 value ≥ 1.80", "7150 put |Δ| ≥ 0.15"], [],
    ]);
  });

  it("are none for a rule another holding owns, a default switched off, or a watched spread", () => {
    const d = condor();
    expect(replaces(d, [{ ...value, positions: [{ id: "p", name: "other" }] }, delta])[0]).toEqual(["7150 put |Δ| ≥ 0.15"]);
    expect(replaces({ ...d, spreads: [{ ...d.spreads[0]!, deltaOn: false }] }, [value, delta])[0]).toEqual(["1218_P7150_P7100 value ≥ 1.80"]);
    expect(replaces(condor(false), [value, delta])).toEqual([[], []]);
  });
});

