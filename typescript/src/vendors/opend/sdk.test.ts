/** The moomoo SDK's PROTOBUF path, end to end, with no OpenD (#412).
 *
 *  `client.test.ts` fakes the SDK whole, so it proves the client's own decisions and nothing about
 *  the package: it would pass with protobufjs missing. This one runs the REAL `moomoo-api` — its
 *  generated schema (`proto.js`, on `protobufjs/light`), its `_sendCmd` encoding the request and
 *  decoding the answer with `protobufjs` itself, int64s as `long` — and replaces only the socket,
 *  one layer down, with a stub that reads the bytes it is sent and answers in bytes.
 *
 *  Written when the install moved from npm to bun, which runs no dependency's postinstall unless it
 *  is trusted, and `protobufjs`' is one it does not run. That script makes an empty
 *  `cli/node_modules` for the `pbjs` command line and warns about version schemes; neither is on
 *  this path, and this test is what says so rather than a reading of the script.
 */
import { createRequire } from "node:module";

import mmWebsocket from "moomoo-api";
import { describe, expect, it } from "vitest";

import { OpendClient } from "./client.ts";
import type { MoomooClient } from "./types.ts";

/** The SDK's own schema root: the same module its `main.js` imports. */
const proto = createRequire(import.meta.url)("moomoo-api/proto.js");

/** Qot_GetSecuritySnapshot, as the SDK's command table numbers it. */
const SNAPSHOT_CMD = 3203;

interface PbType {
  fieldsArray: { name: string; type: string; required: boolean; resolve(): void; resolvedType: unknown }[];
  create(value: object): object;
  encode(message: object): { finish(): Uint8Array };
  decode(bytes: Uint8Array): object;
  toObject(message: object, options: object): Record<string, unknown>;
}

/** A message with every REQUIRED field present: proto2's decoder refuses one that is missing, and
 *  OpenD fills them all, so an answer without them would be a stub no gateway sends. */
function filled(typeName: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  const type = proto.lookupType(typeName) as PbType;
  const out: Record<string, unknown> = {};
  for (const field of type.fieldsArray) {
    if (!field.required) continue;
    field.resolve();
    const nested = field.resolvedType as { fullName?: string; values?: Record<string, number> } | null;
    if (nested?.values) out[field.name] = Object.values(nested.values)[0];
    else if (nested?.fullName) out[field.name] = filled(nested.fullName.slice(1));
    else out[field.name] = field.type === "string" ? "" : field.type === "bool" ? false : 0;
  }
  for (const [key, value] of Object.entries(values)) {
    const base = out[key];
    out[key] = base && typeof base === "object" && value && typeof value === "object" && !Array.isArray(value)
      ? { ...base, ...value }
      : value;
  }
  return out;
}

/** The SDK's inner socket: `sendBuff(cmd, bytes)` resolving to `{buff}`, as `base.js`' does. */
function stubSocket(answer: (cmd: number, request: Record<string, unknown>) => Record<string, unknown>) {
  const asked: { cmd: number; request: Record<string, unknown> }[] = [];
  const socket = {
    sendBuff(cmd: number, bytes: Uint8Array) {
      const Request = proto.lookupType("Qot_GetSecuritySnapshot.Request") as PbType;
      const request = Request.toObject(Request.decode(bytes), { defaults: false });
      asked.push({ cmd, request });
      const Response = proto.lookupType("Qot_GetSecuritySnapshot.Response") as PbType;
      const reply = answer(cmd, request);
      return Promise.resolve({ buff: Response.encode(Response.create(reply)).finish() });
    },
    close() {},
    unregPushCallback() {},
  };
  return { socket, asked };
}

/** The real SDK object, logged in to the stub: `start` is the one method that opens a socket. */
function sdkOn(socket: object): () => MoomooClient {
  return () => {
    const client = new mmWebsocket();
    client.start = () => {
      (client as unknown as { websock: object }).websock = socket;
      queueMicrotask(() => client.onlogin?.(true, "stub"));
    };
    return client;
  };
}

const CODE = "US.SPXW261218C8100000";

describe("the moomoo SDK, encoding and decoding through protobufjs", () => {
  it("sends the batch as a Qot_GetSecuritySnapshot request and reads the answer back", async () => {
    const { socket, asked } = stubSocket((_cmd, request) => {
      const [security] = (request.c2s as { securityList: { market: number; code: string }[] }).securityList;
      return {
        retType: 0,
        s2c: {
          snapshotList: [filled("Qot_GetSecuritySnapshot.Snapshot", {
            basic: filled("Qot_GetSecuritySnapshot.SnapshotBasicData", {
              security, curPrice: 41.5, bidPrice: 41.2, askPrice: 41.8, volume: 1234,
            }),
            optionExData: filled("Qot_GetSecuritySnapshot.OptionSnapshotExData", {
              strikePrice: 8100, delta: 0.31, impliedVolatility: 14.2,
            }),
          })],
        },
      };
    });
    const client = new OpendClient({ host: "stub", port: 0, key: "k", create: sdkOn(socket) });

    const { records, unknown } = await client.batch([CODE]);

    expect(asked).toEqual([{
      cmd: SNAPSHOT_CMD,
      request: { c2s: { securityList: [{ market: 11, code: "SPXW261218C8100000" }] } },
    }]);
    expect(unknown).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: CODE, last_price: 41.5, bid_price: 41.2, ask_price: 41.8, volume: 1234,
      option_delta: 0.31, option_implied_volatility: 14.2, option_strike_price: 8100,
    });
  });

  it("decodes a refusal into moomoo's own words, which the client's containment reads", async () => {
    const { socket } = stubSocket(() => ({ retType: -1, retMsg: "Unknown stock SPXW261218C8100000." }));
    const client = new OpendClient({ host: "stub", port: 0, key: "k", create: sdkOn(socket) });

    // the SDK rejects with the decoded `{retType, retMsg}`; the client names the culprit unknown
    await expect(client.batch([CODE])).resolves.toEqual({ records: [], unknown: [CODE] });
  });
});
