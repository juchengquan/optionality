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

/** Replies an exchange sends LATER than its request: at a step of the replay (ADR 0031). A watch is
 *  a subscription the gateway keeps answering, and a picture can only be taken BETWEEN its answers
 *  if a replay sends them in turns; so the replay advances step by step, and at each sends the
 *  replies every exchange has for that step, if its request has been made by then. */
export interface Later {
  /** 1 is the first step; the watches number them in turn */
  step: number;
  replies: Message[];
}

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
  later?: Later[];
}

/** An account subscription and everything the gateway sent because of it (ADR 0030). Matched on
 *  the account the subscribe names (`ACCOUNT_AT`), since the account's messages carry no request
 *  id; `onCancel` is what the gateway said to the unsubscribe. */
export interface AccountExchange {
  request: "reqAccountUpdates";
  account: string;
  sent: Message;
  replies: Message[];
  atMs: number[];
  onCancel?: Message[];
  /** account updates pushed while the subscription stands: a portfolio row as a holding trades */
  later?: Later[];
}

/** A P&L subscription (ADR 0031): the account's (`reqPnL`), matched on the account it names, or one
 *  holding's (`reqPnLSingle`), on the account and the conId. Its answers carry its request id, so
 *  `$reqId` stands for it. Every figure a stream sends is `later`: `replies` are empty, so the
 *  picture a watch starts with is the download's alone, whenever the client looks at it. */
export interface PnlExchange {
  request: "reqPnL";
  account: string;
  sent: Message;
  replies: Message[];
  atMs: number[];
  onCancel?: Message[];
  later?: Later[];
}

export interface PnlSingleExchange {
  request: "reqPnLSingle";
  account: string;
  conId: string;
  sent: Message;
  replies: Message[];
  atMs: number[];
  onCancel?: Message[];
  later?: Later[];
}

export type Exchange = QuoteExchange | AccountExchange | PnlExchange | PnlSingleExchange;

/** Where reqPnL and reqPnLSingle name the account, and reqPnLSingle the holding: field 2 and field
 *  4, after the message id and the request id, from this client and `ib_async` alike. */
export const PNL_ACCOUNT_AT = 2;
export const PNL_CONID_AT = 4;

/** How a watch's replay ends: the caller stops it, or the gateway's connection drops under it. */
export type WatchEnd = "stop" | "drop";

/** One account watch a replay makes (ADR 0031): start it naming `wanted` (or none), advance
 *  `steps` steps, a picture after each, then end it.
 *
 *  `before`, where a file has it, is steps sent while the start is still WAITING for the download
 *  to end: the last of them carries the download end, so whatever comes ahead of it in that step —
 *  the account's P&L — is in the picture the watch starts on. The start resolving is how the replay
 *  knows that step has been read. */
export interface Watch {
  wanted: string | null;
  before?: number;
  steps: number;
  end: WatchEnd;
}

/** Where reqAccountUpdates says whether it subscribes ("1") or stops ("0"), and which account it
 *  names: version 2, from this client and `ib_async` alike. */
export const SUBSCRIBE_AT = 2;
export const ACCOUNT_AT = 3;

