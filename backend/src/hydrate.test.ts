/** `hydrate.ts`: a stored row into the shapes the domain works in, and REFUSED when it is not one.
 *
 *  Refused rather than cast (#266): a cast handed a leg with no sign to the maths, which swept it
 *  with a NaN where the sign should be, while the Python port's models refused the same row and
 *  quarantined it — two backends acting differently on one database file, with every gate green.
 *  What is refused is what the domain's TYPES say and nothing more; each refusal names the row and
 *  the field, in words the Python's `hydrate.py` repeats exactly. The callers' guards turn a refusal
 *  into the quarantine of one rule, or the gap of one holding (`engine/sweeper.ts`).
 */
import { describe, expect, it } from "vitest";

import type { MonitorRow, PositionRow } from "./db/rows.ts";
import { toMonitor, toPosition } from "./hydrate.ts";

const COMBO_LEGS = [
  { sign: 1, option_type: "CALL", strike: 8100 },
  { sign: -1, option_type: "CALL", strike: 8150 },
];
const HELD_LEGS = [
  { side: "short", option_type: "CALL", strike: 8100 },
  { side: "long", option_type: "CALL", strike: 8150 },
];

function storedMonitor(over: Record<string, unknown> = {}): MonitorRow {
  return {
    id: "mon-1", code: "dec-wing", strike_date: "2026-12-18", option_type: "CMB", strike: 0,
    field: "mid_price", threshold: 9.5, direction: "below", compare: "signed",
    legs: JSON.stringify(COMBO_LEGS), scope: "all", enabled: 1, disabled_reason: null, triggered: 0,
    last_value: null, last_checked_at: null, last_alarm_at: null,
    created_at: "2026-11-08 00:00:00.000000",
    ...over,
  } as unknown as MonitorRow;
}

function storedPosition(over: Record<string, unknown> = {}): PositionRow {
  return {
    id: "pos-1", name: "dec-condor", strategy: "iron_condor", strike_date: "2026-12-18",
    contracts: 2, entry: 6.4, legs: JSON.stringify(HELD_LEGS),
    created_at: "2026-11-08 00:00:00.000000", opened_at: "2026-10-12", manage_notified_at: null,
    closed_on: null, exit: null,
    ...over,
  } as unknown as PositionRow;
}

const BLOB = new Uint8Array([1, 2]);

