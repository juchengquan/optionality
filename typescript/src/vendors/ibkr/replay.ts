/** What this client makes of each recorded conversation: the expected batch (ADR 0021, phase 1d).
 *
 *  Decision 7 holds the two IB Gateway clients — this one, and the Python's on `ib_async` — by
 *  "the same recording in, the same quote batch out". This is the TypeScript half: replay each
 *  conversation through `fake.ts` to `IbkrClient`, and write down what came out, or the exact
 *  error it threw. `make cases` writes the result to `testdata/vendors/ibkr-gateway/expected/`
 *  and `make check-cases` fails when it is stale, as for every other corpus here, and outside the
 *  `GOLDEN_CASES` fingerprint for the vendor corpus' reason (`cases/vendors.ts`).
 *
 *  ## Why this is a door of the vendor seam
 *
 *  The case generator has to run a client, and a client is what the seam keeps everything but
 *  the backend's vendor door from opening — IB Gateway allows one connection per client id, and
 *  a second displaces the first in silence. This file opens one only against a stub it starts
 *  itself, on a loopback port the OS picks, and closes both before it returns. It takes no host
 *  and no port, so nothing that imports it can point it at a gateway.
 *
 *  ## What a replay is
 *
 *  Every reply at once, in order. The real gateway paces its answer over seconds — the model's
 *  greeks a second or two after the book, the snapshot's end after eleven — and `atMs` in each
 *  recording keeps that, but a replay does not: an expectation that depended on a timer racing
 *  a socket would be a flaky test, not a corpus. So the batch here is what the client makes of
 *  the gateway's WHOLE answer. Where that differs from what it made of the live one, the
 *  recording's provenance says so.
 *
 *  A conversation with `later` asks is asked them in turn by the SAME client after its first, so
 *  what the client holds between asks (the connection, the conids) is part of what is recorded,
 *  and each later outcome is written beside the first. The service holds one connection for days,
 *  and a fault that only a warm cache shows needs a second ask to be seen at all.
 *
 *  ## A watch, step by step (ADR 0031)
 *
 *  A watch is a subscription the gateway keeps answering, so its expectation is a SEQUENCE of
 *  pictures rather than one answer: the picture it starts on, one after each of its steps, and the
 *  one it keeps when it ends. A picture is only worth recording at a moment the client has read
 *  exactly what was sent, so the stub sends a stream's figures only at a step (`fake.ts`' `step`),
 *  every step ends with the account's P&L (`parseConversation` holds that), and the client's clock
 *  is a COUNTER read once per P&L message (`now`): the replay waits until the clock has been read
 *  once for every P&L the stub wrote, and that is when the step has been read. A condition, not a
 *  timer. So `pnl_at` in `expected/` is the count of P&L messages read, never a wall time.
 *
 *  A watch's `before` steps are sent while its start is still waiting for the download to end, the
 *  last of them carrying that end: what comes ahead of it — the account's P&L — is in the picture
 *  the watch starts on, and the start resolving is how the replay knows that step was read.
 */
import {
  IbkrAccountRefused, type IbkrAccountWatch, IbkrClient, type IbkrConfig,
} from "./client.ts";
import { startFakeGateway } from "./fake.ts";
import { type WatchEnd, conversationNames, loadConversation } from "./recordings.ts";

export { conversationNames };

/** The corpus, relative to the repository. */
export const GATEWAY_CASES = "testdata/vendors/ibkr-gateway";

/** How the client is configured for every replay. The timeouts are short because a stub on
 *  loopback answers in microseconds or never; the quiet window is the client's own default,
 *  because it is part of the completion rule being recorded. */
export const REPLAY_CONFIG = {
  clientId: 31419, connectTimeoutMs: 1000, requestTimeoutMs: 1000, quietMs: 250,
} as const satisfies Omit<IbkrConfig, "host" | "port">;

export interface Expectation {
  conversation: string;
  /** the recording's own words for where its replies came from, so nobody has to open two files
   *  to know whether an expected batch rests on a capture */
  provenance: "recorded" | "constructed";
  client: string;
  config: typeof REPLAY_CONFIG;
  ask: string[];
  /** the batch, or `{ "$throws": message }` — the tag the golden cases use */
  expect: unknown;
  /** each of the recording's `later` asks and what it came to, in order; absent where it has none,
   *  so a conversation of one ask renders exactly as before the field existed */
  later?: { ask: string[]; expect: unknown }[];
  /** Each of the recording's account reads (ADR 0030), in order after the asks: what it came to —
   *  the answer, `{ "$refused": message }` where the client refused to choose an account, or
   *  `{ "$throws": message }` — and every account subscription the stub was sent because of it,
   *  so the messages are held as well as the answer. Absent where the recording reads none. */
  accountReads?: { wanted: string | null; expect: unknown; sent: string[][] }[];
  /** Each of the recording's account watches (ADR 0031), in order after the reads. */
  watches?: WatchExpectation[];
}

/** One watch: where it started, each step's picture, how it ended, and what it sent. */
export interface WatchExpectation {
  wanted: string | null;
  /** the picture it started on, or `{ "$refused": … }` / `{ "$throws": … }` */
  start: unknown;
  /** the picture after each step; absent where the start failed */
  steps?: unknown[];
  end?: WatchEnd;
  /** what `lost` said once it ended: null for one stopped, the words for one dropped */
  lost?: string | null;
  /** the picture it kept once it ended */
  last?: unknown;
  /** every message the client sent because of it: the account subscription, the P&L requests and
   *  their cancels — a stop after a loss included, which sends nothing */
  sent: string[][];
}

