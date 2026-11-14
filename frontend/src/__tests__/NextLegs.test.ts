/** The delta the service serves for each leg of a holding (#318), read by the desk and the phone. */
import { describe, expect, it } from "vitest";

import { legCode, servedDelta } from "../legs";
import { HOLDINGS } from "../testing/ownerBook";

describe("a leg's code", () => {
  it("is the service's: US.SPXW, the expiry as yymmdd, C or P, the strike with three zeros", () => {
    expect(legCode("2026-12-18", { option_type: "PUT", strike: 7150 })).toBe("US.SPXW261218P7150000");
    expect(legCode("2027-01-15", { option_type: "CALL", strike: 8000 })).toBe("US.SPXW270115C8000000");
  });

  it("drops a strike's fraction as the service does, so a decimal strike still finds its delta", () => {
    // buildSpxCode writes the whole strike then 000: 7150.5 is keyed P7150000, not P7150500
    expect(legCode("2026-12-18", { option_type: "PUT", strike: 7150.5 })).toBe("US.SPXW261218P7150000");
  });
});

describe("a leg's served delta", () => {
  const [puts] = HOLDINGS;
  const short = puts!.legs.find((l) => l.side === "short")!;

  it("is read from the holding's map by the leg's code", () => {
    expect(servedDelta(puts!, short)).toBe(-0.21);
  });

  it("is null where the service sent no map", () => {
    expect(servedDelta({ ...puts!, legs_delta: null }, short)).toBeNull();
  });
});
