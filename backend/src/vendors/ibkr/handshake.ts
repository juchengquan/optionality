/** The greeting: what we say first, what comes back, and which gateways we refuse.
 *
 *  Pure, so the negotiation can be tested without a socket — the same split `first-contact.ts`
 *  uses, and for the same reason: the I/O needs a real gateway, the decisions do not.
 */
import { MIN_SERVER_VERSION, frame, toFields } from "./wire.ts";

/** The newest protocol this client has been CHECKED against, not the newest that exists.
 *
 *  The gateway answers with `min(its version, our maximum)`, so capping here pins the layout we
 *  decode. The alternative — advertising whatever IBKR might ship — means a gateway upgrade
 *  silently moves the wire format under a decoder nobody re-read, which is the one failure in
 *  this protocol that produces plausible wrong numbers instead of an error.
 *
 *  Raising it is a deliberate act: re-read the reference client's decoder for every message in
 *  `messages.ts`, then raise it, in that order. 157 is what the gateway on this machine speaks
 *  and what the probes of 2026-11-08 were decoded against.
 */
export const MAX_SERVER_VERSION = 157;

/** Sent before anything else: the prefix is raw, and only the version range is framed. */
export function greeting(): Buffer {
  return Buffer.concat([
    Buffer.from("API\0", "ascii"),
    frame(`v${MIN_SERVER_VERSION}..${MAX_SERVER_VERSION}`),
  ]);
}

export interface Greeted {
  serverVersion: number;
  /** the gateway's own clock, as it reports it — kept because it is the only thing the gateway
   *  says about itself before a request, and a wrong one has explained a bad session before */
  connectionTime: string;
}

/** What the gateway said back, or why we will not speak to it.
 *
 *  Refusing an old gateway is the point. Below 156 the greeks message carries a version field and
 *  no `tickAttrib`, so the SAME BYTES mean different things — and there is no gateway here that
 *  can produce that layout, so a decoder for it could never be tested. An untested decode path
 *  for the one field every rule watches is worse than no support at all.
 */
export function readGreeting(fields: readonly string[]): Greeted {
  if (fields.length < 2) {
    throw new Error(`IB Gateway's greeting had ${fields.length} field(s), expected 2`);
  }
  const serverVersion = Number(fields[0]);
  if (!Number.isInteger(serverVersion)) {
    throw new Error(`IB Gateway reported a server version that is not a number: ${fields[0]}`);
  }
  if (serverVersion < MIN_SERVER_VERSION) {
    throw new Error(
      `IB Gateway speaks protocol ${serverVersion}; this client needs ${MIN_SERVER_VERSION} or `
      + "newer, because the greeks message changes shape below it",
    );
  }
  return { serverVersion, connectionTime: fields[1] ?? "" };
}

/** Message 71: the only thing that must follow the greeting before a request is allowed.
 *
 *  The client id identifies this connection, and IB Gateway permits ONE connection per id — so a
 *  second process using the same number silently displaces the first. The service, `make serve`
 *  and the first-contact harness therefore each carry their own (see `env.ts`).
 */
export function startApi(clientId: number): string {
  const START_API = 71, VERSION = 2;
  // the trailing field is optional capabilities, which this client asks for none of. It is sent
  // empty rather than omitted: above protocol 72 the gateway expects the field to be there.
  return toFields([START_API, VERSION, clientId, ""]);
}
