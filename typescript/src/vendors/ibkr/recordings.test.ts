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
      expect(conversation.ask.length + (conversation.accountReads?.length ?? 0)
        + (conversation.watches?.length ?? 0), `${name} asks for nothing`).toBeGreaterThan(0);
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
      .toThrow(/must ask for a quote, read the account or watch it/);
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

  it("reads the watches, and the replies that come LATER, at a step (ADR 0031)", () => {
    const c = loadConversation("watch-holdings-come-and-go");
    expect(c.watches).toEqual([{ wanted: null, steps: 3, end: "stop" }]);
    const pnl = c.exchanges.find((e) => e.request === "reqPnL")!;
    expect(pnl).toMatchObject({ account: "U0000000", replies: [] });
    expect(pnl.later!.map((l) => l.step)).toEqual([1, 2, 3]);
    const single = c.exchanges.find((e) => e.request === "reqPnLSingle")!;
    expect(single).toMatchObject({ account: "U0000000", conId: "100000101" });
    expect(loadConversation("account-paper").watches).toBeUndefined();
  });

  /** watch-started-and-stopped, as data, for a refusal to be made of */
  const watchFile = () => JSON.parse(readFileSync(join(RECORDINGS, "watch-started-and-stopped.json"),
    "utf8")) as {
    watches: Record<string, unknown>[];
    exchanges: { request: string; sent: string[]; replies: string[][];
      later?: { step: number; replies: string[][] }[] }[];
  };

  it("refuses a watch that does not say how many steps it takes and how it ends", () => {
    for (const watch of [{ wanted: null, steps: -1, end: "stop" }, { wanted: null, steps: 1.5,
      end: "stop" }, { wanted: null, steps: 2, end: "close" }, { wanted: 7, steps: 2, end: "stop" }]) {
      const file = { ...watchFile(), watches: [watch] };
      expect(() => parseConversation("watch-started-and-stopped", file), JSON.stringify(watch))
        .toThrow(/watches\[0\]/);
    }
  });

  it("refuses a P&L request whose message does not name its account and holding", () => {
    for (const [at, sent] of [[1, ["94", "$reqId", "U0000001", "", "100000101"]],
      [1, ["94", "$reqId", "U0000000", "", "100000999"]], [3, ["92", "$reqId", "U0000001", ""]]] as const) {
      const file = watchFile();
      file.exchanges[at]!.sent = [...sent];
      expect(() => parseConversation("watch-started-and-stopped", file), sent.join(","))
        .toThrow(/must ask for/);
    }
  });

  it("refuses a stream's figures sent at once: a replay sends them at a step", () => {
    // so the picture a watch starts with is the download's alone, whenever the client looks
    const file = watchFile();
    const pnl = file.exchanges.find((e) => e.request === "reqPnL")!;
    pnl.replies = [["94", "$reqId", "1.00", "2.00", "3.00"]];
    expect(() => parseConversation("watch-started-and-stopped", file))
      .toThrow(/a stream's figures come later/);
  });

  it("refuses a step whose last message is not the account's P&L, or past the last step", () => {
    // the replay knows a step has been read when the client has read its last P&L
    const noPnl = watchFile();
    noPnl.exchanges.find((e) => e.request === "reqPnL")!.later!.pop();
    expect(() => parseConversation("watch-started-and-stopped", noPnl))
      .toThrow(/step 2 must end with the account's P&L/);
    const after = watchFile();
    const pnl = after.exchanges.findIndex((e) => e.request === "reqPnL");
    after.exchanges.push(after.exchanges.splice(pnl, 1)[0]!, {
      ...after.exchanges[1]!, later: [{ step: 1, replies: [["95", "$reqId", "1", "", "", "", ""]] }],
    });
    expect(() => parseConversation("watch-started-and-stopped", after))
      .toThrow(/step 1 must end with the account's P&L/);
    const beyond = watchFile();
    beyond.exchanges[1]!.later!.push({ step: 3, replies: [["95", "$reqId", "1", "", "", "", ""]] });
    expect(() => parseConversation("watch-started-and-stopped", beyond))
      .toThrow(/step 3, and the watches take 2/);
  });

  it("reads steps sent BEFORE a watch's start, the last ending with its download end", () => {
    // review round 1 of #479: so a P&L that arrives before the download ends can be in the corpus
    const file = () => JSON.parse(readFileSync(join(RECORDINGS, "watch-pnl-before-download-end.json"),
      "utf8")) as { watches: Record<string, unknown>[];
      exchanges: { request: string; later?: { step: number; replies: string[][] }[] }[] };
    expect(parseConversation("watch-pnl-before-download-end", file()).watches)
      .toEqual([{ wanted: null, before: 1, steps: 1, end: "stop" }]);
    for (const before of [0, -1, 1.5]) {
      const bad = file();
      bad.watches[0]!.before = before;
      expect(() => parseConversation("watch-pnl-before-download-end", bad), String(before))
        .toThrow(/watches\[0\]\.before must be/);
    }
    // the step it starts at ends with the download end, not with the P&L
    const noEnd = file();
    noEnd.exchanges.find((e) => e.request === "reqAccountUpdates")!.later = [];
    expect(() => parseConversation("watch-pnl-before-download-end", noEnd))
      .toThrow(/step 1 must end with the download end a watch starts on/);
  });

  it("refuses a download that also ends at once, where its watch starts at a later step", () => {
    // review round 2 of #479: both clients would start on the at-once end, before the step's P&L
    const file = JSON.parse(readFileSync(join(RECORDINGS, "watch-pnl-before-download-end.json"),
      "utf8")) as { exchanges: { request: string; replies: string[][] }[] };
    file.exchanges.find((e) => e.request === "reqAccountUpdates")!.replies.push(["54", "1", "U0000000"]);
    expect(() => parseConversation("watch-pnl-before-download-end", file))
      .toThrow(/must not end the download at once: its watch starts at step 1/);
  });

  it("refuses a holding's stream answering at a step before its watch has started", () => {
    // a holding's stream is asked for only once the download ends, so such a reply never arrives
    const file = JSON.parse(readFileSync(join(RECORDINGS, "watch-pnl-before-download-end.json"),
      "utf8")) as { exchanges: { request: string; later?: { step: number; replies: string[][] }[] }[] };
    file.exchanges.find((e) => e.request === "reqPnLSingle")!.later!
      .unshift({ step: 1, replies: [["95", "$reqId", "300", "1.00", "1.00", "0.00", "1.00"]] });
    expect(() => parseConversation("watch-pnl-before-download-end", file))
      .toThrow(/a holding's stream cannot answer at step 1, before its watch has started/);
  });

  it("keeps every field as the text the wire carried, never a number", () => {
    // "4.10" and 4.1 are different bytes, and so are "2.1E-4" and 0.00021. A recording that let
    // JSON reformat a field would replay something the gateway never sent.
    for (const name of conversationNames()) {
      const c = loadConversation(name);
      const messages = [
        c.handshake.greeting, ...c.handshake.onStartApi,
        ...c.exchanges.flatMap((e) => [e.sent, ...e.replies, ...(e.onCancel ?? []),
          ...(e.later ?? []).flatMap((l) => l.replies)]),
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
      c.accountReads !== undefined || c.watches !== undefined
      || c.exchanges.some((e) => e.request !== "reqContractDetails" && e.request !== "reqMktData"));
    expect(touches.length).toBeGreaterThanOrEqual(10);
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
    // and so does a watch, or a P&L request alone (ADR 0031)
    const watch = JSON.parse(readFileSync(join(RECORDINGS, "watch-lost.json"), "utf8")) as {
      exchanges: { request: string }[];
    };
    expect(() => parseConversation("watch-lost", { ...watch, provenance: recorded }))
      .toThrow(/reads the account, so it must be constructed/);
    const pnlOnly = { ...watch, provenance: recorded, watches: undefined,
      ask: ["US.SPXW261218C8100000"],
      exchanges: watch.exchanges.filter((e) => e.request === "reqPnL")
        .map((e) => ({ ...e, later: undefined })) };
    expect(() => parseConversation("watch-lost", pnlOnly))
      .toThrow(/reads the account, so it must be constructed/);
    // and a watch alone, with no exchange that touches the account to give it away
    const watchOnly = { ...watch, provenance: recorded, exchanges: [],
      watches: [{ wanted: null, steps: 0, end: "stop" }] };
    expect(() => parseConversation("watch-lost", watchOnly))
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
  // invented figures are still held to arithmetic: a total that is not the sum of what it totals
  // is a fixture a reader would trust and should not
  const accountExchanges = () => conversationNames().flatMap((name) => loadConversation(name)
    .exchanges.filter((e) => e.request === "reqAccountUpdates").map((e) => ({ name, e })));
  const ledger = (replies: string[][], key: string) => new Map(replies
    .filter((m) => m[0] === "6" && m[2] === `$LEDGER-${key}`).map((m) => [m[4]!, Number(m[3])]));
  const plain = (replies: string[][], key: string) =>
    Number(replies.find((m) => m[0] === "6" && m[2] === key)![3]);
  /** each PORTFOLIO_VALUE row's figure at `at`, summed by the row's currency (field 10) */
  const byCurrency = (replies: string[][], at: number) => {
    const sums = new Map<string, number>();
    for (const m of replies.filter((r) => r[0] === "7")) {
      sums.set(m[10]!, (sums.get(m[10]!) ?? 0) + Number(m[at]));
    }
    return sums;
  };

  it("has the account conversations to check", () => {
    // the five the account reads hold, and the seven the watches do (ADR 0031)
    expect(accountExchanges().filter(({ e }) => ledger(e.replies, "CashBalance").has("BASE")))
      .toHaveLength(12);
  });

  it("states each BASE figure as the currencies' at their rates", () => {
    for (const { name, e } of accountExchanges()) {
      const rates = ledger(e.replies, "ExchangeRate");
      for (const key of ["CashBalance", "NetLiquidationByCurrency", "UnrealizedPnL", "RealizedPnL"]) {
        const rows = ledger(e.replies, key);
        if (!rows.has("BASE")) continue;
        let sum = 0;
        for (const [currency, amount] of rows) {
          if (currency === "BASE") continue;
          expect(rates.has(currency), `${name}: no rate for ${currency}`).toBe(true);
          sum += amount * rates.get(currency)!;
        }
        expect(rows.get("BASE")!, `${name}: BASE ${key}`).toBeCloseTo(sum, 2);
      }
      const base = (key: string) => ledger(e.replies, key).get("BASE")!;
      expect(plain(e.replies, "TotalCashValue"), `${name}: TotalCashValue`)
        .toBeCloseTo(base("CashBalance"), 2);
      expect(plain(e.replies, "NetLiquidation"), `${name}: NetLiquidation`)
        .toBeCloseTo(base("NetLiquidationByCurrency"), 2);
    }
  });

  it("keeps the ledger for every currency a holding is in", () => {
    // otherwise a holding in a currency with no `$LEDGER-` rows would be counted in no total, and
    // the sums below, which walk the ledger's currencies, would never see it
    for (const { name, e } of accountExchanges()) {
      const ledgered = new Set(ledger(e.replies, "Currency").keys());
      for (const currency of byCurrency(e.replies, 15).keys()) {
        expect(ledgered.has(currency), `${name}: a holding in ${currency}, no $LEDGER- rows for it`)
          .toBe(true);
      }
    }
  });

  it("states each currency's liquidation value as its cash and its holdings' market value", () => {
    for (const { name, e } of accountExchanges()) {
      const cash = ledger(e.replies, "CashBalance");
      const values = byCurrency(e.replies, 15);
      for (const [currency, nlv] of ledger(e.replies, "NetLiquidationByCurrency")) {
        if (currency === "BASE") continue;
        expect(nlv, `${name}: ${currency} NetLiquidationByCurrency`)
          .toBeCloseTo((cash.get(currency) ?? 0) + (values.get(currency) ?? 0), 2);
      }
    }
  });

  it("states each currency's P&L as its holdings'", () => {
    for (const { name, e } of accountExchanges()) {
      for (const [key, at] of [["UnrealizedPnL", 17], ["RealizedPnL", 18]] as const) {
        const held = byCurrency(e.replies, at);
        for (const [currency, pnl] of ledger(e.replies, key)) {
          if (currency === "BASE") continue;
          expect(pnl, `${name}: ${currency} ${key}`).toBeCloseTo(held.get(currency) ?? 0, 2);
        }
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
    const accountExchanges = c.exchanges.filter((e) => e.request === "reqAccountUpdates");
    const messages = [
      ...c.handshake.onStartApi,
      ...accountExchanges.flatMap((e) => [e.sent, ...e.replies, ...(e.onCancel ?? []),
        ...(e.later ?? []).flatMap((l) => l.replies)]),
      ...c.exchanges.filter((e) => e.request === "reqContractDetails" || e.request === "reqMktData")
        .flatMap((e) => [e.sent, ...e.replies, ...(e.onCancel ?? [])]),
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
    for (const e of c.exchanges) {
      if (e.request === "reqAccountUpdates") named.push(e.account);
      // a P&L request names its account at field 2, and its answers name none (ADR 0031)
      if (e.request === "reqPnL" || e.request === "reqPnLSingle") named.push(e.account, e.sent[2]!);
    }
    for (const r of c.accountReads ?? []) if (r.wanted !== null) named.push(r.wanted);
    for (const w of c.watches ?? []) if (w.wanted !== null) named.push(w.wanted);
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
    expect(new Set(accountsNamed("watch-several"))).toEqual(new Set(["U0000000", "U0000001",
      "DU0000001"]));
    // the accounts a later reply names are read too: a portfolio row that arrives mid-watch
    const named = accountsNamed("watch-holdings-come-and-go");
    expect(named.length).toBeGreaterThan(accountsNamed("watch-started-and-stopped").length);
  });

  it("would refuse an account that is not a placeholder", () => {
    const text = readFileSync(join(RECORDINGS, "account-paper.json"), "utf8");
    expect(text.replaceAll("DU0000000", "DU1234567").match(/\b(DU|DF|DI|U|F|I)\d{5,9}\b/g))
      .toContain("DU1234567");
  });
});
