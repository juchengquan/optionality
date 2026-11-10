import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RECORDINGS, conversationNames, loadConversation, parseConversation } from "./recordings.ts";

/** The recorded gateway conversations under `testdata/vendors/ibkr-gateway/` (ADR 0021, phase 1d).
 *
 *  Two stubs will replay these files, the TypeScript's and a Python one for `ib_async`, so what
 *  is checked here is what both depend on: the files parse into one shape, each says where every
 *  reply came from, and nothing in them is the owner's.
 */

describe("the conversations", () => {
  it("holds the six ADR 0021 names, at least", () => {
    expect(conversationNames()).toEqual(expect.arrayContaining([
      "normal-with-greeks", "unknown-contract", "link-down", "unentitled-account",
      "feed-held-elsewhere", "never-answers",
    ]));
  });

  it("parses every file into the one shape both stubs read", () => {
    for (const name of conversationNames()) {
      const conversation = loadConversation(name);
      expect(conversation.conversation, `${name}.json names itself`).toBe(name);
      expect(conversation.ask.length, `${name} asks for nothing`).toBeGreaterThan(0);
    }
  });

  it("reads the asks made LATER on the same connection, where a file has them", () => {
    // a link that drops between two asks is met behind a warm conid cache, which one ask on a
    // fresh connection can never show
    expect(loadConversation("link-down-between-asks").later)
      .toEqual([["US.SPXW261218C8100000"]]);
    expect(loadConversation("normal-with-greeks").later).toBeUndefined();
  });

  it("refuses later asks that are not a list of lists of codes", () => {
    const text = readFileSync(join(RECORDINGS, "normal-with-greeks.json"), "utf8");
    for (const later of [["US.SPXW261218C8100000"], [[]], [[8100]], "again"]) {
      const file = { ...JSON.parse(text) as object, later };
      expect(() => parseConversation("normal-with-greeks", file), JSON.stringify(later))
        .toThrow(/later must be a list of asks/);
    }
  });

  it("refuses a market-data exchange that does not say whether it asked for a snapshot", () => {
    // a stub answers a snapshot only with a snapshot and a stream only with a stream, so a file
    // that does not say which would answer neither, or both
    const text = readFileSync(join(RECORDINGS, "normal-with-greeks.json"), "utf8");
    const file = JSON.parse(text) as { exchanges: { request: string; sent: string[] }[] };
    const data = file.exchanges.find((e) => e.request === "reqMktData")!;
    for (const flag of ["", "true", undefined]) {
      data.sent = data.sent.slice(0, 17).concat(flag === undefined ? [] : [flag, "0", ""]);
      expect(() => parseConversation("normal-with-greeks", file), String(flag))
        .toThrow(/sent\[17\] must say whether it asked for a snapshot/);
    }
  });

  it("keeps every field as the text the wire carried, never a number", () => {
    // "4.10" and 4.1 are different bytes, and so are "2.1E-4" and 0.00021. A recording that let
    // JSON reformat a field would replay something the gateway never sent.
    for (const name of conversationNames()) {
      const c = loadConversation(name);
      const messages = [
        c.handshake.greeting, ...c.handshake.onStartApi,
        ...c.exchanges.flatMap((e) => [e.sent, ...e.replies, ...(e.onCancel ?? [])]),
      ];
      for (const m of messages) {
        expect(m.every((f) => typeof f === "string"), `${name}: ${JSON.stringify(m)}`).toBe(true);
      }
    }
  });
});

describe("provenance, which is the point of the files", () => {
  // An invented fixture under a comment claiming measurement is a bug this project has had once
  // (two greeks in `fake.ts`, #204). So a recording must say how it was taken, and a construction
  // must say why it could not be recorded — both checked, neither trusted.
  it("says when, from which gateway and how, for every RECORDED conversation", () => {
    const recorded = conversationNames().map(loadConversation)
      .filter((c) => c.provenance.kind === "recorded");
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    for (const c of recorded) {
      if (c.provenance.kind !== "recorded") continue;
      expect(c.provenance.at, c.conversation).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(c.provenance.gateway, c.conversation).toMatch(/IB Gateway \d+\.\d+/);
      expect(c.provenance.protocol, c.conversation).toBe(Number(c.handshake.greeting[0]));
      expect(c.provenance.how, c.conversation).toBeTruthy();
    }
  });

  it("says why, and what it was built from, for every CONSTRUCTED one", () => {
    for (const c of conversationNames().map(loadConversation)) {
      if (c.provenance.kind !== "constructed") continue;
      expect(c.provenance.why, c.conversation).toBeTruthy();
      expect(c.provenance.built, c.conversation).toBeTruthy();
    }
  });

  it("refuses a file that does not say which it is", () => {
    const text = readFileSync(join(RECORDINGS, "normal-with-greeks.json"), "utf8");
    const unlabelled = JSON.parse(text) as { provenance: Record<string, unknown> };
    delete unlabelled.provenance.kind;
    expect(() => parseConversation("normal-with-greeks", unlabelled))
      .toThrow(/provenance\.kind must be "recorded" or "constructed"/);
  });
});

describe("nothing of the owner's", () => {
  it("carries the placeholder account wherever the gateway named one", () => {
    // managedAccounts is the one reply that names the owner. The number is replaced before a
    // capture reaches disk, and this is what notices if a new capture forgets.
    for (const name of conversationNames()) {
      const c = loadConversation(name);
      const accounts = c.handshake.onStartApi.filter((m) => m[0] === "15").map((m) => m[2]);
      for (const a of accounts) expect(a, name).toBe("DU0000000");
      const raw = readFileSync(join(RECORDINGS, `${name}.json`), "utf8");
      expect(raw.match(/\b(DU|DF|U)\d{5,8}\b/g)?.filter((a) => a !== "DU0000000") ?? [], name)
        .toEqual([]);
    }
  });
});
