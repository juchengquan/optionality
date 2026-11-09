/** One bounded ask of IB Gateway, and the connection it is asked over (ADR 0019, track C).
 *
 *  The shape is `opend/client.ts`'s, deliberately: hold the connection, bound every wait, tear it
 *  down on any failure so the next call reconnects. That answer has an incident behind it — a
 *  logged-in provider accepted a request and never answered it, and a promise that never settled
 *  stopped the alarm engine dead on 2026-10-16.
 *
 *  ## When an ask is finished
 *
 *  IB Gateway does say, but late. A snapshot ends with its own marker, message 57 (`snapshotEnd`
 *  in `messages.ts`): in the captures of 2026-11-09 under `testdata/vendors/ibkr-gateway/`, every
 *  market-data request the gateway served ends with one, 11.1 to 11.5 seconds after the request,
 *  where the book arrives within half a second and the model's greeks within two. A request it
 *  REFUSED (`not-subscribed`, 354) gets none. This note once said no such marker exists,
 *  "measured, not assumed"; the recordings show it does.
 *
 *  The client does not wait for it yet. Eleven seconds is longer than `requestTimeoutMs` allows
 *  a whole contract (8 seconds by default), and the contracts are asked one after another, so
 *  waiting for the marker would time every contract out — or, with the timeout raised, make a
 *  batch of N cost about 11·N seconds. Whether to wait for it, and whether to ask the contracts
 *  side by side so that the wait is paid once per batch, is a design question of its own rather
 *  than this file's to settle in passing. Until it is settled the rule below stands.
 *
 *  The rule settled in design was "resolve as soon as the contract has produced a figure that was
 *  asked for", and building it showed that is wrong: the figures arrive as SEPARATE messages, so
 *  stopping at the first one answers with a bid and throws the ask and the greeks away. Caught by
 *  the first test written against it.
 *
 *  So it is two conditions, not one. A figure must have arrived — `hasFigures`, which keeps the
 *  distinction ADR 0015 named, between "subscribed, nothing yet" and a contract that does not
 *  exist — and then a brief QUIET must follow it. The quiet window is an invented number, which
 *  the design deliberately avoided, and it is invented here because the protocol offers nothing
 *  better that can be waited for: its one delimiter comes too late (above), and the gateway never
 *  says how many figures a contract will produce, a count that depends on the account rather than
 *  on the code. It is bounded twice over — by itself and by `requestTimeoutMs` — and a figure
 *  that arrives late is late, not lost, because the window restarts on every message. It is also
 *  shorter than the gaps the gateway really leaves: the captures of 2026-11-09 show the model's
 *  greeks 0.3 to 1.7 seconds after the book, so the live client can finish without them, as
 *  `normal-with-greeks`' provenance records.
 *
 *  ## Why the grade is read rather than assumed
 *
 *  The gateway reports which data tier it served, per request, and it contradicted a request on
 *  2026-11-08 — asked for delayed, it granted live. So the answer is read and carried on the
 *  record, where a configured guess would be a label that says what we hoped for.
 *
 *  ## What is NOT here
 *
 *  Nothing that trades. `messages.ts` carries no order message and none is importable, and IB
 *  Gateway's own Read-Only API switch is the second, independent lock.
 */
import { contractFor } from "./contract.ts";
import { GREEK_TICKS, PRICE_TICKS, grade, greekFields, hasFigures, withMid } from "./fields.ts";
import {
  MARKET_DATA_DELAYED_FROZEN, type Incoming, cancelMktData, reqContractDetails,
  reqMarketDataType,
  reqMktData,
} from "./messages.ts";
import { TwsSocket, type TwsSocketConfig } from "./socket.ts";
import type { Quote } from "../../domain/quote.ts";
import type { QuoteBatch } from "../../quotes.ts";

export interface IbkrConfig extends TwsSocketConfig {
  /** Bounds the ASK, where the socket's own timeout bounds the handshake. A logged-in gateway can
   *  accept a request and never answer it — which is the 2026-10-16 shape — and this is shorter
   *  than the sweep watchdog on purpose: the fetch should fail and be counted, not be abandoned. */
  requestTimeoutMs?: number;
  /** How long to wait after a figure arrives, in case more is coming. See the note above on why
   *  this number exists at all: the gateway's own end marker comes about eleven seconds late, so
   *  SOMETHING sooner has to say "that was all of them". Restarted by every message. */
  quietMs?: number;
}

