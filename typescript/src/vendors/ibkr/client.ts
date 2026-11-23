/** One bounded ask of IB Gateway, and the connection it is asked over (ADR 0019, track C).
 *
 *  The shape is `opend/client.ts`'s, deliberately: hold the connection, bound every wait, tear it
 *  down on any failure so the next call reconnects. That answer has an incident behind it — a
 *  logged-in provider accepted a request and never answered it, and a promise that never settled
 *  stopped the alarm engine dead on 2026-10-16.
 *
 *  ## When an ask is finished (#257)
 *
 *  The protocol never says how many figures a contract will produce — that depends on the account
 *  rather than on the code — and its one delimiter, the snapshot's end (message 57), comes 11.1 to
 *  12.1 seconds after the request in every capture, where an option's book arrives within about
 *  half a second (2.3 while the gateway's farms reconnect) and its model greeks 0.3 to 1.7
 *  seconds after the book. So an ask is finished by whichever comes first of:
 *
 *  - **the snapshot's end**: nothing more is coming. With the default timeout it is never first —
 *    eight seconds is less than eleven — so it ends a replay, where every reply arrives at once,
 *    or an ask given a longer timeout. Live, an option whose model greeks never come costs the
 *    timeout, and since the contracts are asked side by side, so does its batch;
 *  - **every figure the contract's kind is waited for, then a brief QUIET**: a figure at all —
 *    `hasFigures`, which keeps the distinction ADR 0015 named, between "subscribed, nothing yet"
 *    and a contract that does not exist — and for an OPTION its model greeks too (tick 13, or 83
 *    when the delayed tier answers), computed or not. The quiet is restarted by every NEW figure,
 *    so one that arrives late is late rather than lost, and not by a repeat: a stream keeps
 *    sending what it has already sent, and a repeat is the running board rather than more of the
 *    answer. A figure later than the quiet after the last new one IS lost: an option's previous
 *    close has come after its greeks, or not before the client was done (2026-11-10);
 *  - **the timeout**, `requestTimeoutMs`, which keeps whatever arrived.
 *
 *  The greeks are waited for because the quiet alone lost them: across six live captures of an
 *  option on 2026-11-09 they came 0.3 to 1.7 seconds after the book, and in five a pause longer
 *  than the 250ms window came first (#257). The quiet window is still an invented number, and it
 *  is invented because nothing better can be waited for: it is bounded twice over, by itself and
 *  by the timeout.
 *
 *  **Every contract is asked side by side**, so a batch costs its slowest contract — 1.4 to 2.2
 *  seconds for an option, SPX and VIX against the gateway on 2026-11-10, about 3.3 while its farms
 *  reconnect — where one after another it cost the sum, and the wait for greeks would be paid
 *  again for every option. `socket.ts` paces what that puts on the wire, as `ib_async` does.
 *
 *  **An index is asked as a STREAM**, and cancelled once read. A snapshot of SPX or VIX carries no
 *  figure at any hour: its high, low and close come with their price fields EMPTY, then the
 *  snapshot's end eleven seconds later, because the account has no snapshot permission for an
 *  index — the gateway's own parameters message says 0, where an option's says 3 (recorded in
 *  the session on 2026-11-10, `index-in-the-session`). A stream sends every figure it holds in one
 *  burst, half a second after the request, and the quiet after it ends the ask. It is still one
 *  ask and one answer: the stream is cancelled when the ask finishes, so no running board of
 *  prices outlives it to make a dead session look like a calm market.
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
import {
  type AccountValueRow, GREEK_TICKS, type IbkrAccount, type IbkrHolding,
  MARKET_DATA_DELAYED_FROZEN, PRICE_TICKS, accountAnswer, chooseAccount, grade, greekFields,
  hasFigures, holdingFrom, managedAccounts, withMid,
} from "./fields.ts";
import {
  type Incoming, cancelMktData, reqAccountUpdates, reqContractDetails,
  reqMarketDataType,
  reqMktData,
} from "./messages.ts";
import { TwsSocket, type TwsSocketConfig } from "./socket.ts";
import type { Quote } from "../../domain/quote.ts";
import type { QuoteBatch } from "../../quotes.ts";

export type { IbkrAccount, IbkrHolding, IbkrTotals } from "./fields.ts";

/** The account read refused to choose: several accounts on the login and none named, a named one
 *  not on it, or none named by the gateway at all. A fact about the configuration rather than the
 *  gateway's health, so a caller can tell it from a read that failed. Its message carries the ids
 *  MASKED, never in full. */
