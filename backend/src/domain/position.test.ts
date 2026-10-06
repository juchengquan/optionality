/** Domain maths for a Position: what it costs to close, what it is exposed to, what it is worth.
 *
 *  Ported from tests/test_position.py (ADR 0009, phase 2 — the tests arrive before the code, so
 *  there is no implementation here for them to be shaped by). Carried as behaviour and
 *  invariants, not as call sequences: where the Python test asserted a rule from CLAUDE.md, the
 *  rule and its reasoning came with it.
 */
import { describe, expect, it } from "vitest";

import { buildSpxCode } from "./contract.ts";
import {
  combinedCostToClose, combinedEntry, combinedPnl, contractSize, costToClose,
  positionGreek, positionLegCodes, positionPnl, positionsHolding,
  type ByCode, type Position,
} from "./position.ts";

const future = () =>
  new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const condor = (entry: number | null = 3.0, contracts = 1): Position => ({
  name: "1016_IC",
  strategy: "iron_condor",
  strike_date: future(),
  contracts,
  entry,
  legs: [
    { side: "sold", option_type: "CALL", strike: 8050 },
    { side: "bought", option_type: "CALL", strike: 8075 },
    { side: "sold", option_type: "PUT", strike: 7100 },
    { side: "bought", option_type: "PUT", strike: 7075 },
  ],
});

/** Map each leg's code to a quote carrying the given mid. */
function quotes(p: Position, mids: number[], extra: Record<string, number> = {}): ByCode {
  const codes = positionLegCodes(p);
  expect(codes.length, "a mid per leg").toBe(mids.length);
  return Object.fromEntries(
    codes.map((code, i) => [code, { code, mid_price: mids[i]!, option_contract_size: 100, ...extra }]),
  );
}

describe("cost to close", () => {
  it("buys back what you sold", () => {
    const p = condor();
    // sold 5.00 and 3.00, bought 2.00 and 1.50
    expect(costToClose(p, quotes(p, [5.0, 2.0, 3.0, 1.5]))).toBe(4.5);
  });

  it("needs every leg", () => {
    const p = condor();
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    delete byCode[positionLegCodes(p)[2]!];
    // no partial sums, ever — the same rule the combo engine already held to
    expect(costToClose(p, byCode)).toBeNull();
  });

  it("matches the magnitude of the signed sum it replaced", () => {
    /* Regression against the live 1016_IC, which read -1.55 as a combo monitor. Its legs
       carried '-' on sold and '+' on bought, so the old signed sum was the NEGATIVE of the
       cost to close. The same quotes must now yield +1.55. */
    const p = condor();
    const mids = [5.0, 2.0, 3.0, 4.45];
    const oldSignedSum = p.legs.reduce(
      (n, leg, i) => n + (leg.side === "sold" ? -1 : 1) * mids[i]!, 0);
    expect(Number(oldSignedSum.toFixed(2))).toBe(-1.55);
    expect(Number(costToClose(p, quotes(p, mids))!.toFixed(2))).toBe(1.55);
  });
});

describe("exposure", () => {
  it("signs are the inverse of the cost-to-close signs", () => {
    // a sold leg costs money to buy back (+) but contributes negative exposure (−)
    const p = condor();
    const byCode = quotes(p, [1.0, 1.0, 1.0, 1.0]);
    positionLegCodes(p).forEach((code, i) => {
      byCode[code]!.option_delta = p.legs[i]!.option_type === "CALL" ? 0.5 : -0.5;
    });

    // cost to close: sold legs add, bought legs subtract → all mids equal → 0
    expect(costToClose(p, byCode)).toBe(0);
    // exposure: bought minus sold. bought(C .5 + P −.5) − sold(C .5 + P −.5) = 0
    expect(positionGreek(p, byCode, "option_delta")).toBe(0);

    // now let the short call dominate, so the two signings cannot coincide by accident
    byCode[positionLegCodes(p)[0]!]!.option_delta = 0.9;
    expect(positionGreek(p, byCode, "option_delta")).toBe(-0.4); // short a 0.9-delta call
  });
});