/** A conid, once resolved. Kept for the life of the connection: a contract's identity does not
 *  change, and asking again is a call spent to be told the same thing. Dropped with the
 *  connection, because a reconnect is where a stale assumption would otherwise survive. */
type Conids = Map<string, number>;

export class IbkrClient {
  private socket: TwsSocket | null = null;
  private readonly conids: Conids = new Map();
  private readonly config: IbkrConfig;
  private nextId = 1;
  /** Every message the gateway sends, routed by the id that asked for it. */
  private readonly waiting = new Map<number, (m: Incoming) => void>();

  constructor(config: IbkrConfig) {
    this.config = config;
  }

  get name(): string {
    return "ibkr";
  }

  /** Whether the gateway answered, for `/health`. Any failure is a no: a health probe that
   *  raises because the gateway is down has reported the thing it was asked. */
  async reachable(): Promise<boolean> {
    try {
      await this.connected();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.conids.clear();
    this.waiting.clear();
  }

  /** The one bounded call: figures for these codes, and which of them could not be priced. */
  async fetchQuotes(codes: string[]): Promise<QuoteBatch> {
    if (codes.length === 0) return { records: [], unknown: [] };
    try {
      return await this.ask(codes);
    } catch (err) {
      // tear down so the next call reconnects, as `opend/client.ts` does: a socket that has
      // quietly died otherwise produces a silent stream of empty batches rather than a failure
      this.close();
      throw err;
    }
  }

  private async connected(): Promise<TwsSocket> {
    if (this.socket?.connected) return this.socket;
    const socket = new TwsSocket(this.config);
    await socket.connect((message) => this.route(message));
    this.socket = socket;
    socket.send(reqMarketDataType(MARKET_DATA_DELAYED_FROZEN));
    return socket;
  }

  private route(message: Incoming): void {
    if (!("reqId" in message)) return;
    this.waiting.get(message.reqId)?.(message);
  }

  private async ask(codes: string[]): Promise<QuoteBatch> {
    const socket = await this.connected();

    // a code this client cannot name is unknown without a call: the gateway would answer the same
    // thing, and spending a request to hear it is a request bought for nothing
    const named = new Map<string, ReturnType<typeof contractFor>>();
    const unknown: string[] = [];
    for (const code of codes) {
      const shape = contractFor(code);
      if (shape) named.set(code, shape);
      else unknown.push(code);
    }
    if (named.size === 0) return { records: [], unknown };

    const records: Quote[] = [];
    // Who answered, counted in THIS ask. A conid from the cache is not an answer: it is what the
    // gateway said on an earlier ask, before its link had any chance to drop.
    let asked = 0;                                // contracts whose market data was asked for
    let answered = 0;                             // of those, the ones that sent anything back
    let refused = 0;                              // lookups answered "no such contract"
    for (const [code, shape] of named) {
      const found = await this.conid(socket, code, shape!);
      if (found.silent) continue;                 // counted below, not reported as unknown
      if (found.conId === null) {
        refused += 1;
        unknown.push(code);
        continue;
      }
      asked += 1;
      const { record, silent } = await this.figures(socket, code, shape!);
      if (silent) continue;
      answered += 1;
      records.push(record);
    }

    // Decision 4 of ADR 0019's design, and the reason it is load-bearing: a gateway whose link to
    // IBKR has dropped keeps its local socket open and answers NOTHING. Reporting those contracts
    // as `unknown` would read as "none of these exist" and quarantine every rule that watches
    // one, and an empty batch is no better: as the Provider it is every watched figure missing,
    // quarantined after N sweeps. So silence from every contract is a Provider failure and
    // throws, where silence from SOME leaves the rest standing. A record carrying only a grade
    // or an error still counts as an answer: that is "subscribed, nothing yet", which the sweep
    // counts and quarantines after N of them.
    //
    // Silence is judged where it was met, so the rule holds whatever the cache holds. Once any
    // contract got as far as market data, the market data is what must answer, and a lookup
    // answering is not enough: with a warm cache no lookup is asked at all, and the link can drop
    // between two asks — the shape the service, which holds its session for days, will actually
    // meet. Counting a cached conid as heard turned exactly that into an empty batch, until
    // `link-down-between-asks` was constructed to show it. A "no such contract" beside a silent
    // market does not rescue the batch either: it says the contract database answers, not that
    // the market data does. Where nothing got as far as market data, the lookups are what must
    // answer, and "no such contract" is an answer.
    if (asked > 0 ? answered === 0 : refused === 0) {
      const what = asked > 0 ? `${asked} market-data request(s)` : `${named.size} request(s)`;
      throw new Error(
        `IB Gateway accepted ${what} and answered none of them — its link to IBKR may be down `
        + "while its own socket is still open",
      );
    }
    return { records, unknown };
  }

  /** Resolve a code to a conid, once per connection.
   *
   *  Three answers, not two: a conid, "the gateway does not carry this" (null), and SILENCE —
   *  nothing came back at all, which is the gateway's link being down rather than a fact about
   *  the contract. The caller counts the silence.
   *
   *  A cached conid is returned as not silent, and it is not: the gateway did answer, earlier. But
   *  it is no evidence the gateway answers NOW, which is why `ask` judges silence at the market
   *  data for every contract that got that far.
   */
  private async conid(
    socket: TwsSocket, code: string, shape: NonNullable<ReturnType<typeof contractFor>>,
  ): Promise<{ conId: number | null; silent: boolean }> {
    const cached = this.conids.get(code);
    if (cached !== undefined) return { conId: cached, silent: false };

    const id = this.nextId++;
    let heard = false;
    const answer = await this.collect<number>(
      socket, id, reqContractDetails(id, shape.contract), (message, done) => {
        heard = true;
        if (message.kind === "contract") done(message.conId);
        // the end marker arrives whether or not anything was found, which is how "no such
        // contract" is told from "still coming"
        if (message.kind === "contractEnd") done(null);
        if (message.kind === "error") done(null);
      },
    );
    if (answer !== null) this.conids.set(code, answer);
    return { conId: answer, silent: !heard };
  }

  /** One contract's figures, under the service's field names. */
  private async figures(
    socket: TwsSocket, code: string, shape: NonNullable<ReturnType<typeof contractFor>>,
  ): Promise<{ record: Quote; silent: boolean }> {
    const id = this.nextId++;
    const record: Quote = { code };
    let heard = false;
    await this.collect<Quote>(
      socket, id, reqMktData(id, shape.contract, true), (message, _done, settle) => {
        heard = true;
        if (message.kind === "dataType") {
          const grades = grade(message.type);
          if (grades) Object.assign(record, grades);
        }
        if (message.kind === "price" && message.price !== null) {
          const field = PRICE_TICKS[message.tickType];
          if (field) record[field] = message.price;
        }
        if (message.kind === "greeks" && GREEK_TICKS.has(message.tickType)) {
          Object.assign(record, greekFields(message.figures));
        }
        // the gateway's end marker comes about eleven seconds late and is not waited for (see the
        // note at the top), so a figure having arrived starts a short clock rather than finishing
        // the ask: every message restarts it, and the quiet is what says "that was all of them".
        // The outer timeout finishes the contracts that never answer.
        if (hasFigures(record)) settle(record);
      },
    );
    socket.send(cancelMktData(id));
    return { record: withMid(record), silent: !heard };
  }

  /** Send, and listen on that id until the reader says it is done or the clock says it is over.
   *
   *  Resolving with `null` on a timeout rather than throwing is the containment: one contract that
   *  never answers leaves the others' figures standing, and the batch reports what it got. A
   *  gateway that is wholly unreachable throws earlier, from `connected()`.
   */
  private collect<T>(
    socket: TwsSocket, id: number, payload: string,
    read: (message: Incoming, done: (value: T | null) => void, settle: (value: T) => void) => void,
  ): Promise<T | null> {
    const { requestTimeoutMs = 8_000, quietMs = 250 } = this.config;
    return new Promise<T | null>((resolve) => {
      let settled = false;
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (quiet) clearTimeout(quiet);
        this.waiting.delete(id);
        resolve(value);
      };
      // enough has arrived; wait a moment in case more is on its way, and restart that wait every
      // time something is. A figure that arrives late is late rather than lost.
      const settle = (value: T) => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => finish(value), quietMs);
      };
      const timer = setTimeout(() => finish(null), requestTimeoutMs);
      this.waiting.set(id, (message) => read(message, finish, settle));
      socket.send(payload);
    });
  }
}