export class IbkrAccountRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IbkrAccountRefused";
  }
}

export interface IbkrConfig extends TwsSocketConfig {
  /** Bounds the ASK, where the socket's own timeout bounds the handshake. A logged-in gateway can
   *  accept a request and never answer it — which is the 2026-10-16 shape — and this is shorter
   *  than the sweep watchdog on purpose: the fetch should fail and be counted, not be abandoned. */
  requestTimeoutMs?: number;
  /** How long to wait after a figure arrives, in case more is coming. See the note above on why
   *  this number exists at all: the gateway's own end marker comes about eleven seconds late, so
   *  SOMETHING sooner has to say "that was all of them". Restarted by every new figure. */
  quietMs?: number;
}

/** A conid, once resolved. Kept for the life of the connection: a contract's identity does not
 *  change, and asking again is a call spent to be told the same thing. Dropped with the
 *  connection, because a reconnect is where a stale assumption would otherwise survive. */
type Conids = Map<string, number>;

/** The account messages, which carry the account's name and no request id. */
type AccountMessage = Extract<Incoming, { kind: "accountValue" | "portfolio" | "accountTime" | "accountEnd" }>;

/** The account read running now: whose, over which socket, and how to feed or fail it. */
interface AccountRead {
  socket: TwsSocket;
  account: string;
  answer: Promise<IbkrAccount>;
  read: (message: AccountMessage) => void;
  fail: (err: Error) => void;
}

