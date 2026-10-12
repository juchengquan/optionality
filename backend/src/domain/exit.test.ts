/** The exit schedule's arithmetic (ADR 0011). */
import { describe, expect, it } from "vitest";

import { dteAtOpen, exitLevels, onPace } from "./exit.ts";

const POLICY = { takeFraction: 0.5, stopMultiple: 2, manageByDte: 21 };

describe("DTE at open", () => {
  it("is two calendar dates subtracted, and nothing else", () => {
    expect(dteAtOpen("2026-11-20", "2026-10-06")).toBe(45);
    expect(dteAtOpen("2026-11-20", "2026-09-24")).toBe(57);
    expect(dteAtOpen("2026-11-20", "2026-11-20")).toBe(0);
  });

  it("does not go through the market date, which would read a day short", () => {
    // daysToExpiry reckons from marketDate(now), so handing it the opened day as a UTC midnight
    // puts it at 20:00 the PREVIOUS afternoon in New York and returns 46 where 45 is right. The
    // first version of this did exactly that; these are dates, not instants.
    expect(dteAtOpen("2026-11-20", "2026-10-06")).toBe(45);
    // and it survives a daylight-saving change inside the span: 1 Nov 2026 is the US fall-back
    expect(dteAtOpen("2026-11-20", "2026-10-20")).toBe(31);
  });

  it("accepts either spelling of a date, as every other date in the system does", () => {
    expect(dteAtOpen("20261120", "2026-10-06")).toBe(45);
    expect(dteAtOpen("2026-11-20", "20261006")).toBe(45);
  });
});

describe("on-pace", () => {
  it("is the Entry scaled by the square root of the time left", () => {
    // extrinsic value scales as √T, so the fraction still outstanding is √(d/D₀). No IV input,
    // no spot input, no parameters — a shape rather than a price.
    expect(onPace(6.86, 45, 45)).toBeCloseTo(6.86, 10);
    expect(onPace(6.86, 45, 21)).toBeCloseTo(6.86 * Math.sqrt(21 / 45), 10);
    expect(onPace(6.86, 45, 0)).toBe(0);
  });

  it("predicted the owner's condor to within 0.11 points over six days", () => {
    // the one observation the shape was chosen on, kept as a test so the claim in ADR 0011 is
    // checkable rather than quoted. 6.39 against an actual 6.50 — behind pace, by 1.6% of Entry.
    const predicted = onPace(6.86, 45, 39)!;
    expect(predicted).toBeCloseTo(6.39, 2);
    expect(6.5 - predicted).toBeCloseTo(0.11, 2);
  });

  it("works for a debit structure, whose Entry is negative", () => {
    // a long's Entry is a NEGATIVE credit (#92) and its Cost to close is negative too, so the
    // same scaling holds and the sign carries through: bought for 5.00, and with 21 of 45 days
    // left this shape puts it at 3.42 — a LOSS of 1.58 to decay, correctly signed.
    expect(onPace(-5, 45, 21)).toBeCloseTo(-5 * Math.sqrt(21 / 45), 10);
    expect(onPace(-5, 45, 21)!).toBeLessThan(0);
  });

  it("is unknown rather than guessed where it cannot be computed", () => {
    expect(onPace(null, 45, 21), "no Entry, no pace").toBeNull();
    expect(onPace(6.86, 0, 0), "Opened on the expiry day divides by zero").toBeNull();
    expect(onPace(6.86, -5, 21), "Opened after expiry is not a thing").toBeNull();
    expect(onPace(6.86, 45, -1), "expired").toBeNull();
    // today further from expiry than the day it was opened means the Opened is wrong, and a
    // wrong Opened must show as unknown rather than as a number above Entry
    expect(onPace(6.86, 21, 45), "Opened later than today").toBeNull();
  });
});

describe("the levels", () => {
  it("takes a fraction of Entry and stops at a multiple of it", () => {
    const l = exitLevels(6.86, 45, 39, POLICY)!;
    expect(l.target).toBeCloseTo(3.43, 10);
    expect(l.stop).toBeCloseTo(13.72, 10);
    expect(l.manage_by_dte).toBe(21);
  });

  it("says which DTE the Target arrives at on decay alone", () => {
    // √(d/D₀) = 1 - take  →  d = D₀(1-take)². The headline finding: a 50% Target is not reached
    // by time alone until ~11 DTE, so hitting it at 21 came from an IV drop or a move.
    expect(exitLevels(6.86, 45, 39, POLICY)!.target_dte).toBe(11);
    expect(exitLevels(3.91, 57, 39, POLICY)!.target_dte).toBe(14);
  });

  it("reports the gap to pace, signed so that behind is positive", () => {
    // behind means costing MORE than it should, which is the direction that hurts
    const behind = exitLevels(6.86, 45, 39, POLICY, 6.5)!;
    expect(behind.on_pace).toBeCloseTo(6.39, 2);
    expect(behind.pace_gap).toBeCloseTo(0.11, 2);

    const ahead = exitLevels(6.86, 45, 39, POLICY, 6.0)!;
    expect(ahead.pace_gap!).toBeLessThan(0);
  });

  it("has no Target or Stop for a debit structure, and says so by leaving them null", () => {
    // a fraction of Entry is the credit you keep, and a debit has none to keep: max profit is
    // unbounded, so "take 50%" names nothing. The pace line still works and still means something.
    const l = exitLevels(-5, 45, 21, POLICY, -3.4)!;
    expect(l.on_pace).toBeCloseTo(-3.4157, 3);
    expect(l.target).toBeNull();
    expect(l.stop).toBeNull();
    expect(l.target_dte).toBeNull();
    expect(l.manage_by_dte, "the deadline is about time, not about sign").toBe(21);
  });

  it("is null altogether when the Position was never declared Opened", () => {
    // `opened_at` is the opt-in: no Opened, no schedule. Nothing is guessed from created_at,
    // which is the day a Position was RECORDED (ADR 0011).
    expect(exitLevels(6.86, null, 39, POLICY)).toBeNull();
  });
});