describe("P&L", () => {
  it("is entry less cost to close, in money", () => {
    const p = condor(3.0, 2);
    // sold for 3.00, costs 4.50 to buy back, 2 contracts, 100 per point
    expect(positionPnl(p, quotes(p, [5.0, 2.0, 3.0, 1.5]))).toBe((3.0 - 4.5) * 2 * 100);
  });

  it("takes the contract size from the quote, not a constant", () => {
    const p = condor();
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    expect(contractSize(byCode)).toBe(100);
    for (const q of Object.values(byCode)) q.option_contract_size = 10;
    expect(contractSize(byCode)).toBe(10);
    expect(positionPnl(p, byCode)).toBe((3.0 - 4.5) * 1 * 10);
  });

  it("is unknown when a leg is missing", () => {
    const p = condor();
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    delete byCode[positionLegCodes(p)[0]!];
    expect(positionPnl(p, byCode)).toBeNull(); // never a half-priced position
  });

  it("is rounded to money precision", () => {
    // 3.21 − 1.60 in binary floating point is 1.6100000000000003
    const p = condor(3.21, 1);
    expect(positionPnl(p, quotes(p, [5.0, 2.0, 3.0, 4.4]))).toBe(161); // not 160.99999999999986
  });

  it("reads a lone option's entry as a credit RECEIVED, so a long is negative", () => {
    // Nothing tested this, and the dashboard's add-monitor form depends on it: a single contract
    // can be either side, and the sign of `entry` is what says which. costToClose is NEGATIVE for
    // a long — closing it pays you — so P&L is entry − (−mid) = entry + mid, and only a negative
    // entry gives the right answer. A long call recorded with a positive entry reports double its
    // debit as profit, silently.
    const lone = (side: "sold" | "bought", entry: number): Position => ({
      name: "lone", strike_date: future(), contracts: 1, entry,
      legs: [{ side, option_type: "CALL", strike: 8100 }],
    });

    // sold for 5.00, now worth 3.00: up 2.00 a point, 100 a point
    const sold = lone("sold", 5.0);
    expect(costToClose(sold, quotes(sold, [3.0]))).toBe(3.0);
    expect(positionPnl(sold, quotes(sold, [3.0]))).toBe(200);

    // bought for 5.00, now worth 8.00: up 3.00. The debit is recorded as a NEGATIVE credit.
    const long = lone("bought", -5.0);
    expect(costToClose(long, quotes(long, [8.0]))).toBe(-8.0);
    expect(positionPnl(long, quotes(long, [8.0]))).toBe(300);

    // and the trap itself, stated so it cannot be reintroduced quietly
    expect(positionPnl(lone("bought", 5.0), quotes(long, [8.0]))).toBe(1300);
  });

  it("is unknown until an entry is recorded", () => {
    const p = condor();
    p.entry = null; // migrated from a combo, which never recorded what was taken in
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    expect(costToClose(p, byCode)).toBe(4.5); // still knows what it costs to close
    expect(positionPnl(p, byCode)).toBeNull(); // but not how that compares to entry
  });
});

describe("scope", () => {
  it("selects a wing of the condor", () => {
    const p = condor();
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    expect(costToClose(p, byCode, "calls")).toBe(3.0); // sold 5.00, bought 2.00
    expect(costToClose(p, byCode, "puts")).toBe(1.5);  // sold 3.00, bought 1.50
    expect(costToClose(p, byCode)).toBe(4.5);          // the wings add up to the whole
  });

  it("narrows exposure too", () => {
    const p = condor();
    const byCode = quotes(p, [1.0, 1.0, 1.0, 1.0]);
    positionLegCodes(p).forEach((code, i) => {
      byCode[code]!.option_delta = p.legs[i]!.option_type === "CALL" ? 0.4 : -0.3;
    });
    byCode[positionLegCodes(p)[0]!]!.option_delta = 0.9;
    expect(positionGreek(p, byCode, "option_delta", "calls")).toBe(-0.5);
    expect(positionGreek(p, byCode, "option_delta", "puts")).toBe(0);
  });

  it("falls back to the whole position when unrecognised", () => {
    const p = condor();
    const byCode = quotes(p, [5.0, 2.0, 3.0, 1.5]);
    expect(costToClose(p, byCode, null)).toBe(4.5);
    expect(costToClose(p, byCode, "all")).toBe(4.5);
  });
});

describe("a stop spanning several positions", () => {
  const callSpread = (entry: number | null = 1.8): Position => ({
    name: "1016_bs_8050", strike_date: future(), contracts: 1, entry,
    legs: [
      { side: "sold", option_type: "CALL", strike: 8050 },
      { side: "bought", option_type: "CALL", strike: 8075 },
    ],
  });
  const putSpread = (entry: number | null = 1.4): Position => ({
    name: "1016_bps_7100", strike_date: future(), contracts: 1, entry,
    legs: [
      { side: "sold", option_type: "PUT", strike: 7100 },
      { side: "bought", option_type: "PUT", strike: 7075 },
    ],
  });
  const bothQuotes = (ps: Position[], mids: number[]): ByCode => {
    const codes = ps.flatMap((p) => positionLegCodes(p));
    return Object.fromEntries(codes.map((code, i) =>
      [code, { code, mid_price: mids[i]!, option_contract_size: 100 }]));
  };

  it("sums across them", () => {
    const call = callSpread(1.8), put = putSpread(1.4);
    // calls: sold 5.00 bought 2.00 → 3.00. puts: sold 3.00 bought 1.50 → 1.50
    const byCode = bothQuotes([call, put], [5.0, 2.0, 3.0, 1.5]);

    expect(combinedCostToClose([call, put], byCode)).toBe(4.5);
    expect(combinedEntry([call, put])).toBeCloseTo(3.2, 10);
    // each wing is down: 1.8−3.0 = −120, 1.4−1.5 = −10
    expect(combinedPnl([call, put], byCode)).toBe(-130);
  });

  it("reports nothing if any part is unknown", () => {
    const call = callSpread(1.8), put = putSpread(null);
    const byCode = bothQuotes([call, put], [5.0, 2.0, 3.0, 1.5]);
    // one wing's credit unrecorded means the total credit is not known, so neither is P&L
    expect(combinedEntry([call, put])).toBeNull();
    expect(combinedPnl([call, put], byCode)).toBeNull();
  });
});

