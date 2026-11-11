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
export interface Exchange {
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
  /** the service codes the client is asked to price, in this order */
  ask: string[];
  /** Asks made after `ask` by the SAME client, in order, so the connection and whatever the client
   *  cached on earlier asks carry over. Absent for the usual conversation of one ask. It exists
   *  because a fresh connection cannot show a silence met behind a warm conid cache, and that is
   *  where the service meets one: it holds its session open for days. */
  later?: string[][];
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

  const exchanges = Array.isArray(c.exchanges)
    ? c.exchanges.map((e, i): Exchange => {
      const where = `exchanges[${i}]`;
      const x = object(e, where);
      if (x.request !== "reqContractDetails" && x.request !== "reqMktData") {
        fail(`${where}.request must be reqContractDetails or reqMktData`);
      }
      const contract = object(x.contract, `${where}.contract`);
      for (const key of CONTRACT_KEYS) {
        if (typeof contract[key] !== "string") fail(`${where}.contract.${key} must be a string`);
      }
      const replies = messages(x.replies, `${where}.replies`);
      const atMs = Array.isArray(x.atMs) && x.atMs.every((t) => typeof t === "number")
        ? x.atMs as number[] : fail(`${where}.atMs must be a list of numbers`);
      if (atMs.length !== 0 && atMs.length !== replies.length) {
        fail(`${where}.atMs must time every reply or none`);
      }
      const sent = message(x.sent, `${where}.sent`);
      if (x.request === "reqMktData" && sent[SNAPSHOT_AT] !== "0" && sent[SNAPSHOT_AT] !== "1") {
        fail(`${where}.sent[${SNAPSHOT_AT}] must say whether it asked for a snapshot, "1" or "0"`);
      }
      return {
        request: x.request as Exchange["request"],
        contract: contract as Record<ContractKey, string>,
        sent,
        replies, atMs,
        ...(x.onCancel === undefined ? {} : { onCancel: messages(x.onCancel, `${where}.onCancel`) }),
      };
    })
    : fail("exchanges must be a list");

  return {
    conversation: name,
    summary: text(c.summary, "summary"),
    provenance: p as unknown as Recorded | Constructed,
    ask,
    ...(later === undefined ? {} : { later }),
    handshake: { greeting, onStartApi: messages(h.onStartApi, "handshake.onStartApi") },
    exchanges,
  };
}