/** The messages a watch sends: reqAccountUpdates, reqPnL, cancelPnL, reqPnLSingle, cancelPnLSingle. */
export const WATCH_MESSAGES = new Set(["6", "92", "93", "94", "95"]);

/** The stub's port is chosen by the OS, so a message that names it is spelled with `<port>`. */
function withoutPort(message: string, port: number): string {
  return message.replaceAll(`127.0.0.1:${port}`, "127.0.0.1:<port>");
}

/** One conversation, replayed: what the client returned, or what it threw. */
export async function replay(name: string): Promise<Expectation> {
  const conversation = loadConversation(name);
  const gateway = await startFakeGateway(0, { conversation });
  // the client's clock counts its readings, once per P&L message a watch reads: see the top
  let readings = 0;
  const client = new IbkrClient({
    host: "127.0.0.1", port: gateway.port, ...REPLAY_CONFIG, now: () => ++readings,
  });
  const outcome = async (codes: string[]): Promise<unknown> => {
    try {
      return await client.fetchQuotes(codes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { $throws: withoutPort(message, gateway.port) };
    }
  };
  const subscriptions = () => gateway.received.filter((f) => f[0] === "6");
  const read = async (wanted: string | null) => {
    const before = subscriptions().length;
    let got: unknown;
    try {
      got = await client.account(wanted ?? undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      got = err instanceof IbkrAccountRefused ? { $refused: message } : { $throws: message };
    }
    await unsubscribed(gateway.received);
    return { wanted, expect: got, sent: subscriptions().slice(before) };
  };
  const watched = async (
    wanted: string | null, ahead: number, steps: number, first: number, end: WatchEnd,
  ): Promise<WatchExpectation> => {
    const before = gateway.received.length;
    const sent = () => gateway.received.slice(before).filter((f) => WATCH_MESSAGES.has(f[0]!));
    const starting = client.watchAccount(wanted ?? undefined)
      .then((w) => ({ w }), (err: unknown) => ({ err }));
    for (let n = first; n < first + ahead; n++) {
      await gateway.step(n);
      // every step but the one the download ends at ends with a P&L; that one, with the start
      if (n < first + ahead - 1) {
        await until(() => readings >= gateway.written.filter((m) => m[0] === "94").length);
      }
    }
    first += ahead;
    let watch: IbkrAccountWatch;
    try {
      const started = await starting;
      if ("err" in started) throw started.err;
      watch = started.w;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await unsubscribed(gateway.received);
      return {
        wanted, start: err instanceof IbkrAccountRefused ? { $refused: message } : { $throws: message },
        sent: sent(),
      };
    }
    const start = watch.picture();
    const pictures: unknown[] = [];
    for (let n = first; n < first + steps; n++) {
      await gateway.step(n);
      await until(() => readings >= gateway.written.filter((m) => m[0] === "94").length);
      pictures.push(watch.picture());
    }
    if (end === "drop") {
      gateway.dropConnections();
      await until(() => watch.lost !== null);
    }
    await watch.stop();
    await unsubscribed(gateway.received);
    return {
      wanted, start, steps: pictures, end, lost: watch.lost?.message ?? null, last: watch.picture(),
      sent: sent(),
    };
  };
  let expect: unknown;
  let later: Expectation["later"];
  let accountReads: Expectation["accountReads"];
  let watches: Expectation["watches"];
  try {
    expect = await outcome(conversation.ask);
    if (conversation.later) {
      later = [];
      for (const codes of conversation.later) {
        later.push({ ask: codes, expect: await outcome(codes) });
      }
    }
    if (conversation.accountReads) {
      accountReads = [];
      for (const { wanted } of conversation.accountReads) accountReads.push(await read(wanted));
    }
    if (conversation.watches) {
      watches = [];
      let first = 1;
      for (const { wanted, before = 0, steps, end } of conversation.watches) {
        watches.push(await watched(wanted, before, steps, first, end));
        first += before + steps;
      }
    }
  } finally {
    client.close();
    await gateway.close();
  }
  return {
    conversation: name, provenance: conversation.provenance.kind,
    client: "typescript/src/vendors/ibkr/client.ts", config: REPLAY_CONFIG,
    ask: conversation.ask, expect, ...(later ? { later } : {}),
    ...(accountReads ? { accountReads } : {}),
    ...(watches ? { watches } : {}),
  };
}

/** Until `done`, or a second has passed: what was waited for arrives over loopback in
 *  microseconds, and a client that never does it is a difference the expectation will show. */
async function until(done: () => boolean): Promise<void> {
  const limit = Date.now() + 1000;
  while (!done() && Date.now() < limit) await new Promise((r) => setTimeout(r, 5));
}

/** Until every account subscription the stub was sent has had its unsubscribe, or a second has
 *  passed: the unsubscribe goes as a read settles, and reaches the stub a moment after. */
export async function unsubscribed(received: string[][]): Promise<void> {
  const open = () => received.filter((f) => f[0] === "6")
    .reduce((n, f) => n + (f[2] === "1" ? 1 : -1), 0);
  const until = Date.now() + 1000;
  while (open() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

/** The exact text of one expectation, so a regeneration that changes nothing changes no byte. */
export const render = (e: Expectation) => `${JSON.stringify(e, null, 2)}\n`;

/** Every recording's expectation, rendered, by name. Replayed side by side: the silent ones each
 *  wait out the request timeout, and in turn they would cost a second apiece. */
export async function expectations(): Promise<Record<string, string>> {
  const names = conversationNames();
  const done = await Promise.all(names.map(replay));
  return Object.fromEntries(done.map((e) => [e.conversation, render(e)]));
}