/** The account ids a recording may carry, each the SHAPE of a real one (a letter prefix and digits)
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
  /** Account watches made after the reads by the SAME client, in order (ADR 0031). Their steps are
   *  numbered in turn across them: the first watch's are 1 to its `steps`, the next's after. */
  watches?: Watch[];
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
  const watches = c.watches === undefined ? undefined : Array.isArray(c.watches)
    ? c.watches.map((w, i): Watch => {
      const watch = object(w, `watches[${i}]`);
      if (watch.wanted !== null && typeof watch.wanted !== "string") {
        fail(`watches[${i}].wanted must be an account or null`);
      }
      if (!Number.isInteger(watch.steps) || (watch.steps as number) < 0) {
        fail(`watches[${i}].steps must be a whole number of steps`);
      }
      if (watch.end !== "stop" && watch.end !== "drop") fail(`watches[${i}].end must be "stop" or "drop"`);
      if (watch.before !== undefined
        && (!Number.isInteger(watch.before) || (watch.before as number) < 1)) {
        fail(`watches[${i}].before must be a whole number of steps, 1 or more`);
      }
      return {
        wanted: watch.wanted as string | null,
        ...(watch.before === undefined ? {} : { before: watch.before as number }),
        steps: watch.steps as number, end: watch.end as WatchEnd,
      };
    })
    : fail("watches must be a list");
  if (ask.length === 0 && (reads === undefined || reads.length === 0)
    && (watches === undefined || watches.length === 0)) {
    fail("a conversation must ask for a quote, read the account or watch it");
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
      const later = x.later === undefined ? {} : {
        later: Array.isArray(x.later) ? x.later.map((l, j): Later => {
          const at = object(l, `${where}.later[${j}]`);
          if (!Number.isInteger(at.step) || (at.step as number) < 1) {
            fail(`${where}.later[${j}].step must be a step, 1 or more`);
          }
          return { step: at.step as number, replies: messages(at.replies, `${where}.later[${j}].replies`) };
        }) : fail(`${where}.later must be a list`),
      };
      if (x.request === "reqAccountUpdates") {
        const account = text(x.account, `${where}.account`);
        if (sent[0] !== "6" || sent[SUBSCRIBE_AT] !== "1" || sent[ACCOUNT_AT] !== account) {
          fail(`${where}.sent must subscribe to ${account}, as reqAccountUpdates does`);
        }
        return { request: "reqAccountUpdates", account, sent, replies, atMs, ...onCancel, ...later };
      }
      if (x.request === "reqPnL" || x.request === "reqPnLSingle") {
        const account = text(x.account, `${where}.account`);
        if (replies.length > 0) {
          fail(`${where}.replies must be empty: a stream's figures come later, at a step`);
        }
        if (x.request === "reqPnL") {
          if (sent[0] !== "92" || sent[PNL_ACCOUNT_AT] !== account) {
            fail(`${where}.sent must ask for ${account}'s P&L, as reqPnL does`);
          }
          return { request: "reqPnL", account, sent, replies, atMs, ...onCancel, ...later };
        }
        const conId = text(x.conId, `${where}.conId`);
        if (sent[0] !== "94" || sent[PNL_ACCOUNT_AT] !== account || sent[PNL_CONID_AT] !== conId) {
          fail(`${where}.sent must ask for ${account}'s ${conId}, as reqPnLSingle does`);
        }
        return { request: "reqPnLSingle", account, conId, sent, replies, atMs, ...onCancel, ...later };
      }
      if (x.request !== "reqContractDetails" && x.request !== "reqMktData") {
        fail(`${where}.request must be reqContractDetails, reqMktData, reqAccountUpdates, reqPnL `
          + "or reqPnLSingle");
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
        ...onCancel, ...later,
      };
    })
    : fail("exchanges must be a list");

  // ADR 0031: a replay knows the client has read a step when it has read the step's last P&L,
  // so each step ends with the account's: its reqPnL exchange is the last that answers at it —
  // but for the step a watch's download ends at (its last `before` step), which ends with that
  // download end, the start resolving being how the replay knows it has been read
  const steps = (watches ?? []).reduce((n, w) => n + (w.before ?? 0) + w.steps, 0);
  const opening = new Set<number>();
  (watches ?? []).reduce((first, w) => {
    if (w.before) opening.add(first + w.before - 1);
    return first + (w.before ?? 0) + w.steps;
  }, 1);
  for (const e of exchanges) {
    for (const l of e.later ?? []) {
      if (l.step > steps) fail(`a later reply comes at step ${l.step}, and the watches take ${steps}`);
    }
  }
  for (let step = 1; step <= steps; step++) {
    const last = exchanges.filter((e) => e.later?.some((l) => l.step === step)).at(-1);
    const replies = last?.later?.filter((l) => l.step === step).flatMap((l) => l.replies) ?? [];
    if (opening.has(step)) {
      if (last?.request !== "reqAccountUpdates" || replies.at(-1)?.[0] !== "54") {
        fail(`step ${step} must end with the download end a watch starts on, from a `
          + "reqAccountUpdates exchange");
      }
      continue;
    }
    if (last?.request !== "reqPnL" || replies.at(-1)?.[0] !== "94") {
      fail(`step ${step} must end with the account's P&L, a PNL message from a reqPnL exchange`);
    }
  }

  // ADR 0030: the owner's account is never committed, so nothing that reads one can be a capture
  if (p.kind !== "constructed" && (reads !== undefined || watches !== undefined
    || exchanges.some((e) => e.request !== "reqContractDetails" && e.request !== "reqMktData"))) {
    fail("reads the account, so it must be constructed: no capture of an account is committed");
  }

  return {
    conversation: name,
    summary: text(c.summary, "summary"),
    provenance: p as unknown as Recorded | Constructed,
    ask,
    ...(later === undefined ? {} : { later }),
    ...(reads === undefined ? {} : { accountReads: reads }),
    ...(watches === undefined ? {} : { watches }),
    handshake: { greeting, onStartApi: messages(h.onStartApi, "handshake.onStartApi") },
    exchanges,
  };
}
