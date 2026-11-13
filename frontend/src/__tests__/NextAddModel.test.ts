/** The add form's draft (#293): what it starts as, what a save posts, and what it refuses before
 *  posting anything. The body is parsed with the route's own schema, `SpreadsIn`, so the form
 *  cannot drift from what `POST /spreads` takes. */
import { describe, expect, it } from "vitest";

import { SpreadsIn } from "backend/schemas";
import {
  addLeg, addSpread, contractCode, deltaEnabled, derivedName, flipSide, MAX_LEGS, MIN_LEGS, newDraft, previewOf,
  removeLeg, replaces, saveWords, setLeg, spreadsBody, stopWarning, valueDefault, valueEnabled, valueHint,
  type AddDraft, type SpreadDraft,
} from "../next/add";
import type { Monitor, Payoff } from "../api";

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

/** A held credit spread's stop as posted: its cost to close at 2x the Entry or more. The value is
 *  signed (minus is short), so that is the value at or BELOW minus 2x the Entry — never its size,
 *  which a spread past its max profit reaches too (review of #343). */
const stop = (t: number) => ({ threshold: -t, direction: "below", compare: "signed" });

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
    expect([valueEnabled(d.held, d.spreads[0]!), deltaEnabled(d.spreads[0]!)]).toEqual([true, true]);
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
          monitors: [stop(3), { option_type: "PUT", strike: 7150, threshold: 0.3 }],
        },
        {
          name: "1218_C7700_C7750", held: true, entry: 1.25, contracts: 1, opened_at: "2026-11-11",
          legs: [
            { side: "short", option_type: "CALL", strike: 7700 },
            { side: "long", option_type: "CALL", strike: 7750 },
          ],
          monitors: [stop(2.5), { option_type: "CALL", strike: 7700, threshold: 0.3 }],
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
      [stop(2.5)],
    ]);
  });

  it("takes a threshold typed over the default", () => {
    const d = condor();
    const typed = { ...d, spreads: d.spreads.map((s) => ({ ...s, valueAt: "4", deltaAt: "0.25" })) };
    expect(bodyOf(typed).spreads[0]!.monitors).toEqual([
      stop(4), { option_type: "PUT", strike: 7150, threshold: 0.25 },
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
      stop(5.5),
      { option_type: "PUT", strike: 7150, threshold: 0.3 },
      { option_type: "CALL", strike: 7700, threshold: 0.3 },
    ]);
  });

  it("posts a held credit's stop as its cost to close, so it never rings at max profit", () => {
    // the review's demo: an iron condor taken in for 5.50, whose value reaches +30 past its call
    // side — the size of which, compared abs, rang the old ">= 11" stop at max profit
    let d = addSpread({ ...newDraft("2026-11-11"), expiry: "2026-12-18", spreads: [] }, "condor");
    const key = d.spreads[0]!.key;
    ["7000", "6990", "7230", "7200"].forEach((k, i) => { d = setLeg(d, key, i, { strike: k }); });
    d = { ...d, spreads: [{ ...d.spreads[0]!, entry: "5.50" }] };
    const body = bodyOf(d);
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.spreads[0]!.monitors[0]).toEqual({ threshold: -11, direction: "below", compare: "signed" });
  });

  it("keeps a watched spread's value rule as the size typed, and a debit's typed by hand as given", () => {
    expect(bodyOf({ ...condor(false), spreads: [{ ...condor(false).spreads[0]!, valueAt: "1.8", deltaOn: false }] })
      .spreads[0]!.monitors).toEqual([{ threshold: 1.8 }]);
    const d = condor();
    const debit = { ...d, spreads: [{ ...d.spreads[0]!, entry: "-1.50", valueOn: true, valueAt: "0.5", deltaOn: false }] };
    expect(bodyOf(debit).spreads[0]!.monitors).toEqual([{ threshold: 0.5 }]);
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
  /** What `POST /positions/payoff` answers for the spread's preview: the most it can cost to close
   *  is its Entry less its max loss, which is all the warning reads (`payoffAtExpiry`'s figure). */
  const drawn = (d: AddDraft, s: SpreadDraft, maxLoss: number | null) => ({
    key: JSON.stringify(previewOf(d, s)),
    payoff: { at_strikes: [], slope_below: 0, slope_above: 0, breakevens: [], max_profit: null, max_loss: maxLoss } as Payoff,
  });
  const at = (d: AddDraft, s: SpreadDraft, maxLoss: number | null) => stopWarning(d, s, drawn(d, s, maxLoss));

  it("is warned of when 2x the credit is at or past what the served payoff says it can cost to close", () => {
    const d = condor();
    const wide = { ...d.spreads[0]!, entry: "1.50" };
    expect(at(d, wide, -48.5)).toBeNull();
    const rich = { ...d.spreads[0]!, entry: "25" };
    expect(at(d, rich, -25)).toBe("the stop at 50.00 can never fire: this spread costs at most 50.00 to close");
    // a condor as one holding costs at most its wider side: whatever the payoff route says it is
    let c = addSpread({ ...newDraft("2026-11-11"), expiry: "2026-12-18", spreads: [] }, "condor");
    ["7150", "7100", "7700", "7800"].forEach((k, i) => { c = setLeg(c, c.spreads[0]!.key, i, { strike: k }); });
    const s = { ...c.spreads[0]!, entry: "60" };
    expect(at(c, s, -40)).toBe("the stop at 120.00 can never fire: this spread costs at most 100.00 to close");
  });

  it("reads any number of legs from the served figure, not from the legs (#334)", () => {
    const d = sixLegs();
    const s = { ...d.spreads[0]!, entry: "30" };
    // six legs whose worst case is 75 to close: 2x30 = 60 can fire, and a richer 40 cannot
    expect(at(d, s, -45)).toBeNull();
    const rich = { ...s, entry: "40" };
    expect(at(d, rich, -35)).toBe("the stop at 80.00 can never fire: this spread costs at most 75.00 to close");
  });

  it("is not warned of before the payoff is served, or from a curve drawn for other legs", () => {
    const d = condor();
    const rich = { ...d.spreads[0]!, entry: "25" };
    expect(stopWarning(d, rich, null)).toBeNull();
    // a payoff served for other legs, whose figure WOULD warn were it this draft's
    const narrow = { ...rich, legs: [rich.legs[0]!, { ...rich.legs[1]!, strike: "7140" }] };
    const stale = drawn(d, narrow, -15);
    expect(stopWarning(d, narrow, stale)).toBe("the stop at 50.00 can never fire: this spread costs at most 40.00 to close");
    expect(stopWarning(d, rich, stale)).toBeNull();
  });

  it("is not warned of for a watched spread, a debit, a stop switched off, or no floor", () => {
    const d = condor();
    const w = condor(false);
    expect(at(w, { ...w.spreads[0]!, valueAt: "60" }, -10)).toBeNull();
    expect(at(d, { ...d.spreads[0]!, entry: "25", valueOn: false }, -25)).toBeNull();
    expect(at(d, { ...d.spreads[0]!, entry: "-25" }, -25)).toBeNull();
    expect(at(d, { ...d.spreads[1]!, entry: "25", legs: [d.spreads[1]!.legs[0]!] }, null)).toBeNull();
  });
});