/** These two groups are not ported. They pin facts the Python's own tests never stated, found by
 *  running both implementations over ten thousand generated values and comparing (ADR 0009,
 *  phase 3). The Python goes away in phase 10, so the only place those findings can survive is
 *  here. */
describe("arithmetic that has to match the Python exactly", () => {
  const withEntry = (entry: number): Position => ({
    name: "e", strike_date: future(), contracts: 1, entry,
    legs: [{ side: "sold", option_type: "CALL", strike: 8050 }],
  });

  it("adds across positions the way CPython's sum() does, not left to right", () => {
    // sum([0.1, 0.2, 0.3]) is 0.6 exactly; adding them in order gives 0.6000000000000001.
    // CPython has carried a compensation term here since 3.12, so a plain reduce would show the
    // owner a different total from the one the Python service showed.
    expect(combinedEntry([0.1, 0.2, 0.3].map(withEntry))).toBe(0.6);
  });

  it("rounds money half to even, on the stored value rather than the decimal", () => {
    // Python's round() rounds the actual double and only breaks a genuine tie toward the even
    // digit. 0.005 is held a shade ABOVE a half so it goes up; 0.015 a shade below so it goes
    // down; 0.125 is exact, so the even rule decides it. A contract size of 1 is what makes
    // these reachable — the size comes from the quotes, never assumed to be 100.
    const one = (p: Position): ByCode =>
      Object.fromEntries(positionLegCodes(p).map((c) => [c, { mid_price: 0, option_contract_size: 1 }]));
    const pnlOf = (entry: number) => { const p = withEntry(entry); return positionPnl(p, one(p)); };
    expect(pnlOf(0.005)).toBe(0.01);
    expect(pnlOf(0.015)).toBe(0.01);
    expect(pnlOf(0.125)).toBe(0.12);
    expect(pnlOf(-0.125)).toBe(-0.12);
    expect(pnlOf(2.675)).toBe(2.67);
  });
});

describe("which positions a monitor is watching", () => {
  const spread = (id: string, strikes: [number, number], type: "CALL" | "PUT" = "CALL"): Position & { id: string } => ({
    id, name: id, strike_date: future(), contracts: 1, entry: 1.0,
    legs: [
      { side: "sold", option_type: type, strike: strikes[0] },
      { side: "bought", option_type: type, strike: strikes[1] },
    ],
  });

  it("links a monitor that covers a position exactly, and calls the scope all", () => {
    const p = spread("a", [8050, 8075]);
    const { found, scope } = positionsHolding([p], positionLegCodes(p));
    expect([...found]).toEqual(["a"]);
    expect(scope).toBe("all");
  });

  it("calls it a leg when the monitor watches only part of the structure", () => {
    const p = spread("a", [8050, 8075]);
    const { found, scope } = positionsHolding([p], [positionLegCodes(p)[0]!]);
    expect([...found]).toEqual(["a"]);
    expect(scope).toBe("leg");
  });

  it("spans both spreads of a condor — several positions is not ambiguity", () => {
    // a condor's stop watches all four legs across the two spreads it is made of (ADR 0004)
    const calls = spread("c", [8050, 8075], "CALL");
    const puts = spread("p", [7100, 7075], "PUT");
    const { found, scope } = positionsHolding(
      [calls, puts], [...positionLegCodes(calls), ...positionLegCodes(puts)],
    );
    expect([...found].sort()).toEqual(["c", "p"]);
    expect(scope).toBe("all");
  });

  it("links nothing when no position holds the contract", () => {
    // watching a strike you have no position in is legitimate: it has no entry and no P&L,
    // which is why those read empty rather than zero
    const p = spread("a", [8050, 8075]);
    const { found, scope } = positionsHolding([p], [buildSpxCode(future(), "CALL", 1234)]);
    expect([...found]).toEqual([]);
    expect(scope).toBeNull();
  });

  it("links nothing when a contract is held twice", () => {
    // rolling a spread can leave the old and the new sharing a strike for a day, and the entry
    // is then genuinely ambiguous. A missing figure makes you look; a wrong one does not.
    const a = spread("a", [8050, 8075]);
    const b = spread("b", [8050, 8100]);
    const shared = positionLegCodes(a)[0]!;
    const { found, scope } = positionsHolding([a, b], [shared]);
    expect([...found]).toEqual([]);
    expect(scope).toBeNull();
  });

  it("still links the unambiguous part of a monitor that also names a shared strike", () => {
    // the double-hold rule is about the ambiguous contract, so it refuses the whole link rather
    // than guessing which position the monitor meant
    const a = spread("a", [8050, 8075]);
    const b = spread("b", [8050, 8100]);
    const { found } = positionsHolding([a, b], [positionLegCodes(a)[0]!, positionLegCodes(b)[1]!]);
    expect([...found]).toEqual([]);
  });
});
