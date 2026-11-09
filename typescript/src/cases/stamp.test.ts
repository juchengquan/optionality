import { describe, expect, it } from "vitest";

import { constantsOf } from "./build.ts";
import { goldenHash, pythonStamp, STAMP_LENGTH, tsStamp } from "./stamp.ts";

/** What the fingerprint must and must not notice (ADR 0016). */
describe("the golden fingerprint", () => {
  const files = { position: "{a}", monitor: "{b}" };

  it("is the same for the same cases", () => {
    expect(goldenHash(files)).toBe(goldenHash({ ...files }));
  });

  it("does not depend on the order the generator happened to build them in", () => {
    expect(goldenHash({ monitor: "{b}", position: "{a}" })).toBe(goldenHash(files));
  });

  it("moves when a case's content changes", () => {
    expect(goldenHash({ ...files, position: "{a2}" })).not.toBe(goldenHash(files));
  });

  it("moves when a module is added, even with nothing in it", () => {
    // the SET of case modules is part of the contract: a domain module that gained a golden file
    // is a domain module the port now owes a function
    expect(goldenHash({ ...files, exit: "" })).not.toBe(goldenHash(files));
  });

  it("notices two modules' contents swapping places", () => {
    // the name goes into the hash with its text, so this is not the same contract
    expect(goldenHash({ position: "{b}", monitor: "{a}" })).not.toBe(goldenHash(files));
  });

  it("is twelve hex characters, the length both stamps carry", () => {
    expect(goldenHash(files)).toMatch(/^[0-9a-f]{12}$/);
    expect(STAMP_LENGTH).toBe(12);
  });
});

describe("the stamps it writes", () => {
  it("puts the hash where each language reads a constant", () => {
    expect(tsStamp("abc123def456")).toContain('export const GOLDEN_CASES = "abc123def456";');
    expect(pythonStamp("abc123def456")).toContain('GOLDEN_CASES = "abc123def456"');
  });

  it("says it is generated, in both, so neither is edited by hand", () => {
    // editing either by hand defeats the guard: `make check-cases` compares, it does not repair
    expect(tsStamp("x")).toContain("make cases");
    expect(tsStamp("x")).toContain("do not edit");
    expect(pythonStamp("x")).toContain("make cases");
    expect(pythonStamp("x")).toContain("do not edit");
  });
});

/** The constants a module states, which go into the same generated files (ADR 0017's follow-up). */
describe("the constants a module states", () => {
  it("come out in name order, whatever order they went in", () => {
    // an ES module namespace is already sorted by spec, so the sort looks free — and a sweep showed
    // it: removing it changed no byte of any case file. It is not free for a plain object, and the
    // function is exported, so the determinism of the generated output is stated here instead.
    expect(Object.keys(constantsOf({ ZEBRA: 1, APPLE: 2, MIDDLE: 3 })))
      .toEqual(["APPLE", "MIDDLE", "ZEBRA"]);
  });

  it("leaves out the functions, which belong to the cases", () => {
    expect(constantsOf({ A: 1, b: () => 2 })).toEqual({ A: 1 });
  });

  it("encodes a value JSON cannot carry, like any case would", () => {
    expect(constantsOf({ S: new Set(["b", "a"]) })).toEqual({ S: { $set: ["a", "b"] } });
  });
});
