/** The protobuf-to-record mapping (ADR 0009, phase 6).
 *
 *  This file is now the only check on the mapping. The strongest evidence there ever was came from
 *  outside it — a live comparison against the Python SDK on the owner's own contracts, 288 field
 *  values with no divergences — but the `diff-opend` target went with the Python it compared against
 *  (#145), so that reading is history (2026-10-15, docs/cutover.md) and not a thing to re-run.
 *
 *  It was never sufficient anyway, which is why these cases exist: it could not check what live data
 *  never produces, and a mutation sweep against it showed exactly where. A quote with one side
 *  missing, a volume that needs more than 32 bits, a contract whose multiplier and size differ, and
 *  a field that simply is not there — four mapping mutations survived the live comparison untouched.
 */
import { describe, expect, it } from "vitest";

import { toRecord } from "./snapshot.ts";
import type { Snapshot } from "./types.ts";

const basic = (over: Record<string, unknown> = {}) => ({
  security: { market: 11, code: "SPXW261030C8100000" },
  name: "SPXW 261030 8100.00C",
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ basic: basic(), ...over });

describe("the mid price", () => {
  it("is the midpoint when both sides are quoted", () => {
    expect(toRecord(snap({ basic: basic({ bidPrice: 4.4, askPrice: 4.6 }) })).mid_price)
      .toBeCloseTo(4.5, 10);
  });

  it("is absent when only one side is quoted", () => {
    // a mid from one side is a number that looks like a price and is not one. Live data always has
    // both, so the live comparison cannot see this — an illiquid strike at the open can have one.
    expect(toRecord(snap({ basic: basic({ bidPrice: 4.4 }) })).mid_price).toBeUndefined();
    expect(toRecord(snap({ basic: basic({ askPrice: 4.6 }) })).mid_price).toBeUndefined();
    expect(toRecord(snap()).mid_price).toBeUndefined();
  });

  it("is a real zero when both sides are zero, not an absence", () => {
    // a worthless contract is quoted 0/0, and the domain must see 0 rather than "unknown"
    expect(toRecord(snap({ basic: basic({ bidPrice: 0, askPrice: 0 }) })).mid_price).toBe(0);
  });
});

describe("int64 fields", () => {
  it("reads a protobuf Long as the number the Python reports", () => {
    expect(toRecord(snap({ basic: basic({ volume: { low: 112, high: 0, unsigned: false } }) })).volume)
      .toBe(112);
  });

  it("reconstructs the upper 32 bits rather than reporting the lower half", () => {
    // SPX volumes never reach this, so the live comparison agrees either way. Reading `.low` alone
    // would report a turnover of 1 as 1 and a turnover of 2^32 as 0.
    const big = { low: 0, high: 3, unsigned: false }; // 3 * 2^32
    expect(toRecord(snap({ basic: basic({ volume: big }) })).volume).toBe(3 * 2 ** 32);
    // and the low half is read unsigned: bit 31 set is a large positive, not a negative
    const highBit = { low: -1, high: 0, unsigned: false };
    expect(toRecord(snap({ basic: basic({ volume: highBit }) })).volume).toBe(4_294_967_295);
  });

  it("takes a plain number too, in case the decoder gives one", () => {
    expect(toRecord(snap({ basic: basic({ volume: 112 }) })).volume).toBe(112);
  });
});

describe("the contract size", () => {
  it("prefers the float, which is what the Python reports", () => {
    // for SPX the multiplier, the integer size and the float size are all 100, so the live
    // comparison cannot tell them apart. They are three different fields and P&L is multiplied by
    // this one.
    const ex = { contractSize: 100, contractSizeFloat: 10, contractMultiplier: 50 };
    expect(toRecord(snap({ optionExData: ex })).option_contract_size).toBe(10);
    expect(toRecord(snap({ optionExData: ex })).option_contract_multiplier).toBe(50);
  });

  it("falls back to the integer size when there is no float", () => {
    expect(toRecord(snap({ optionExData: { contractSize: 100 } })).option_contract_size).toBe(100);
  });
});

describe("a field that is not there", () => {
  it("is absent from the record, never zero", () => {
    // the domain reads null as "no complete value — do not alarm". A zero delta is a position with
    // no exposure, which is a different statement and a silent one.
    const record = toRecord(snap({ optionExData: { delta: 0.045 } }));
    expect(record.option_delta).toBe(0.045);
    expect("option_gamma" in record).toBe(false);
    expect("option_vega" in record).toBe(false);
    expect("last_price" in record).toBe(false);
  });

  it("keeps a real zero, which is not the same as missing", () => {
    const record = toRecord(snap({ optionExData: { delta: 0, gamma: 0 } }));
    expect(record.option_delta).toBe(0);
    expect(record.option_gamma).toBe(0);
  });

  it("keeps a false, which `value ?? 0` would also survive but `value || 0` would not", () => {
    expect(toRecord(snap({ basic: basic({ isSuspend: false }) })).suspension).toBe(false);
  });

  it("omits the whole option block for an instrument that is not an option", () => {
    const record = toRecord(snap());
    expect("option_delta" in record).toBe(false);
    expect("option_type" in record).toBe(false);
    expect(record.code).toBe("US.SPXW261030C8100000");
  });
});

