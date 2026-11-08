/** The TWS socket wire format: framing, fields, and the sentinels that mean "no figure".
 *
 *  IB Gateway speaks a length-prefixed, NUL-delimited text protocol over a plain socket — not
 *  the Client Portal REST API the service tried first (ADR 0015, replaced). This module is the
 *  only place that knows the byte layout; everything above it deals in fields.
 *
 *  Every rule here was read out of the official Python client (`ibapi.comm`, `ibapi.decoder`)
 *  rather than remembered, and the modules were open while this was written. That matters more
 *  than usual: a framing or sentinel mistake does not raise. It SHIFTS the fields, so theta is
 *  read as vega and a dashboard shows a plausible wrong number for ever.
 */

/** Below this the greeks message has a different shape.
 *
 *  156 is the reference client's MIN_SERVER_VER_PRICE_BASED_VOLATILITY. At 156 and above the
 *  message carries a `tickAttrib` field and no version field; below it, the reverse. The gateway
 *  measured on this machine speaks 157 — ONE above the gate — so both layouts are live in the
 *  wild and the difference is invisible in the bytes. Rather than implement a layout nothing here
 *  can produce, and therefore nothing here can test, the client refuses a lower gateway out loud.
 *
 *  Every other optional field in the messages this client sends is gated at 114 or below, so
 *  above this floor the ENCODING is unconditional. That is why `messages.ts` has no version
 *  branches: the floor buys their absence.
 */
export const MIN_SERVER_VERSION = 156;

/** One message, ready for the socket: its byte length big-endian, then the payload. */
export function frame(payload: string): Buffer {
  const body = Buffer.from(payload, "binary");
  const out = Buffer.allocUnsafe(4 + body.length);
  // the length is in BYTES. `payload.length` counts UTF-16 units, which agrees for the ASCII the
  // protocol allows and silently disagrees for anything else — and a wrong length desynchronises
  // the stream permanently rather than failing the one message.
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** The fields of one outgoing message, each terminated by NUL — the last one included. */
export function toFields(values: readonly (string | number | boolean)[]): string {
  return values.map((value) => `${field(value)}\0`).join("");
}

function field(value: string | number | boolean): string {
  if (value === null || value === undefined) {
    // `String(null)` is "null", which the gateway reads as a symbol named null. The reference
    // client raises here for the same reason: "Cannot send None to TWS".
    throw new Error("cannot send null to IB Gateway");
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = String(value);
  // printable ASCII only, as the reference client insists. Anything else cannot be sent
  // faithfully, and sending it mangled is worse than refusing: the length prefix and the
  // payload would still agree, so the gateway would act on a corrupted symbol in silence.
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`field is not printable ASCII, which the protocol requires: ${JSON.stringify(text)}`);
  }
  return text;
}

/** The fields of one incoming message.
 *
 *  The payload ends with a NUL, so splitting leaves a trailing empty string that is punctuation
 *  rather than a field. An empty field in the MIDDLE is the gateway declining to answer that one,
 *  and it is kept: dropping it would shift everything after it.
 */
export function readFields(payload: string): string[] {
  const parts = payload.split("\0");
  parts.pop();
  return parts;
}

/** Whole frames out of a byte stream, with whatever is left over.
 *
 *  A socket delivers bytes, not messages: one read can carry two frames and half of a third, and
 *  a long message can straddle several reads. The caller keeps `rest` and prepends it next time.
 */
export function readFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let at = 0;
  while (buffer.length - at >= 4) {
    const size = buffer.readUInt32BE(at);
    if (buffer.length - at - 4 < size) break;        // the whole frame has not arrived yet
    frames.push(buffer.subarray(at + 4, at + 4 + size).toString("binary"));
    at += 4 + size;
  }
  return { frames, rest: buffer.subarray(at) };
}

/** Which value means "not computed" for each figure in the greeks message.
 *
 *  These are NUMBERS, not empty fields, which is what makes them dangerous: -2 is a perfectly
 *  good double and would print as a delta. Straight from the reference decoder — implied
 *  volatility is any negative, the greeks are -2, and the two prices are -1.
 */
const SENTINEL: Record<string, number> = {
  delta: -2, gamma: -2, vega: -2, theta: -2, optPrice: -1, undPrice: -1, pvDividend: -1,
};

export function notComputed(what: string, value: number): boolean {
  // volatility cannot be negative, so the reference client treats ANY negative as absent rather
  // than looking for one sentinel
  if (what === "impliedVol") return value < 0;
  const sentinel = SENTINEL[what];
  return sentinel !== undefined && value === sentinel;
}