export class IbkrClient {
  private socket: TwsSocket | null = null;
  /** The connect in flight, shared by every caller who arrives while it runs. IB Gateway allows
   *  one connection per client id, and the sweep, the dashboard's poll and a creation probe can
   *  all find the client cold at once: each opening a socket of its own sent the gateway a second
   *  session on one id, and the refusal's teardown then closed whichever socket had won. */
  private connecting: Promise<TwsSocket> | null = null;
  /** Bumped by `close()`, so a connect that completes after it knows it is no longer wanted and
   *  hangs up rather than leaving a socket nobody holds. */
  private generation = 0;
  private readonly conids: Conids = new Map();
  private readonly config: IbkrConfig;
  private nextId = 1;
  /** Every message the gateway sends, routed by the id that asked for it — and the socket that
   *  asked, so tearing one socket down drops only its own listeners. */
  private readonly waiting = new Map<number, { socket: TwsSocket; read: (m: Incoming) => void }>();
  /** What each session said its managed accounts were — MANAGED_ACCTS' one field, which the
   *  gateway sends with the handshake. Kept by socket, because it is a fact about that session. */
  private readonly managed = new WeakMap<TwsSocket, string>();
  /** The account read in flight, which a second caller for the same account joins: IB allows one
   *  account subscription per client at a time. */
  private reading: AccountRead | null = null;

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
    this.generation += 1;
    this.connecting = null;
    if (this.socket) this.drop(this.socket);
  }

  /** Hang up ONE socket, and forget what was learnt or asked over it. The client's socket is
   *  forgotten only if it is this one: an ask that failed on a socket since replaced must not
   *  close the replacement, nor drop the listeners of the asks running on it. */
  private drop(socket: TwsSocket): void {
    // an account read on this socket can hear nothing more, and is told so now rather than at
    // its deadline; there is no connection left to unsubscribe over
    if (this.reading?.socket === socket) {
      this.reading.fail(new Error("IB Gateway's connection closed during the account read"));
    }
    socket.close();
    for (const [id, entry] of this.waiting) if (entry.socket === socket) this.waiting.delete(id);
    if (this.socket !== socket) return;
    this.socket = null;
    this.conids.clear();
  }

  /** The one bounded call: figures for these codes, and which of them could not be priced. */
  async fetchQuotes(codes: string[]): Promise<QuoteBatch> {
    if (codes.length === 0) return { records: [], unknown: [] };
    // a connect that fails has already hung up its own socket, and is nobody else's to tear down
    const socket = await this.connected();
    try {
      return await this.ask(socket, codes);
    } catch (err) {
      // tear down so the next call reconnects, as `opend/client.ts` does: a socket that has
      // quietly died otherwise produces a silent stream of empty batches rather than a failure
      this.drop(socket);
      throw err;
    }
  }

  /** The held socket, or ONE connect shared by everyone who asks while it runs. */
  private connected(): Promise<TwsSocket> {
    if (this.socket?.connected) return Promise.resolve(this.socket);
    if (!this.connecting) {
      const connecting = this.open().finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  private async open(): Promise<TwsSocket> {
    const generation = this.generation;
    // one that died underneath us: its listeners and conids go with it before a new one starts
    if (this.socket) this.drop(this.socket);
    const socket = new TwsSocket(this.config);
    // a refused or failed handshake closes this socket itself (`socket.ts`), and only this one
    await socket.connect((message) => this.route(socket, message));
    if (generation !== this.generation) {
      socket.close();
      throw new Error("IB Gateway client was closed while it was connecting");
    }
    this.socket = socket;
    socket.send(reqMarketDataType(MARKET_DATA_DELAYED_FROZEN));
    return socket;
  }

  private route(socket: TwsSocket, message: Incoming): void {
    if (message.kind === "accounts") {
      this.managed.set(socket, message.list);
      return;
    }
    if (message.kind === "accountValue" || message.kind === "portfolio"
      || message.kind === "accountTime" || message.kind === "accountEnd") {
      if (this.reading?.socket === socket) this.reading.read(message);
      return;
    }
    if (!("reqId" in message)) return;
    this.waiting.get(message.reqId)?.read(message);
  }

  private async ask(socket: TwsSocket, codes: string[]): Promise<QuoteBatch> {

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

    // Side by side: a batch costs its slowest contract rather than the sum of them (#257)
    const outcomes = await Promise.all([...named].map(async ([code, shape]) => {
      const found = await this.conid(socket, code, shape!);
      const data = found.silent || found.conId === null
        ? null : await this.figures(socket, code, shape!);
      return { code, found, data };
    }));

    const records: Quote[] = [];
    // Who answered, counted in THIS ask. A conid from the cache is not an answer: it is what the
    // gateway said on an earlier ask, before its link had any chance to drop.
    let asked = 0;                                // contracts whose market data was asked for
    let answered = 0;                             // of those, the ones that sent anything back
    let refused = 0;                              // lookups answered "no such contract"
    for (const { code, found, data } of outcomes) {
      if (found.silent) continue;                 // counted below, not reported as unknown
      if (data === null) {                        // the lookup said "no such contract"
        refused += 1;
        unknown.push(code);
        continue;
      }
      asked += 1;
      if (data.silent) continue;
      answered += 1;
      records.push(data.record);
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

  /** The account's totals and holdings, read once (ADR 0030): subscribe, collect until the
   *  gateway's download end, unsubscribe, answer. Over the same connection and client id as the
   *  price reads.
   *
   *  Which account: the login's one managed account; or, where it has several, the one `wanted`
   *  names. Refused with `IbkrAccountRefused`, every id MASKED, where several are managed and
   *  `wanted` is unset ("several accounts on this login; set IBKR_ACCOUNT …"), or where `wanted`
   *  names none of them. A gateway that cannot be reached throws as `fetchQuotes` does, and a
   *  deadline (`requestTimeoutMs`) fails it with its own words, the unsubscribe sent on that path
   *  too. A second caller while a read of the same account runs JOINS it: IB allows one
   *  account subscription per client at a time. */
  async account(wanted?: string): Promise<IbkrAccount> {
    const socket = await this.connected();
    const choice = chooseAccount(managedAccounts(this.managed.get(socket) ?? ""), wanted ?? null);
    if ("refused" in choice) throw new IbkrAccountRefused(choice.refused);
    for (;;) {
      const running = this.reading;
      if (running === null) return this.readAccount(socket, choice.account);
      if (running.socket === socket && running.account === choice.account) return running.answer;
      // another account's read holds the one subscription: it finishes first, whatever it comes to
      await running.answer.catch(() => undefined);
    }
  }

  /** Subscribe, collect until the download's end, unsubscribe, answer — or fail at the deadline,
   *  unsubscribing all the same. The account messages carry no request id, so they reach this by
   *  the account they name (`route`); one naming another account is not this read's. A value or
   *  a holding sent twice is the later one, a holding kept where it first came. Nothing it reads
   *  leaves it but `accountAnswer`'s answer, whose id is masked. */
  private readAccount(socket: TwsSocket, account: string): Promise<IbkrAccount> {
    const { requestTimeoutMs = 8_000 } = this.config;
    const values = new Map<string, AccountValueRow>();
    const holdings = new Map<string, IbkrHolding>();
    let updatedAt: string | null = null;
    let settle!: (outcome: { answer: IbkrAccount } | { error: Error }, unsubscribe: boolean) => void;
    const answer = new Promise<IbkrAccount>((resolve, reject) => {
      let settled = false;
      settle = (outcome, unsubscribe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.reading === entry) this.reading = null;
        if (unsubscribe && socket.connected) socket.send(reqAccountUpdates(false, account));
        if ("answer" in outcome) resolve(outcome.answer);
        else reject(outcome.error);
      };
      const timer = setTimeout(() => settle({
        error: new Error(
          `IB Gateway did not finish sending the account within ${requestTimeoutMs}ms — its link `
          + "to IBKR may be down while its own socket is still open"),
      }, true), requestTimeoutMs);
    });
    const entry: AccountRead = {
      socket, account, answer,
      read: (message) => {
        if (message.kind === "accountTime") {
          updatedAt = message.time;
          return;
        }
        if (message.account !== account) return;
        if (message.kind === "accountValue") {
          values.set(`${message.row.key}\0${message.row.currency}`, message.row);
        } else if (message.kind === "portfolio") {
          holdings.set(message.conId, holdingFrom(message.row));
        } else {
          settle({
            answer: accountAnswer(account, [...values.values()], [...holdings.values()], updatedAt),
          }, true);
        }
      },
      fail: (error) => settle({ error }, false),
    };
    this.reading = entry;
    try {
      socket.send(reqAccountUpdates(true, account));
    } catch (err) {
      settle({ error: err instanceof Error ? err : new Error(String(err)) }, false);
    }
    return answer;
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

  /** One contract's figures, under the service's field names: an option's as a snapshot, an
   *  index's as a stream, and either finished as the note at the top says. */
  private async figures(
    socket: TwsSocket, code: string, shape: NonNullable<ReturnType<typeof contractFor>>,
  ): Promise<{ record: Quote; silent: boolean }> {
    const id = this.nextId++;
    const record: Quote = { code };
    const option = shape.contract.secType === "OPT";
    let heard = false;
    let modelled = false;                         // the model's greeks arrived, computed or not
    const complete = () => hasFigures(record) && (!option || modelled);
    await this.collect<Quote>(
      socket, id, reqMktData(id, shape.contract, option), (message, done, settle) => {
        heard = true;
        // the gateway says nothing more is coming
        if (message.kind === "snapshotEnd") return done(record);
        const held = Object.keys(record).length;
        const wasComplete = complete();
        if (message.kind === "dataType") {
          const grades = grade(message.type);
          if (grades) Object.assign(record, grades);
        }
        if (message.kind === "price" && message.price !== null) {
          const field = PRICE_TICKS[message.tickType];
          if (field) record[field] = message.price;
        }
        if (message.kind === "greeks" && GREEK_TICKS.has(message.tickType)) {
          modelled = true;
          Object.assign(record, greekFields(message.figures));
        }
        // complete, or a new figure since it was: start the quiet again. A figure already held
        // is a stream repeating itself, and restarting on that would hold a busy stream open
        // until the timeout
        if (complete() && (!wasComplete || Object.keys(record).length > held)) settle(record);
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
      // enough has arrived; wait a moment in case more is on its way, and restart that wait
      // whenever the reader says something new has. A figure that arrives late is late rather
      // than lost.
      const settle = (value: T) => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => finish(value), quietMs);
      };
      const timer = setTimeout(() => finish(null), requestTimeoutMs);
      this.waiting.set(id, { socket, read: (message) => read(message, finish, settle) });
      socket.send(payload);
    });
  }
}
