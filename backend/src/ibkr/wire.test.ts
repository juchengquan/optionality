import { describe, expect, it } from "vitest";

/** The field terminator, spelled once: "\0" followed by a digit is a legacy octal escape,
 *  which an ES module refuses outright. */
const NUL = "\u0000";

import {
  MIN_SERVER_VERSION, frame, notComputed, readFrames, readFields, toFields,
} from "./wire.ts";

/** The wire format, which is the whole of what a hand-written client has to get right.
 *
 *  Checked against the official Python client's `comm.py`, read module in hand rather than
 *  remembered: a 4-byte big-endian length prefix, then ASCII fields each terminated by NUL.
 *  Getting this wrong does not raise — it SHIFTS every field, so theta reads as vega, which is
 *  the failure this file exists to make impossible.
 */

describe("framing", () => {
  it("prefixes a payload with its length, big-endian", () => {
    const out = frame("API");
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 3]);
    expect(out.subarray(4).toString("ascii")).toBe("API");
  });

  it("refuses a field that is not ASCII, rather than guessing its bytes", () => {
    // The protocol allows printable ASCII only, and the reference client raises here too. The
    // first draft of this file instead asserted how many bytes "é" takes — which is a question
    // the protocol does not have an answer to, and the test was measuring my encoding choice
    // rather than any rule. Refusing at the door is what keeps the length and the payload in
    // agreement, and a disagreement there desynchronises the stream permanently.
    expect(() => toFields(["SPÉ"])).toThrow(/ascii/i);
    expect(() => toFields(["SPX"])).not.toThrow();
  });

  it("joins fields with a NUL after each, including the last", () => {
    expect(toFields([71, 2, 31415])).toBe(`71${NUL}2${NUL}31415${NUL}`);
  });

  it("writes a boolean as 1 or 0, the way the reference client does", () => {
    expect(toFields([true, false])).toBe(`1${NUL}0${NUL}`);
  });

  it("refuses null rather than sending the word", () => {
    // `String(null)` is "null", which the gateway would read as a symbol. The reference client
    // raises here too — "Cannot send None to TWS".
    expect(() => toFields([null as unknown as number])).toThrow(/null/i);
  });
});

describe("reading what comes back", () => {
  it("splits a payload into fields and drops the trailing empty", () => {
    expect(readFields(`1${NUL}2${NUL}3${NUL}`)).toEqual(["1", "2", "3"]);
  });

  it("keeps an EMPTY field, which is the gateway saying 'no value'", () => {
    // an empty string is how the gateway declines a field it was asked for; losing it would
    // shift everything after it
    expect(readFields(`1${NUL}${NUL}3${NUL}`)).toEqual(["1", "", "3"]);
  });

  it("yields whole frames and keeps the remainder for the next read", () => {
    const stream = Buffer.concat([
      frame(`one${NUL}`), frame(`two${NUL}`), frame("thr").subarray(0, 5),
    ]);
    const { frames, rest } = readFrames(stream);
    expect(frames.map((f) => readFields(f))).toEqual([["one"], ["two"]]);
    // the half-arrived third frame is NOT guessed at: a socket delivers bytes, not messages,
    // and a reader that assumes otherwise works until the day a message straddles two packets
    expect(rest.length).toBe(5);
  });

  it("waits when even the length prefix is incomplete", () => {
    const { frames, rest } = readFrames(Buffer.from([0, 0]));
    expect(frames).toEqual([]);
    expect(rest.length).toBe(2);
  });
});

describe("the not-computed sentinels", () => {
  // read straight out of the reference decoder. A greek that has not been computed arrives as a
  // NUMBER, not as an empty field, and -2 printed on the dashboard as a delta is the exact
  // silent-wrong-answer this guards.
  it("reads -2 as no figure for the greeks", () => {
    for (const field of ["delta", "gamma", "vega", "theta"] as const) {
      expect(notComputed(field, -2)).toBe(true);
      expect(notComputed(field, 0.25)).toBe(false);
    }
  });

  it("reads -1 as no figure for a price, and any negative for implied volatility", () => {
    expect(notComputed("optPrice", -1)).toBe(true);
    expect(notComputed("undPrice", -1)).toBe(true);
    expect(notComputed("impliedVol", -0.0001)).toBe(true);
    expect(notComputed("impliedVol", 0.1368)).toBe(false);
  });

  it("does not treat a legitimate negative delta as missing", () => {
    // a put's delta is negative, and -2 is not a delta any option has
    expect(notComputed("delta", -0.42)).toBe(false);
  });
});

describe("the version floor", () => {
  it("is the one below which greeks decode differently", () => {
    // 156 is MIN_SERVER_VER_PRICE_BASED_VOLATILITY: at 155 and below the message carries a
    // version field and no tickAttrib, so the same bytes mean different things. We refuse to
    // speak rather than implement a layout no gateway here can produce.
    expect(MIN_SERVER_VERSION).toBe(156);
  });
});
