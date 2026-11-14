/** The page's decisions that are not drawing: which arrangement, and whether New York's
 *  session is open (ADR 0023, amended 2026-11-13: one page, by the session).
 *
 *  The arrangement is state, not a route (ADR 0005), with a default that can be overridden; the
 *  session is the clock's alone. Each is a pure function of what was measured or chosen, tested
 *  here without a page.
 */
import { describe, expect, it } from "vitest";

import { arrangementFor, DESK_FROM } from "../arrangement";
import { inSession, servedWhen, sessionEdge } from "../session";

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
describe("the clock says whether the session is open", () => {
  const at = (iso: string) => new Date(iso);

  it("is in session from the 09:30 open to the 16:15 options close, in winter", () => {
    // Monday 2026-11-09, EST (UTC-5)
    expect(inSession(at("2026-11-09T14:29:59Z"))).toBe(false);
    expect(inSession(at("2026-11-09T14:30:00Z"))).toBe(true);
    // 16:15:00 is in, as the daily sample's window has it; a second later is not
    expect(inSession(at("2026-11-09T21:15:00Z"))).toBe(true);
    expect(inSession(at("2026-11-09T21:15:01Z"))).toBe(false);
  });

  it("moves with New York's summer time, not with the viewer's", () => {
    // Monday 2026-07-06, EDT (UTC-4): the same wall clock an hour earlier in UTC
    expect(inSession(at("2026-07-06T13:29:59Z"))).toBe(false);
    expect(inSession(at("2026-07-06T13:30:00Z"))).toBe(true);
    expect(inSession(at("2026-07-06T20:15:00Z"))).toBe(true);
    expect(inSession(at("2026-07-06T20:15:01Z"))).toBe(false);
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
});

/** WHICH session the clock is in, or after: the last open or close at or before now (#371's
 *  review). A boolean cannot tell Monday evening from Tuesday evening, and a tab asleep through a
 *  whole session (iOS suspends timers) woke to the same `false` and never valued the book again. */
describe("the last edge of the session", () => {
  const at = (iso: string) => new Date(iso);
  const edge = (iso: string) => sessionEdge(at(iso)).toISOString();

  it("is the day's open from 09:30:00 to 16:15:00, and its close from 16:15:01", () => {
    // Monday 2026-11-09, EST (UTC-5)
    expect(edge("2026-11-09T14:30:00Z")).toBe("2026-11-09T14:30:00.000Z");
    expect(edge("2026-11-09T21:15:00Z")).toBe("2026-11-09T14:30:00.000Z");
    expect(edge("2026-11-09T21:15:01Z")).toBe("2026-11-09T21:15:01.000Z");
    expect(edge("2026-11-10T01:00:00Z")).toBe("2026-11-09T21:15:01.000Z"); // Monday 20:00
  });

  it("is the day before's close until the open, and Friday's all weekend", () => {
    expect(edge("2026-11-10T14:29:59Z")).toBe("2026-11-09T21:15:01.000Z"); // Tuesday 09:29:59
    expect(edge("2026-11-07T15:00:00Z")).toBe("2026-11-06T21:15:01.000Z"); // Saturday
    expect(edge("2026-11-08T23:00:00Z")).toBe("2026-11-06T21:15:01.000Z"); // Sunday 18:00
    expect(edge("2026-11-09T14:29:59Z")).toBe("2026-11-06T21:15:01.000Z"); // Monday 09:29:59
  });

  it("changes across a whole session slept through, though the session reads false at both ends", () => {
    // Monday 20:00 and Tuesday 20:00 New York: out of session both times, a session apart
    expect(inSession(at("2026-11-10T01:00:00Z"))).toBe(inSession(at("2026-11-11T01:00:00Z")));
    expect(edge("2026-11-10T01:00:00Z")).not.toBe(edge("2026-11-11T01:00:00Z"));
    // and Friday evening to Monday evening
    expect(edge("2026-11-07T01:00:00Z")).not.toBe(edge("2026-11-10T01:00:00Z"));
  });

  it("is New York's wall clock across the November clock change", () => {
    // Friday 2026-10-30 is EDT (UTC-4): its close is 20:15:01 UTC; Monday 2026-11-02 is EST
    expect(edge("2026-11-01T12:00:00Z")).toBe("2026-10-30T20:15:01.000Z");
    expect(edge("2026-11-02T14:30:00Z")).toBe("2026-11-02T14:30:00.000Z");
    // and March's: Friday 2027-03-12 is EST, Monday 2027-03-15 EDT
    expect(edge("2027-03-14T12:00:00Z")).toBe("2027-03-12T21:15:01.000Z");
    expect(edge("2027-03-15T13:30:00Z")).toBe("2027-03-15T13:30:00.000Z");
  });
});

/** A served time, with its date when it is not from today in the zone it was written in, or when
 *  it predates the session's last edge (#371's review): "valued at 07:00" on a page woken a day
 *  later read as this morning's. */
describe("a served time, dated when it is not this session's", () => {
  // Tuesday 2026-11-10 07:00 in the service's +08:00, Monday 18:00 in New York, after the close
  const now = new Date("2026-11-09T23:00:00Z");

  it("is the time alone when it is today's and after the last edge", () => {
    expect(servedWhen("2026-11-10 06:59:11+08:00", now)).toBe("06:59");
    // Monday 16:20 New York, after the close at 16:15:01, written in +08 on Tuesday
    expect(servedWhen("2026-11-10 05:20:00+08:00", now)).toBe("05:20");
  });

  it("carries its weekday from earlier in the week, and its date from before that", () => {
    expect(servedWhen("2026-11-09 21:04:11+08:00", now)).toBe("Mon 21:04");
    expect(servedWhen("2026-11-07 05:15:00+08:00", now)).toBe("Sat 05:15");
    expect(servedWhen("2026-11-03 21:04:00+08:00", now)).toBe("3 Nov 21:04");
  });

  it("carries its weekday when it is today's but from before the last edge", () => {
    // Tuesday 04:00 in +08 is Monday 15:00 in New York: inside the session that has since closed
    expect(servedWhen("2026-11-10 04:00:00+08:00", now)).toBe("Tue 04:00");
  });

  it("reads the day in the stamp's own zone, never the device's", () => {
    // the same instant written in New York's zone: Monday's evening there, and today there
    expect(servedWhen("2026-11-09 17:59:00-05:00", now)).toBe("17:59");
  });

  it("is the time alone where the stamp gives no zone to judge it by, and nothing without a time", () => {
    expect(servedWhen("2026-11-03 21:04:00", now)).toBe("21:04");
    expect(servedWhen("x", now)).toBeNull();
    expect(servedWhen(null, now)).toBeNull();
    expect(servedWhen(undefined, now)).toBeNull();
  });
});
