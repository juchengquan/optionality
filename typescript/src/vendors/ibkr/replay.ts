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
 */
import { IbkrClient, type IbkrConfig } from "./client.ts";
import { startFakeGateway } from "./fake.ts";
import { conversationNames, loadConversation } from "./recordings.ts";

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
}

/** The stub's port is chosen by the OS, so a message that names it is spelled with `<port>`. */
function withoutPort(message: string, port: number): string {
  return message.replaceAll(`127.0.0.1:${port}`, "127.0.0.1:<port>");
}

/** One conversation, replayed: what the client returned, or what it threw. */
export async function replay(name: string): Promise<Expectation> {
  const conversation = loadConversation(name);
  const gateway = await startFakeGateway(0, { conversation });
  const client = new IbkrClient({ host: "127.0.0.1", port: gateway.port, ...REPLAY_CONFIG });
  let expect: unknown;
  try {
    expect = await client.fetchQuotes(conversation.ask);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect = { $throws: withoutPort(message, gateway.port) };
  } finally {
    client.close();
    await gateway.close();
  }
  return {
    conversation: name, provenance: conversation.provenance.kind,
    client: "typescript/src/vendors/ibkr/client.ts", config: REPLAY_CONFIG,
    ask: conversation.ask, expect,
  };
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