describe("codes and enums", () => {
  it("qualifies the code with its market, as every other code in the service is", () => {
    // build_spx_code produces US.SPXW..., every monitor's code carries it, and byCode is keyed by it
    expect(toRecord(snap()).code).toBe("US.SPXW261030C8100000");
  });

  it("qualifies the underlying the same way", () => {
    expect(toRecord(snap({ optionExData: { owner: { market: 11, code: ".SPX" } } })).stock_owner)
      .toBe("US..SPX");
  });

  it("names a market it does not know by its number rather than guessing", () => {
    expect(toRecord({ basic: { security: { market: 1, code: "00700" } } }).code).toBe("1.00700");
  });

  it("spells the option type and exercise style as the Python does", () => {
    expect(toRecord(snap({ optionExData: { type: 1 } })).option_type).toBe("CALL");
    expect(toRecord(snap({ optionExData: { type: 2 } })).option_type).toBe("PUT");
    expect(toRecord(snap({ optionExData: { optionAreaType: 1 } })).option_area_type).toBe("AMERICAN");
    expect(toRecord(snap({ optionExData: { optionAreaType: 2 } })).option_area_type).toBe("EUROPEAN");
  });

  it("omits a type it does not recognise rather than inventing a name", () => {
    expect("option_type" in toRecord(snap({ optionExData: { type: 99 } }))).toBe(false);
  });
});

describe("every field the service consumes", () => {
  /** One snapshot with a DISTINCT value in every field, so a mapping that reads the wrong source
   *  cannot coincide with the right one. The live comparison catches these against the Python, but
   *  only while OpenD is up and the market is open — this makes the file stand on its own. */
  const full: Snapshot = {
    basic: {
      security: { market: 11, code: "SPXW261030C8100000" },
      name: "SPXW 261030 8100.00C",
      isSuspend: true,
      lotSize: 101,
      updateTime: "2026-10-01 11:17:46",
      curPrice: 1.1,
      openPrice: 2.2,
      highPrice: 3.3,
      lowPrice: 4.4,
      lastClosePrice: 5.5,
      askPrice: 6.6,
      bidPrice: 7.7,
      askVol: { low: 8, high: 0, unsigned: false },
      bidVol: { low: 9, high: 0, unsigned: false },
      volume: { low: 10, high: 0, unsigned: false },
      turnover: 11.11,
      turnoverRate: 12.12,
      amplitude: 13.13,
      avgPrice: 14.14,
      bidAskRatio: 15.15,
    },
    optionExData: {
      type: 2,
      owner: { market: 11, code: ".SPX" },
      strikeTime: "2026-10-30",
      strikePrice: 16.16,
      contractSize: 17,
      contractSizeFloat: 18.18,
      contractMultiplier: 19.19,
      openInterest: 20,
      impliedVolatility: 21.21,
      premium: 22.22,
      delta: 23.23,
      gamma: 24.24,
      vega: 25.25,
      theta: 26.26,
      rho: 27.27,
      expiryDateDistance: 28,
      optionAreaType: 1,
    },
  };

  it("comes from the field it is supposed to", () => {
    expect(toRecord(full)).toEqual({
      code: "US.SPXW261030C8100000",
      name: "SPXW 261030 8100.00C",
      update_time: "2026-10-01 11:17:46",
      lot_size: 101,
      suspension: true,
      last_price: 1.1,
      open_price: 2.2,
      high_price: 3.3,
      low_price: 4.4,
      prev_close_price: 5.5,
      ask_price: 6.6,
      bid_price: 7.7,
      ask_vol: 8,
      bid_vol: 9,
      volume: 10,
      turnover: 11.11,
      turnover_rate: 12.12,
      amplitude: 13.13,
      avg_price: 14.14,
      bid_ask_ratio: 15.15,
      option_type: "PUT",
      stock_owner: "US..SPX",
      option_strike_time: "2026-10-30",
      option_strike_price: 16.16,
      option_contract_size: 18.18,
      option_contract_multiplier: 19.19,
      option_open_interest: 20,
      option_implied_volatility: 21.21,
      option_premium: 22.22,
      option_delta: 23.23,
      option_gamma: 24.24,
      option_vega: 25.25,
      option_theta: 26.26,
      option_rho: 27.27,
      option_expiry_date_distance: 28,
      option_area_type: "AMERICAN",
      mid_price: (6.6 + 7.7) / 2,
    });
  });
});