/** A six-leg spread on one expiry: the condor with a further wing bought on each side. */
function sixLegs(): AddDraft {
  let d = addSpread({ ...newDraft("2026-11-11"), expiry: "2026-12-18", spreads: [] }, "condor");
  const key = d.spreads[0]!.key;
  d = addLeg(addLeg(d, key), key);
  ["7150", "7100", "7700", "7750", "7050", "7800"].forEach((k, i) => { d = setLeg(d, key, i, { strike: k }); });
  return setLeg(d, key, 4, { option_type: "PUT" });
}

describe("legs added and removed (#334)", () => {
  it("adds a leg up to six, each a long of the last leg's type until changed", () => {
    let d = { ...newDraft("2026-11-11"), expiry: "2026-12-18" };
    const key = d.spreads[0]!.key;
    expect([MIN_LEGS, MAX_LEGS]).toEqual([2, 6]);
    for (let n = 3; n <= 6; n++) {
      d = addLeg(d, key);
      expect(d.spreads[0]!.legs).toHaveLength(n);
    }
    expect(d.spreads[0]!.legs.slice(2).map(({ key: _, ...l }) => l))
      .toEqual(Array(4).fill({ side: "long", option_type: "PUT", strike: "" }));
    // each leg its own key, kept when legs around it come and go, so the form's focus follows it
    const keys = d.spreads[0]!.legs.map((l) => l.key);
    expect(new Set(keys).size).toBe(6);
    expect(removeLeg(d, key, 1).spreads[0]!.legs.map((l) => l.key)).toEqual(keys.filter((_, i) => i !== 1));
    expect(addLeg(d, key)).toBe(d);
  });

  it("removes any leg down to two, keeping the others in their order", () => {
    const d = sixLegs();
    const key = d.spreads[0]!.key;
    const less = removeLeg(d, key, 1);
    expect(less.spreads[0]!.legs.map((l) => `${l.side[0]}${l.option_type[0]}${l.strike}`))
      .toEqual(["sP7150", "sC7700", "lC7750", "lP7050", "lC7800"]);
    let two = d;
    while (two.spreads[0]!.legs.length > 2) two = removeLeg(two, key, 0);
    expect(removeLeg(two, key, 0)).toBe(two);
  });

  for (const n of [3, 5, 6]) {
    it(`posts a ${n}-leg spread the route accepts, each leg its own side, type and strike`, () => {
      let d = sixLegs();
      const key = d.spreads[0]!.key;
      while (d.spreads[0]!.legs.length > n) d = removeLeg(d, key, d.spreads[0]!.legs.length - 1);
      d = { ...d, spreads: [{ ...d.spreads[0]!, entry: "3" }] };
      const body = bodyOf(d);
      expect(SpreadsIn.safeParse(body).success).toBe(true);
      expect(body.spreads[0]!.legs).toEqual(d.spreads[0]!.legs.map(({ key: _, ...l }) => ({ ...l, strike: Number(l.strike) })));
      // the value, and a delta Monitor on EACH short leg
      const shorts = d.spreads[0]!.legs.filter((l) => l.side === "short");
      expect(body.spreads[0]!.monitors).toEqual([
        stop(6), ...shorts.map((l) => ({ option_type: l.option_type, strike: Number(l.strike), threshold: 0.3 })),
      ]);
    });
  }

  it("names two legs as before, and three to six compactly: each type's lowest and highest strike", () => {
    const d = sixLegs();
    const legs = d.spreads[0]!.legs;
    const name = (n: number) => derivedName("2026-12-18", legs.slice(0, n));
    expect(derivedName("2026-12-18", [legs[0]!])).toBe("1218_P7150");
    expect(name(2)).toBe("1218_P7150_P7100");
    expect(name(3)).toBe("1218_P7100-7150_C7700");
    expect(name(4)).toBe("1218_P7100-7150_C7700-7750");
    expect(name(5)).toBe("1218_P7050-7150_C7700-7750");
    expect(name(6)).toBe("1218_P7050-7150_C7700-7800");
    // short enough that a bot table widens by ten characters over a two-leg name, not twenty-four
    for (let n = 3; n <= 6; n++) expect(name(n).length).toBeLessThanOrEqual(26);
    // one type only, and a strike not yet typed
    expect(derivedName("2026-12-18", legs.filter((l) => l.option_type === "PUT"))).toBe("1218_P7050-7150");
    expect(derivedName("", [...legs.slice(0, 2), { ...legs[2]!, strike: "" }])).toBe("spread_P7100-7150_C");
  });

  it("draws the preview of every leg, however many", () => {
    const d = sixLegs();
    expect(previewOf(d, d.spreads[0]!)!.legs).toHaveLength(6);
  });
});

