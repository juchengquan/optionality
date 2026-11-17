import { describe, expect, it } from "vitest";

import { SWEEP_PRESETS, isSweepPreset, sweepsFor } from "./cadence.ts";

/** The sweep's interval as the page sets it, and the knobs counted in sweeps (#442).
 *
 *  The owner's decision, 2026-11-17: a threshold counted in sweeps was sized at the .env interval —
 *  five failures and ten silent sweeps at 15s are 75s and 150s — and keeps that TIME at any other
 *  interval. A faster sweep checks more often; it never gets trigger-happier.
 */
describe("the presets", () => {
  it("are 5, 10, 15, 30 and 60 seconds, and nothing below 5", () => {
    // each sweep is one moomoo snapshot call, limited to 60 per 30s and shared with every open
    // page's polls: nothing below 5s is offered
    expect([...SWEEP_PRESETS]).toEqual([5, 10, 15, 30, 60]);
  });

  it("refuse anything else, a number written as text included", () => {
    for (const x of [5, 10, 15, 30, 60]) expect(isSweepPreset(x)).toBe(true);
    for (const x of [0, 1, 4, 7, 20, 45, 90, 120, 5.5, -5, "5", null, undefined, true, Number.NaN]) {
      expect(isSweepPreset(x), String(x)).toBe(false);
    }
  });
});

describe("a count kept as a time", () => {
  it("is the count unchanged at the interval it was sized at", () => {
    expect(sweepsFor(5, 15, 15)).toBe(5);
    expect(sweepsFor(10, 15, 15)).toBe(10);
  });

  it("grows at a faster sweep, so the time stays: 75s and 150s at 5s are 15 and 30 sweeps", () => {
    expect(sweepsFor(5, 15, 5)).toBe(15);
    expect(sweepsFor(10, 15, 5)).toBe(30);
    expect(sweepsFor(5, 15, 10)).toBe(8);   // 7.5 sweeps: rounded up, never under the time
  });

  it("shrinks at a slower one, rounded UP so the time is never shorter than sized", () => {
    expect(sweepsFor(5, 15, 30)).toBe(3);   // 2.5
    expect(sweepsFor(5, 15, 60)).toBe(2);   // 1.25 → 120s, not 60s
    expect(sweepsFor(10, 15, 60)).toBe(3);  // 2.5 → 180s
    expect(sweepsFor(4, 15, 60)).toBe(1);   // exactly one: no rounding at all
  });

  it("is ceil at the boundary, not round: one second past a whole number is one sweep more", () => {
    expect(sweepsFor(4, 15, 30)).toBe(2);   // 2 exactly
    expect(sweepsFor(4, 16, 30)).toBe(3);   // 2.13…
    expect(sweepsFor(1, 61, 60)).toBe(2);   // 1.016…
    expect(sweepsFor(1, 60, 60)).toBe(1);
  });

  it("keeps a count of 0, which turns its knob off, at 0", () => {
    expect(sweepsFor(0, 15, 5)).toBe(0);
    expect(sweepsFor(0, 15, 60)).toBe(0);
  });

  it("never falls below one sweep for a count that was on", () => {
    // a threshold of 1 at a long .env interval, read at a short one, is still a threshold
    expect(sweepsFor(1, 1, 60)).toBe(1);
  });
});
