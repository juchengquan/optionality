/** `shared/format.ts`'s readers, which the page still uses: a contract's short name, the service's
 *  stamp without its zone, New York's trading day and the screen's own clock.
 *
 *  Their cases lived in the old page's suites (`Columns`, `LastTrade`, `Opened`, `Clock`), beside
 *  the tables and forms that drew them, and went with those suites in the swap (#301). They come
 *  back here, against the module alone. The suite runs under TZ=UTC (vitest.config.ts), so a case
 *  that reads the DEVICE's zone writes its instant in another one and states the conversion.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { contractName, heldLeg, legText, marketDay, shortFirst, shortStamp, signedLeg } from "../shared/format";

describe("legs, short as the true minus (#351, 2026-11-16)", () => {
  it("writes a quantity between the sign and the contract, and a quantity of one not at all", () => {
    expect([
      { sign: 1, option_type: "CALL", strike: 7300 }, { sign: -1, option_type: "CALL", strike: 7350, qty: 2 },
      { sign: 1, option_type: "CALL", strike: 7400, qty: 1 },
    ].map((l) => legText(signedLeg(l), "signs")).join(" ")).toBe("+C7300 \u22122C7350 +C7400");
    expect([
      { side: "long", option_type: "PUT", strike: 6400 }, { side: "short", option_type: "PUT", strike: 6350, qty: 2 },
    ].map((l) => legText(heldLeg(l), "signs")).join(" ")).toBe("+P6400 \u22122P6350");
  });
});

/** One spelling of a contract on the page, the bot's and the leg's (2026-11-17): `20261218 P6800`,
 *  letter first, from the CODE — not moomoo's name rewritten, `20261218 P6800`, which another vendor
 *  would have named differently again. The domain's `contractName`, which the page cannot import, so
 *  it is held to the domain's own cases. */
const CONTRACT_CASES = (() => {
  const file = [".", ".."].map((d) => resolve(process.cwd(), d, "testdata/golden/contract.json"))
    .find((f) => existsSync(f))!;
  return (JSON.parse(readFileSync(file, "utf8")) as { cases: { fn: string; name: string; args: string[]; expect: string }[] })
    .cases;
})();

describe("contract names", () => {
  it("has the domain's cases", () => {
    expect(CONTRACT_CASES.filter((c) => c.fn === "contractName").length).toBeGreaterThanOrEqual(4);
    expect(CONTRACT_CASES.filter((c) => c.fn === "shortSpxCode").length).toBeGreaterThanOrEqual(2);
  });
  for (const c of CONTRACT_CASES.filter((x) => x.fn === "contractName")) {
    it(`contractName: ${c.name}`, () => { expect(contractName(c.args[0]!, c.args[1]!)).toBe(c.expect); });
  }
  for (const c of CONTRACT_CASES.filter((x) => x.fn === "shortSpxCode")) {
    // shortSpxCode is contractName with the code as the fallback
    it(`shortSpxCode: ${c.name}`, () => { expect(contractName(c.args[0]!)).toBe(c.expect); });
  }
});

/** The service renders every timestamp in DISPLAY_TZ, so the trailing offset is the same on every
 *  row. The DATE stays: a far strike can go days without a print, and a bare clock would read as
 *  this morning. */
describe("the service's timestamp, shortened", () => {
  it("drops the zone every row repeats", () => {
    expect(shortStamp("2026-10-31 04:16:24+08:00")).toBe("2026-10-31 04:16:24");
  });

  it("drops a negative one too — DISPLAY_TZ is a setting, not a constant", () => {
    expect(shortStamp("2026-10-31 04:16:24-04:00")).toBe("2026-10-31 04:16:24");
  });

  it("keeps the day, which is the half that carries information", () => {
    expect(shortStamp("2026-10-29 04:16:24+08:00")).toContain("2026-10-29");
  });

  it("leaves a stamp that has no zone on it alone", () => {
    expect(shortStamp("2026-10-31 04:16:24")).toBe("2026-10-31 04:16:24");
  });

  it("leaves anything it does not recognise untouched", () => {
    // "x" is what every fixture in this repo passes for a timestamp; a shortener that mangles
    // the unexpected is worse than one that declines
    expect(shortStamp("x")).toBe("x");
    expect(shortStamp("2026-10-31T04:16:24.123Z")).toBe("2026-10-31T04:16:24.123Z");
  });

  it("declines a stamp of a different shape rather than cutting it to length", () => {
    // the same rule `shortContract` states: an ISO `T` with an offset is the near miss that
    // matters — the offset falls exactly where this would cut
    expect(shortStamp("2026-10-31T04:16:24-05:00")).toBe("2026-10-31T04:16:24-05:00");
  });
});

/** Opened is a TRADING day. Samples are keyed to New York's calendar, and vol attribution is null
 *  unless a holding's `opened_at` matches its first sample's day — so through the Singapore
 *  morning, when a trade gets recorded after the 04:00 close, the local date is a day ahead. */
describe("the trading day", () => {
  it("is New York's date, not the local one, through the Singapore morning", () => {
    // 09:20 in Singapore on the 20th: 21:20 on the 19th in New York
    expect(marketDay(new Date("2026-10-20T01:20:00Z"))).toBe("2026-10-19");
  });

  it("rolls when New York's does, not when Singapore's does", () => {
    // 21:00 SGT on the 20th is 09:00 in New York, half an hour before the open
    expect(marketDay(new Date("2026-10-20T13:00:00Z"))).toBe("2026-10-20");
  });
});

describe("a structure's legs, short first (2026-11-16)", () => {
  it("puts the short legs before the long, each side in its given order", () => {
    const legs = [
      { short: false, option_type: "PUT", strike: 6250 }, { short: true, option_type: "PUT", strike: 6300 },
      { short: true, option_type: "CALL", strike: 7400 }, { short: false, option_type: "CALL", strike: 7450 },
    ];
    expect(shortFirst(legs).map((l) => legText(l, "signs")).join(" ")).toBe("−P6300 −C7400 +P6250 +C7450");
    expect(shortFirst<{ short?: boolean; option_type: string; strike: number }>([{ option_type: "CALL", strike: 8000 }]).map((l) => legText(l, "signs"))).toEqual(["C8000"]);
  });
});