describe("a structure with no short leg", () => {
  /** Two long puts and a long call: nothing sold, so no short leg's delta to watch. */
  const allLong = (): AddDraft => {
    let d = sixLegs();
    const key = d.spreads[0]!.key;
    d = removeLeg(removeLeg(removeLeg(d, key, 5), key, 3), key, 2);
    d = flipSide(d, key, 0);
    return { ...d, spreads: [{ ...d.spreads[0]!, entry: "-4" }] };
  };

  it("gets no |Δ| Monitor by default, and saves without one rather than being refused", () => {
    const d = allLong();
    expect(d.spreads[0]!.legs.every((l) => l.side === "long")).toBe(true);
    expect(deltaEnabled(d.spreads[0]!)).toBe(false);
    expect(spreadsBody(d)).not.toHaveProperty("error");
    expect(bodyOf(d).spreads[0]!.monitors).toEqual([]);
    expect(saveWords(d)).toBe("Record holding + 0 Monitors");
  });

  it("gets one again once a leg is made short, and keeps a switch the owner set", () => {
    const d = allLong();
    const key = d.spreads[0]!.key;
    expect(deltaEnabled(flipSide(d, key, 0).spreads[0]!)).toBe(true);
    const on = { ...d, spreads: [{ ...d.spreads[0]!, deltaOn: true }] };
    expect(spreadsBody(on)).toEqual({ error: "spread 1 has no short leg to watch the delta of: switch that Monitor off" });
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

  it("say a signed stop as the cost to close it watches, not as a negative value", () => {
    const signed = { ...value, threshold: -11, direction: "below" as const, compare: "signed" as const };
    expect(replaces(condor(), [signed])[0]).toEqual(["1218_P7150_P7100 cost to close ≥ 11.00"]);
  });

  it("are none for a rule another holding owns, a default switched off, or a watched spread", () => {
    const d = condor();
    expect(replaces(d, [{ ...value, positions: [{ id: "p", name: "other" }] }, delta])[0]).toEqual(["7150 put |Δ| ≥ 0.15"]);
    expect(replaces({ ...d, spreads: [{ ...d.spreads[0]!, deltaOn: false }] }, [value, delta])[0]).toEqual(["1218_P7150_P7100 value ≥ 1.80"]);
    expect(replaces(condor(false), [value, delta])).toEqual([[], []]);
  });
});

