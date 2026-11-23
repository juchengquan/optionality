/** The IB Gateway corpus holds what the TypeScript client makes of every recorded conversation.
 *
 *  ADR 0021 holds two IB Gateway clients together — this one, hand-written, and the Python's,
 *  built on `ib_async` — by "the same recording in, the same quote batch out". The recordings are
 *  `testdata/vendors/ibkr-gateway/*.json`; the batch this client produces from each is generated
 *  into `expected/` by `make cases`. This is `vendors.test.ts`'s job for that corpus: the files are
 *  current, and no recording is without one, because a recording nothing is expected of holds the
 *  second client to nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GATEWAY_CASES, conversationNames, expectations } from "../vendors/ibkr/replay.ts";

const ROOT = join(import.meta.dirname, "../../..");
const EXPECTED = join(ROOT, GATEWAY_CASES, "expected");

describe("testdata/vendors/ibkr-gateway/expected/", () => {
  let built: Record<string, string> = {};
  // every conversation is replayed through a real loopback socket, the silent ones until the
  // client's request timeout, so this is the one slow fixture in the corpus guards
  beforeAll(async () => { built = await expectations(); }, 30_000);

  it("holds exactly what the client makes of each recording now — run `make cases` if not", () => {
    const stale = Object.entries(built)
      .filter(([name, text]) => {
        const path = join(EXPECTED, `${name}.json`);
        return !existsSync(path) || readFileSync(path, "utf8") !== text;
      })
      .map(([name]) => `expected/${name}.json`);
    expect(stale).toEqual([]);
  });

  it("has an expectation for every recording", () => {
    // the coverage guard: a conversation added with no expected batch is a recording the Python
    // client is held to by nothing — the corpus would grow and the agreement would not
    const files = existsSync(EXPECTED) ? readdirSync(EXPECTED) : [];
    const missing = conversationNames().filter((name) => !files.includes(`${name}.json`));
    expect(missing, "a recording with no expectation — run `make cases`").toEqual([]);
    expect(conversationNames().length, "no recordings found at all").toBeGreaterThanOrEqual(6);
  });

  it("holds no expectation for a recording that does not exist", () => {
    const files = existsSync(EXPECTED)
      ? readdirSync(EXPECTED).filter((f) => f.endsWith(".json")) : [];
    const names = new Set(conversationNames());
    expect(files.filter((f) => !names.has(f.replace(/\.json$/, "")))).toEqual([]);
  });

  it("records the answers the corpus exists for", () => {
    // ADR 0021 rejected holding the two clients by field mapping alone because it "lets a silent
    // gateway become 'every contract unknown' in one language, which quarantines rules". So the
    // silent conversations must expect a THROW, and an unknown contract must expect an unknown.
    const expectOf = (name: string) => (JSON.parse(built[name]!) as { expect: unknown }).expect;
    for (const name of ["link-down", "unentitled-account", "feed-held-elsewhere"]) {
      expect(expectOf(name), name).toEqual({ $throws: expect.stringMatching(/answered none/) });
    }
    expect(expectOf("unknown-contract")).toMatchObject({ unknown: ["US.SPXW261218C8101000"] });
    // and the same silence met on a LATER ask, behind a conid cached by the first: the first ask
    // priced, the second thrown, whatever the cache holds — never an empty batch
    const between = JSON.parse(built["link-down-between-asks"]!) as {
      expect: { records: unknown[] }; later: { ask: string[]; expect: unknown }[];
    };
    expect(between.expect.records).toHaveLength(1);
    expect(between.later).toEqual([{
      ask: ["US.SPXW261218C8100000"], expect: { $throws: expect.stringMatching(/answered none/) },
    }]);
    // the silent contract is neither priced nor unknown: it may exist
    expect(expectOf("never-answers")).toMatchObject({ unknown: [] });
    expect((expectOf("never-answers") as { records: unknown[] }).records).toHaveLength(1);
    // and a normal answer carries the greeks, in the service's units
    const [normal] = (expectOf("normal-with-greeks") as { records: Record<string, number>[] })
      .records;
    expect(normal!.option_implied_volatility).toBeCloseTo(13.7956582, 7);
  });

  it("records the account reads, their answers, refusals and messages (ADR 0030)", () => {
    type Read = { wanted: string | null; expect: Record<string, unknown>; sent: string[][] };
    const readsOf = (name: string) =>
      (JSON.parse(built[name]!) as { accountReads: Read[] }).accountReads;
    const subscribed = (account: string) => [["6", "2", "1", account], ["6", "2", "0", account]];
    const [stocks] = readsOf("account-stocks-and-options");
    expect(stocks!.expect).toMatchObject({ account: "U••••000", paper: false, base_currency: "USD" });
    expect(stocks!.sent).toEqual(subscribed("U0000000"));
    expect(readsOf("account-paper")[0]!.expect).toMatchObject({ paper: true });
    // a download end that never comes is a failure, and still unsubscribes
    const [never] = readsOf("account-never-ends");
    expect(never!.expect).toEqual({ $throws: expect.stringMatching(/did not finish sending/) });
    expect(never!.sent).toEqual(subscribed("U0000000"));
    // several accounts: refused unasked, read when named, refused when named wrong; a refusal
    // subscribes to nothing
    const several = readsOf("account-several");
    expect(several.map((r) => Object.keys(r.expect))).toEqual([["$refused"], expect.arrayContaining(
      ["account", "totals", "holdings"]), ["$refused"]]);
    expect(several.map((r) => r.sent)).toEqual([[], subscribed("U0000001"), []]);
  });
});
