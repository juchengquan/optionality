/** IB Gateway conversations, recorded once and replayed to two clients (ADR 0021, Decision 7).
 *
 *  The files live in `testdata/vendors/ibkr-gateway/`, outside this package, because they belong
 *  to neither language: the TypeScript stub in `fake.ts` replays them to this client, and a Python
 *  stub replays the same files to `ib_async`. Holding both clients to one quote batch per
 *  recording is how a hand-written client and a third-party one are kept answering alike.
 *
 *  ## Why every field is a string
 *
 *  The wire is text, and the text is the fact: "4.10" is not 4.1 on the wire, and "2.1E-4" is
 *  not 0.00021. A recording that let JSON re-spell a field would replay something the gateway
 *  never sent, so `parseConversation` refuses anything but strings where a field goes.
 *
 *  ## Why provenance is required rather than encouraged
 *
 *  The stub these files replaced carried two greeks invented under a comment claiming
 *  measurement, and a contract reply cut to the fifteen fields this client reads, which is why
 *  `ib_async` could not decode it. So a file must say which it is — `recorded`, with when, from
 *  which gateway and how, or `constructed`, with why it could not be recorded and what it was
 *  built from — and a file that says neither does not load.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the recordings are, from this file. */
export const RECORDINGS = join(import.meta.dirname, "../../../../testdata/vendors/ibkr-gateway");

/** Stands for the id of the request a reply answers, which is whoever is asking's to choose. Every
 *  occurrence in a reply is replaced, inside text too: the gateway's error 300 names the id. */
export const REQ_ID = "$reqId";

/** One message: its fields, in order, each exactly the text the wire carried. */
export type Message = string[];

/** The contract fields a request is matched on, which are the ones that change the answer. */
export const CONTRACT_KEYS = [
  "symbol", "secType", "lastTradeDateOrContractMonth", "strike", "right", "exchange",
  "tradingClass",
] as const;
export type ContractKey = (typeof CONTRACT_KEYS)[number];

/** Where a market-data request says whether it asks for a snapshot ("1") or a stream ("0"): field
 *  17 of reqMktData version 11, from this client and from `ib_async` alike at protocol 157. A
 *  stub matches on it as well as on the contract, because the two are different questions — a
 *  snapshot of SPX carries no price at all, and its stream does (`index-in-the-session`). */
export const SNAPSHOT_AT = 17;

/** One request and everything the gateway sent because of it.
 *
 *  Several exchanges for the same request and contract answer in TURN, the last one every request
 *  after it (`fake.ts`). That is how a file says "answered once, silent after", which is what a
 *  link dropping between two asks looks like; a file holding one per request is unchanged by it.
 */
export interface QuoteExchange {
  request: "reqContractDetails" | "reqMktData";
  contract: Record<ContractKey, string>;
  /** What the recording session sent, for the reader. A replay matches on `contract`, and for
   *  market data on one field of this too: `SNAPSHOT_AT`, a snapshot or a stream. */
  sent: Message;
  /** in the order they arrived; empty is a request accepted and never answered */
  replies: Message[];
  /** each reply's arrival after the request, in ms, where it was measured. A replay ignores it */
  atMs: number[];
  /** what the gateway said to cancelMktData for this request, if anything */
  onCancel?: Message[];
}

/** One account subscription and everything the gateway sent because of it (ADR 0030). Matched on
 *  the account the subscribe names (`ACCOUNT_AT`), since the account's messages carry no request
 *  id; `onCancel` is what the gateway said to the unsubscribe. */
export interface AccountExchange {
  request: "reqAccountUpdates";
  account: string;
  sent: Message;
  replies: Message[];
  atMs: number[];
  onCancel?: Message[];
}

export type Exchange = QuoteExchange | AccountExchange;

/** Where reqAccountUpdates says whether it subscribes ("1") or stops ("0"), and which account it
 *  names: version 2, from this client and `ib_async` alike. */
export const SUBSCRIBE_AT = 2;
export const ACCOUNT_AT = 3;

/** The account ids a recording may carry, each the SHAPE of a real one (a prefix and seven digits)
 *  and none anybody's: the owner's are never committed (ADR 0030; the repository is public). */
export const PLACEHOLDER_ACCOUNTS = ["DU0000000", "DU0000001", "U0000000", "U0000001"] as const;

export interface Recorded {
  kind: "recorded";
  at: string;
  gateway: string;
  protocol: number;
  how: string;
  [more: string]: unknown;
}

export interface Constructed {
  kind: "constructed";
  why: string;
  built: string;
  [more: string]: unknown;
}

export interface Conversation {
  conversation: string;
  summary: string;
  provenance: Recorded | Constructed;
  /** the service codes the client is asked to price, in this order; empty for a conversation that
   *  only reads the account */
  ask: string[];
  /** Asks made after `ask` by the SAME client, in order, so the connection and whatever the client
   *  cached on earlier asks carry over. Absent for the usual conversation of one ask. It exists
   *  because a fresh connection cannot show a silence met behind a warm conid cache, and that is
   *  where the service meets one: it holds its session open for days. */
  later?: string[][];
  /** Account reads made after the asks by the SAME client, in order, each naming the account it
   *  wants or none (ADR 0030). Absent for a quote fetch's conversation. */
  accountReads?: { wanted: string | null }[];
  handshake: {
    /** the gateway's answer to the version range: its protocol version, then its clock */
    greeting: Message;
    /** everything it sends once startApi arrives, in order */
    onStartApi: Message[];
  };
  exchanges: Exchange[];
}

/** Every recording, by name, sorted. */
export function conversationNames(): string[] {
  return readdirSync(RECORDINGS).filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")).sort();
}

