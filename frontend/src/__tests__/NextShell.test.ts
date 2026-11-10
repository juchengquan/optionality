/** The redesigned page's decisions that are not drawing: which arrangement, which mode (ADR 0023).
 *
 *  Both are state, not routes (ADR 0005), and both have a default that can be overridden — so
 *  each is a pure function of what was measured and what was chosen, tested here without a page.
 */
import { describe, expect, it } from "vitest";

import { arrangementFor, DESK_FROM } from "../next/arrangement";
import { clockMode, inSession } from "../next/mode";

describe("the measured width chooses the arrangement", () => {
  it("puts the cards on anything narrower than the desk and the terminal on the rest", () => {
    expect(arrangementFor(390, "auto")).toBe("phone");
    expect(arrangementFor(DESK_FROM - 1, "auto")).toBe("phone");
    expect(arrangementFor(DESK_FROM, "auto")).toBe("desk");
    expect(arrangementFor(2560, "auto")).toBe("desk");
  });

  it("is about 900 CSS pixels, as the ADR decided", () => {
    expect(DESK_FROM).toBe(900);
  });

  it("lets a device force either arrangement whatever its width", () => {
    expect(arrangementFor(390, "desk")).toBe("desk");
    expect(arrangementFor(2560, "phone")).toBe("phone");
  });
});

/** The session as the options trade it: 09:30 to 16:15 New York, Monday to Friday. Instants are
 *  written in UTC, so each test states the conversion rather than leaning on the machine's zone. */
describe("the clock chooses the mode", () => {
  const at = (iso: string) => new Date(iso);

  it("is in session from the 09:30 open to the 16:15 options close, in winter", () => {
    // Monday 2026-11-09, EST (UTC-5)
    expect(inSession(at("2026-11-09T14:29:59Z"))).toBe(false);
    expect(inSession(at("2026-11-09T14:30:00Z"))).toBe(true);
    expect(inSession(at("2026-11-09T21:15:59Z"))).toBe(true);
    expect(inSession(at("2026-11-09T21:16:00Z"))).toBe(false);
  });

  it("moves with New York's summer time, not with the viewer's", () => {
    // Monday 2026-07-06, EDT (UTC-4): the same wall clock an hour earlier in UTC
    expect(inSession(at("2026-07-06T13:29:59Z"))).toBe(false);
    expect(inSession(at("2026-07-06T13:30:00Z"))).toBe(true);
    expect(inSession(at("2026-07-06T20:15:59Z"))).toBe(true);
  });

  it("crosses the November clock change without slipping an hour", () => {
    // Friday 2026-10-30 is EDT; Monday 2026-11-02 is EST, after the change on Sunday the 1st
    expect(inSession(at("2026-10-30T13:30:00Z"))).toBe(true);
    expect(inSession(at("2026-11-02T13:30:00Z"))).toBe(false);
    expect(inSession(at("2026-11-02T14:30:00Z"))).toBe(true);
  });

  it("is out of session all weekend, at hours that would be the session on a weekday", () => {
    expect(inSession(at("2026-11-07T15:00:00Z"))).toBe(false); // Saturday 10:00 EST
    expect(inSession(at("2026-11-08T15:00:00Z"))).toBe(false); // Sunday
  });

  it("reads New York's day, not UTC's: Monday evening in New York is Tuesday in UTC", () => {
    // 2026-11-10T01:00Z is Monday 20:00 EST — after the close, though UTC already says Tuesday
    expect(inSession(at("2026-11-10T01:00:00Z"))).toBe(false);
  });

  it("is LIVE in the session and REVIEW outside it", () => {
    expect(clockMode(at("2026-11-09T15:00:00Z"))).toBe("live");
    // 21:00 in Singapore, before the open: the ADR's own example of when the override is needed
    expect(clockMode(at("2026-11-09T13:00:00Z"))).toBe("review");
  });
});
