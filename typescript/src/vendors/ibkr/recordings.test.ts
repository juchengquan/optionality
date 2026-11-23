import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_ACCOUNTS, RECORDINGS, conversationNames, loadConversation, parseConversation,
} from "./recordings.ts";

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
      expect(conversation.ask.length + (conversation.accountReads?.length ?? 0),
        `${name} asks for nothing`).toBeGreaterThan(0);
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

  it("reads the account reads, where a file has them (ADR 0030)", () => {
    expect(loadConversation("account-several").accountReads)
      .toEqual([{ wanted: null }, { wanted: "U0000001" }, { wanted: "DU0000001" }]);
    expect(loadConversation("normal-with-greeks").accountReads).toBeUndefined();
  });

  it("refuses a conversation that neither asks for a quote nor reads the account", () => {
    const text = readFileSync(join(RECORDINGS, "account-paper.json"), "utf8");
    const file = { ...JSON.parse(text) as object, accountReads: [] };
    expect(() => parseConversation("account-paper", file))
      .toThrow(/must ask for a quote or read the account/);
  });

  it("refuses an account exchange whose subscribe does not name its account", () => {
    const text = readFileSync(join(RECORDINGS, "account-paper.json"), "utf8");
    for (const sent of [["6", "2", "1", "DU0000001"], ["6", "2", "0", "DU0000000"]]) {
      const file = JSON.parse(text) as { exchanges: { sent: string[] }[] };
      file.exchanges[0]!.sent = sent;
      expect(() => parseConversation("account-paper", file), sent.join(","))
        .toThrow(/must subscribe to DU0000000/);
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

  it("holds every conversation that touches the account to CONSTRUCTED (ADR 0030)", () => {
    // the repository is public: a capture of the owner's account is read on the owner's machine
    // and deleted, never committed, so a file that reads the account and says it was recorded is
    // either mislabelled or the thing ADR 0030 forbids
    const touches = conversationNames().map(loadConversation).filter((c) =>
      c.accountReads !== undefined || c.exchanges.some((e) => e.request === "reqAccountUpdates"));
    expect(touches.length).toBeGreaterThanOrEqual(4);
    for (const c of touches) expect(c.provenance.kind, c.conversation).toBe("constructed");
  });

  it("refuses an account conversation that says it was recorded", () => {
    const text = readFileSync(join(RECORDINGS, "account-paper.json"), "utf8");
    const recorded = { kind: "recorded", at: "2026-11-23T13:00:00Z", how: "a capture",
      gateway: "IB Gateway 10.52", protocol: 157 };
    const withReads = { ...JSON.parse(text) as object, provenance: recorded };
    expect(() => parseConversation("account-paper", withReads))
      .toThrow(/reads the account, so it must be constructed/);
    // an account exchange alone is enough: the quote asks around it change nothing
    const exchangeOnly = { ...withReads, accountReads: undefined, ask: ["US.SPXW261218C8100000"] };
    expect(() => parseConversation("account-paper", exchangeOnly))
      .toThrow(/reads the account, so it must be constructed/);
  });

  it("refuses a file that does not say which it is", () => {
    const text = readFileSync(join(RECORDINGS, "normal-with-greeks.json"), "utf8");
    const unlabelled = JSON.parse(text) as { provenance: Record<string, unknown> };
    delete unlabelled.provenance.kind;
    expect(() => parseConversation("normal-with-greeks", unlabelled))
      .toThrow(/provenance\.kind must be "recorded" or "constructed"/);
  });
});

describe("a constructed account that adds up", () => {
  // invented figures are still held to arithmetic: a BASE cash that is not the sum of the
  // currencies' cash at their own rates is a fixture a reader would trust and should not
  it("states a BASE cash, and a TotalCashValue, that are each currency's cash at its rate", () => {
    for (const name of conversationNames()) {
      for (const e of loadConversation(name).exchanges) {
        if (e.request !== "reqAccountUpdates") continue;
        const ledger = (key: string) => new Map(e.replies
          .filter((m) => m[0] === "6" && m[2] === `$LEDGER-${key}`)
          .map((m) => [m[4]!, Number(m[3])]));
        const cash = ledger("CashBalance");
        const rates = ledger("ExchangeRate");
        if (!cash.has("BASE")) continue;
        let sum = 0;
        for (const [currency, amount] of cash) {
          if (currency === "BASE") continue;
          expect(rates.has(currency), `${name}: no rate for ${currency}`).toBe(true);
          sum += amount * rates.get(currency)!;
        }
        expect(cash.get("BASE")!, `${name}: BASE cash`).toBeCloseTo(sum, 2);
        const total = e.replies.find((m) => m[0] === "6" && m[2] === "TotalCashValue");
        expect(Number(total![3]), `${name}: TotalCashValue`).toBeCloseTo(sum, 2);
      }
    }
  });
});

describe("nothing of the owner's", () => {
  /** Every account id a conversation names, wherever a message carries one: managedAccounts'
   *  list, an account value's account (and AccountCode's value, which is the id itself), a
   *  portfolio row's, the download end's, an account exchange's and its subscribe's, and the
   *  account a read asks for. */
  function accountsNamed(name: string): string[] {
    const c = loadConversation(name);
    const messages = [
      ...c.handshake.onStartApi,
      ...c.exchanges.flatMap((e) => [e.sent, ...e.replies, ...(e.onCancel ?? [])]),
    ];
    const named: string[] = [];
    for (const m of messages) {
      if (m[0] === "15") named.push(...(m[2] ?? "").split(",").filter(Boolean));
      if (m[0] === "6" && m.length === 6) {          // an account value, not a subscribe
        named.push(m[5]!);
        if (m[2] === "AccountCode") named.push(m[3]!);
      }
      if (m[0] === "6" && m.length === 4) named.push(m[3]!);  // reqAccountUpdates
      if (m[0] === "7") named.push(m[19]!);
      if (m[0] === "54") named.push(m[2]!);
    }
    for (const e of c.exchanges) if (e.request === "reqAccountUpdates") named.push(e.account);
    for (const r of c.accountReads ?? []) if (r.wanted !== null) named.push(r.wanted);
    return named;
  }

  it("carries only placeholder accounts wherever the gateway, or a read, named one", () => {
    // managedAccounts used to be the one reply that named the owner; since ADR 0030 every
    // account message does. The number is never committed, and this is what notices if a
    // conversation built from a capture forgets.
    const placeholders = new Set<string>(PLACEHOLDER_ACCOUNTS);
    for (const name of conversationNames()) {
      const named = accountsNamed(name);
      expect(named.filter((a) => !placeholders.has(a)), name).toEqual([]);
      const raw = readFileSync(join(RECORDINGS, `${name}.json`), "utf8");
      expect(raw.match(/\b(DU|DF|DI|U|F|I)\d{5,9}\b/g)?.filter((a) => !placeholders.has(a)) ?? [],
        name).toEqual([]);
    }
  });

  it("finds the account in every message that carries one, so the check above has a subject", () => {
    // read off a conversation that holds each kind, so a reader that stopped looking at one
    // would be seen here rather than passing everything
    expect(new Set(accountsNamed("account-several"))).toEqual(new Set(["U0000000", "U0000001",
      "DU0000001"]));
    expect(accountsNamed("account-stocks-and-options").length).toBeGreaterThan(20);
  });

  it("would refuse an account that is not a placeholder", () => {
    const text = readFileSync(join(RECORDINGS, "account-paper.json"), "utf8");
    expect(text.replaceAll("DU0000000", "DU1234567").match(/\b(DU|DF|DI|U|F|I)\d{5,9}\b/g))
      .toContain("DU1234567");
  });
});