export function loadConversation(name: string): Conversation {
  const text = readFileSync(join(RECORDINGS, `${name}.json`), "utf8");
  return parseConversation(name, JSON.parse(text));
}

/** The request's own id, wherever the recording left a place for it. */
export function fill(message: Message, reqId: number | string): Message {
  return message.map((field) => field.replaceAll(REQ_ID, String(reqId)));
}

/** A conversation, or a refusal that says which part of the file is wrong.
 *
 *  Checked rather than cast: the file is hand-assembled from captures, and a field that became a
 *  number, or a provenance that went missing, should fail where it is read rather than replay as
 *  something nobody recorded.
 */
export function parseConversation(name: string, value: unknown): Conversation {
  const fail = (what: string): never => {
    throw new Error(`testdata/vendors/ibkr-gateway/${name}.json: ${what}`);
  };
  const object = (v: unknown, where: string): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? v as Record<string, unknown> : fail(`${where} must be an object`);
  const text = (v: unknown, where: string): string =>
    typeof v === "string" && v.length > 0 ? v : fail(`${where} must be a non-empty string`);
  const message = (v: unknown, where: string): Message =>
    Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === "string")
      ? v as Message : fail(`${where} must be a list of fields, every one a string`);
  const messages = (v: unknown, where: string): Message[] => Array.isArray(v)
    ? v.map((m, i) => message(m, `${where}[${i}]`)) : fail(`${where} must be a list`);

  const c = object(value, "the file");
  if (c.conversation !== name) fail(`"conversation" must be its own name, "${name}"`);

  const p = object(c.provenance, "provenance");
  if (p.kind === "recorded") {
    text(p.at, "provenance.at");
    text(p.gateway, "provenance.gateway");
    text(p.how, "provenance.how");
    if (typeof p.protocol !== "number") fail("provenance.protocol must be a number");
  } else if (p.kind === "constructed") {
    text(p.why, "provenance.why");
    text(p.built, "provenance.built");
  } else {
    fail('provenance.kind must be "recorded" or "constructed"');
  }

  const ask = Array.isArray(c.ask) && c.ask.every((code) => typeof code === "string")
    ? c.ask as string[] : fail("ask must be a list of codes");
  const codes = (v: unknown) => Array.isArray(v) && v.length > 0
    && v.every((code) => typeof code === "string");
  const later = c.later === undefined || (Array.isArray(c.later) && c.later.every(codes))
    ? c.later as string[][] | undefined
    : fail("later must be a list of asks, each a list of codes");
  const h = object(c.handshake, "handshake");
  const greeting = message(h.greeting, "handshake.greeting");
  if (!Number.isInteger(Number(greeting[0]))) fail("handshake.greeting[0] must be a version");

  const reads = c.accountReads === undefined ? undefined : Array.isArray(c.accountReads)
    ? c.accountReads.map((r, i) => {
      const read = object(r, `accountReads[${i}]`);
      if (read.wanted !== null && typeof read.wanted !== "string") {
        fail(`accountReads[${i}].wanted must be an account or null`);
      }
      return { wanted: read.wanted as string | null };
    })
    : fail("accountReads must be a list");
  if (ask.length === 0 && (reads === undefined || reads.length === 0)) {
    fail("a conversation must ask for a quote or read the account");
  }

  const exchanges = Array.isArray(c.exchanges)
    ? c.exchanges.map((e, i): Exchange => {
      const where = `exchanges[${i}]`;
      const x = object(e, where);
      const replies = messages(x.replies, `${where}.replies`);
      const atMs = Array.isArray(x.atMs) && x.atMs.every((t) => typeof t === "number")
        ? x.atMs as number[] : fail(`${where}.atMs must be a list of numbers`);
      if (atMs.length !== 0 && atMs.length !== replies.length) {
        fail(`${where}.atMs must time every reply or none`);
      }
      const sent = message(x.sent, `${where}.sent`);
      const onCancel = x.onCancel === undefined
        ? {} : { onCancel: messages(x.onCancel, `${where}.onCancel`) };
      if (x.request === "reqAccountUpdates") {
        const account = text(x.account, `${where}.account`);
        if (sent[0] !== "6" || sent[SUBSCRIBE_AT] !== "1" || sent[ACCOUNT_AT] !== account) {
          fail(`${where}.sent must subscribe to ${account}, as reqAccountUpdates does`);
        }
        return { request: "reqAccountUpdates", account, sent, replies, atMs, ...onCancel };
      }
      if (x.request !== "reqContractDetails" && x.request !== "reqMktData") {
        fail(`${where}.request must be reqContractDetails, reqMktData or reqAccountUpdates`);
      }
      const contract = object(x.contract, `${where}.contract`);
      for (const key of CONTRACT_KEYS) {
        if (typeof contract[key] !== "string") fail(`${where}.contract.${key} must be a string`);
      }
      if (x.request === "reqMktData" && sent[SNAPSHOT_AT] !== "0" && sent[SNAPSHOT_AT] !== "1") {
        fail(`${where}.sent[${SNAPSHOT_AT}] must say whether it asked for a snapshot, "1" or "0"`);
      }
      return {
        request: x.request as QuoteExchange["request"],
        contract: contract as Record<ContractKey, string>,
        sent,
        replies, atMs,
        ...onCancel,
      };
    })
    : fail("exchanges must be a list");

  return {
    conversation: name,
    summary: text(c.summary, "summary"),
    provenance: p as unknown as Recorded | Constructed,
    ask,
    ...(later === undefined ? {} : { later }),
    ...(reads === undefined ? {} : { accountReads: reads }),
    handshake: { greeting, onStartApi: messages(h.onStartApi, "handshake.onStartApi") },
    exchanges,
  };
}