describe("a monitor", () => {
  it("reaches the domain with its legs parsed, and nothing the domain does not hold", () => {
    const legs = [{ ...COMBO_LEGS[0], note: "mine" }, COMBO_LEGS[1]];
    expect(toMonitor(storedMonitor({ legs: JSON.stringify(legs) }))).toStrictEqual({
      id: "mon-1", code: "dec-wing", strike_date: "2026-12-18", option_type: "CMB", strike: 0,
      field: "mid_price", threshold: 9.5, direction: "below", compare: "signed", legs: COMBO_LEGS,
    });
  });

  it("with no legs stored, or an empty list, is a single-leg rule", () => {
    expect(toMonitor(storedMonitor({ legs: null })).legs).toBeNull();
    expect(toMonitor(storedMonitor({ legs: "null" })).legs).toBeNull();
    expect(toMonitor(storedMonitor({ legs: "[]" })).legs).toEqual([]);
  });

  it("reads a sign written as 1.0 as the 1 it is", () => {
    const legs = '[{"sign":1.0,"option_type":"CALL","strike":8100},{"sign":-1.0,"option_type":"PUT","strike":6400.5}]';
    expect(toMonitor(storedMonitor({ legs })).legs).toEqual([
      { sign: 1, option_type: "CALL", strike: 8100 },
      { sign: -1, option_type: "PUT", strike: 6400.5 },
    ]);
  });

  it("whose legs are not JSON cannot be read, in words of its own and with the parser's as the cause", () => {
    // V8's words would be the TypeScript's alone, and /positions/values answers with them
    let thrown: unknown;
    try {
      toMonitor(storedMonitor({ legs: "{not json" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual(new Error("monitor dec-wing cannot be read: legs must be JSON"));
    expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it.each([
    ["legs that are empty text", { legs: "" }, "legs must be JSON"],
    ["legs with a NaN in them", { legs: '[{"sign":1,"option_type":"CALL","strike":NaN}]' },
      "legs must be JSON"],
    // the column's affinity is NUMERIC, so a number is what SQLite hands back for legs of '5'
    ["legs stored as a number", { legs: 5 }, "legs must be a list"],
    ["legs stored as an infinite number", { legs: Infinity }, "legs must be JSON"],
    ["legs stored as bytes", { legs: BLOB }, "legs must be JSON"],
    ["legs stored as one byte, which String() would make JSON of", { legs: new Uint8Array([5]) },
      "legs must be JSON"],
    ["legs stored as bytes that are JSON", { legs: new TextEncoder().encode("[]") },
      "legs must be JSON"],
    ["a leg with no sign", { legs: '[{"option_type":"CALL","strike":8100}]' },
      "legs[0].sign must be 1 or -1"],
    ["a sign in quotes", { legs: '[{"sign":1,"option_type":"CALL","strike":8100},{"sign":"-1","option_type":"CALL","strike":8150}]' },
      "legs[1].sign must be 1 or -1"],
    ["a sign of true", { legs: '[{"sign":true,"option_type":"CALL","strike":8100}]' },
      "legs[0].sign must be 1 or -1"],
    ["a sign of 2", { legs: '[{"sign":2,"option_type":"CALL","strike":8100}]' },
      "legs[0].sign must be 1 or -1"],
    ["a lower-case type", { legs: '[{"sign":1,"option_type":"call","strike":8100}]' },
      'legs[0].option_type must be "CALL" or "PUT"'],
    ["a strike in quotes", { legs: '[{"sign":1,"option_type":"CALL","strike":"8100"}]' },
      "legs[0].strike must be a number"],
    ["a leg that is no object", { legs: "[null]" }, "legs[0] must be an object"],
    ["a leg that is a list", { legs: "[[1,\"CALL\",8100]]" }, "legs[0] must be an object"],
    ["legs that are no list", { legs: '{"sign":1}' }, "legs must be a list"],
    ["legs that are a number", { legs: "5" }, "legs must be a list"],
    ["a strike that is text", { strike: "abc" }, "strike must be a number"],
    ["a threshold that is missing", { threshold: null }, "threshold must be a number"],
    ["a direction that is bytes", { direction: BLOB }, "direction must be text"],
  ])("refuses %s, naming the rule and the field", (_, over, why) => {
    expect(() => toMonitor(storedMonitor(over))).toThrow(
      new Error(`monitor dec-wing cannot be read: ${why}`),
    );
  });

  it.each(['[{"option_type":"CALL","strike":8100}]', "{not json"])(
    "refuses the first fault in field order, so both backends name the same one (legs %s)",
    (legs) => {
      expect(() => toMonitor(storedMonitor({ strike: "abc", legs }))).toThrow(
        new Error("monitor dec-wing cannot be read: strike must be a number"),
      );
    },
  );

  it("refuses a code that is not text without naming the rule by it", () => {
    expect(() => toMonitor(storedMonitor({ code: BLOB }))).toThrow(
      new Error("a monitor cannot be read: code must be text"),
    );
  });
});

describe("a position", () => {
  it("reaches the domain with its legs parsed and its Opened", () => {
    const legs = [{ ...HELD_LEGS[0], filled_at: 6.45 }, HELD_LEGS[1]];
    expect(toPosition(storedPosition({ legs: JSON.stringify(legs) }))).toStrictEqual({
      id: "pos-1", name: "dec-condor", strategy: "iron_condor", opened_at: "2026-10-12",
      strike_date: "2026-12-18", contracts: 2, entry: 6.4, legs: HELD_LEGS,
    });
  });

  it("keeps an unknown entry, strategy and Opened unknown", () => {
    const p = toPosition(storedPosition({ entry: null, strategy: null, opened_at: null }));
    expect([p.entry, p.strategy, p.opened_at]).toEqual([null, null, null]);
  });

  it("with null legs holds nothing rather than failing", () => {
    // the column is NOT NULL, so only a hand edit gets here
    expect(toPosition(storedPosition({ legs: null })).legs).toEqual([]);
    expect(toPosition(storedPosition({ legs: "null" })).legs).toEqual([]);
  });

  it("reads a leg's quantity where one is stored, and none where none is (#351)", () => {
    const legs = [{ ...HELD_LEGS[0], qty: 2 }, HELD_LEGS[1]];
    expect(toPosition(storedPosition({ legs: JSON.stringify(legs) })).legs).toEqual(legs);
    const signs = [COMBO_LEGS[0], { ...COMBO_LEGS[1], qty: 2 }];
    expect(toMonitor(storedMonitor({ legs: JSON.stringify(signs) })).legs).toEqual(signs);
    expect(() => toMonitor(storedMonitor({ legs: JSON.stringify([{ ...COMBO_LEGS[0], qty: -1 }]) }))).toThrow(
      new Error("monitor dec-wing cannot be read: legs[0].qty must be a whole number, 1 or more"),
    );
  });

  it("whose legs are not JSON cannot be read", () => {
    expect(() => toPosition(storedPosition({ legs: "{not json" }))).toThrow(
      new Error("position dec-condor cannot be read: legs must be JSON"),
    );
  });

  it.each([
    ["a side of sold", { legs: '[{"side":"sold","option_type":"CALL","strike":8100}]' },
      'legs[0].side must be "short" or "long"'],
    ["a leg with no strike", { legs: '[{"side":"short","option_type":"CALL","strike":8100},{"side":"long","option_type":"PUT"}]' },
      "legs[1].strike must be a number"],
    ["a leg with no type", { legs: '[{"side":"long","strike":8100}]' },
      'legs[0].option_type must be "CALL" or "PUT"'],
    ["legs that are no list", { legs: '"short"' }, "legs must be a list"],
    ["a quantity of none", { legs: '[{"side":"short","option_type":"CALL","strike":8100,"qty":0}]' },
      "legs[0].qty must be a whole number, 1 or more"],
    ["half a quantity", { legs: '[{"side":"short","option_type":"CALL","strike":8100,"qty":1.5}]' },
      "legs[0].qty must be a whole number, 1 or more"],
    ["a quantity as text", { legs: '[{"side":"short","option_type":"CALL","strike":8100,"qty":"2"}]' },
      "legs[0].qty must be a whole number, 1 or more"],
    ["half a contract", { contracts: 2.5 }, "contracts must be a whole number"],
    ["contracts as text", { contracts: "2" }, "contracts must be a whole number"],
    ["an entry as text", { entry: "6.4" }, "entry must be a number or null"],
    ["a strategy that is bytes", { strategy: BLOB }, "strategy must be text or null"],
    ["an Opened that is a number", { opened_at: 20261012 }, "opened_at must be text or null"],
    ["a strike date that is missing", { strike_date: null }, "strike_date must be text"],
  ])("refuses %s, naming the holding and the field", (_, over, why) => {
    expect(() => toPosition(storedPosition(over))).toThrow(
      new Error(`position dec-condor cannot be read: ${why}`),
    );
  });

  it("refuses a name that is not text without naming the holding by it", () => {
    expect(() => toPosition(storedPosition({ name: BLOB }))).toThrow(
      new Error("a position cannot be read: name must be text"),
    );
  });
});
