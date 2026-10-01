/** The stored datetime format. Nothing in the Python tests this directly — it is SQLAlchemy's
 *  business there — which is exactly why it needs testing here, where it is ours (ADR 0009). */
import { afterEach, describe, expect, it } from "vitest";

import { fromSqlDatetime, secondsSince, toSqlDatetime } from "./time.ts";

describe("writing", () => {
  it("writes UTC wall time in SQLAlchemy's shape", () => {
    expect(toSqlDatetime(new Date("2026-09-01T15:39:11.940Z"))).toBe("2026-09-01 15:39:11.940000");
  });

  it("pads the fraction to six digits, as every existing row has", () => {
    expect(toSqlDatetime(new Date("2026-09-01T15:39:11.000Z"))).toBe("2026-09-01 15:39:11.000000");
    expect(toSqlDatetime(new Date("2026-09-01T15:39:11.007Z"))).toBe("2026-09-01 15:39:11.007000");
  });
});

describe("reading", () => {
  it("reads a six-digit fraction as a real row has it", () => {
    // a monitor's created_at, copied from the live database
    expect(fromSqlDatetime("2026-09-01 15:39:11.940183").toISOString())
      .toBe("2026-09-01T15:39:11.940Z");
  });

  it("truncates below the millisecond rather than rounding", () => {
    // 999999 microseconds is 999.999 ms; rounding would carry into the next second and make a
    // timestamp that never existed
    expect(fromSqlDatetime("2026-09-01 15:39:11.999999").toISOString())
      .toBe("2026-09-01T15:39:11.999Z");
  });

  it("takes a fraction of any length, and none at all", () => {
    expect(fromSqlDatetime("2026-09-01 15:39:11").toISOString()).toBe("2026-09-01T15:39:11.000Z");
    expect(fromSqlDatetime("2026-09-01 15:39:11.9").toISOString()).toBe("2026-09-01T15:39:11.900Z");
    expect(fromSqlDatetime("2026-09-01 15:39:11.94").toISOString()).toBe("2026-09-01T15:39:11.940Z");
  });

  it("refuses text that is not a stored datetime", () => {
    for (const bad of ["", "2026-09-01", "01/09/2026 15:39:11", "2026-09-01 15:39:11+08:00"]) {
      expect(() => fromSqlDatetime(bad), bad).toThrow(/not a stored datetime/);
    }
  });
});

describe("the zone the text is in", () => {
  const TZ = process.env.TZ;
  afterEach(() => { process.env.TZ = TZ; });

  it("is UTC regardless of the machine's own zone", () => {
    // The suite pins TZ=UTC, which would HIDE a missing Z: a naive parse and a UTC parse agree
    // there. So this test moves the zone on purpose. Node re-reads process.env.TZ, and under
    // Singapore a naive parse of this text would land eight hours early.
    process.env.TZ = "Asia/Singapore";
    expect(fromSqlDatetime("2026-09-01 15:39:11.940183").toISOString())
      .toBe("2026-09-01T15:39:11.940Z");
    process.env.TZ = "America/New_York";
    expect(fromSqlDatetime("2026-09-01 15:39:11.940183").toISOString())
      .toBe("2026-09-01T15:39:11.940Z");
  });

  it("round-trips through both directions in any zone", () => {
    for (const tz of ["UTC", "Asia/Singapore", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      const stored = "2026-09-01 15:39:11.940000";
      expect(toSqlDatetime(fromSqlDatetime(stored)), tz).toBe(stored);
    }
  });
});

describe("elapsed time", () => {
  it("counts seconds from a stored timestamp", () => {
    // what the alarm cooldown and the sweep watchdog ask for
    const now = new Date("2026-09-01T15:40:11.940Z");
    expect(secondsSince("2026-09-01 15:39:11.940183", now)).toBe(60);
  });

  it("is negative for a timestamp in the future rather than clamped", () => {
    const now = new Date("2026-09-01T15:39:00.000Z");
    expect(secondsSince("2026-09-01 15:39:11.000000", now)).toBe(-11);
  });
});
