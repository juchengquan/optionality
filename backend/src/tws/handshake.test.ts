import { describe, expect, it } from "vitest";

import { MAX_SERVER_VERSION, greeting, readGreeting, startApi } from "./handshake.ts";
import { MIN_SERVER_VERSION, readFields } from "./wire.ts";

const NUL = "\u0000";

describe("what we say first", () => {
  it("sends the prefix unframed and the version range framed", () => {
    const out = greeting();
    // "API\0" is raw — it is how the gateway tells a v100+ client from the ancient protocol,
    // and framing it would make us look like neither
    expect(out.subarray(0, 4).toString("ascii")).toBe("API\0");
    expect(out.readUInt32BE(4)).toBe(out.length - 8);
    expect(out.subarray(8).toString("ascii")).toBe("v156..157");
  });

  it("advertises only what has been checked, not the newest that exists", () => {
    // the gateway answers with min(its version, our maximum), so this cap is what pins the
    // layout the decoder was written against
    expect(MAX_SERVER_VERSION).toBe(157);
    expect(MIN_SERVER_VERSION).toBeLessThanOrEqual(MAX_SERVER_VERSION);
  });
});

describe("what comes back", () => {
  it("reads the version and the gateway's clock", () => {
    const got = readGreeting(readFields(`157${NUL}20261108 10:35:00 Asia/Singapore${NUL}`));
    expect(got.serverVersion).toBe(157);
    expect(got.connectionTime).toBe("20261108 10:35:00 Asia/Singapore");
  });

  it("refuses a gateway below the floor, naming the reason", () => {
    // 155 is the live hazard, not a hypothetical: the gateway measured here speaks 157, ONE
    // above the gate, so a slightly older install really does produce the other layout
    expect(() => readGreeting(["155", "whenever"]))
      .toThrow(/speaks protocol 155.*needs 156.*greeks message changes shape/s);
  });

  it("refuses a greeting that is not two fields", () => {
    // half a greeting means the stream is not where we think it is, and guessing from one field
    // would carry that mistake into every message after it
    expect(() => readGreeting(["157"])).toThrow(/1 field\(s\), expected 2/);
  });

  it("refuses a version that is not a number rather than comparing NaN", () => {
    // `Number("hello") < 156` is false, so a bare comparison would ACCEPT this and then decode
    // against a version nobody knows
    expect(() => readGreeting(["hello", "whenever"])).toThrow(/not a number/);
  });
});

describe("starting the session", () => {
  it("sends message 71 with the client id and an empty capabilities field", () => {
    expect(startApi(31415)).toBe(`71${NUL}2${NUL}31415${NUL}${NUL}`);
  });

  it("keeps each consumer's id distinct, so one cannot displace another", () => {
    // IB Gateway allows one connection per id: the live service, a local `make serve` and the
    // harness must never collide, and the ids are the owning process's PORT so that a refusal
    // names the culprit
    expect(startApi(31417)).not.toBe(startApi(31415));
  });
});
