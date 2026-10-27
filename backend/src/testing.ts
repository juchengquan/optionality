/** Building the app for a test (ADR 0009, phase 5).
 *
 *  The counterpart of the Python's `client_factory`, and it keeps that fixture's most important
 *  property: a test can NEVER reach the real moomoo SDK, because it blocks indefinitely on a dead
 *  port and a missing fake looks like a hung suite (CLAUDE.md). The sweeper and the OpenD probe are
 *  faked below for the same reason.
 *
 *  Not a *.test.ts file: the route suites all import it, and phases 6 and 7 will too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createApp } from "./app.ts";
import { createDatabase } from "./db/open.ts";
import { type Settings, settingsFor } from "./env.ts";
import type { Deps } from "./deps.ts";
import type { QuoteBatch, QuoteFetcher, QuoteRecord } from "./quotes.ts";

export const TOKEN = "tok";

/** The harness's clock, fixed. Exported because a test that invents a date from the REAL clock while
 *  the app reads this one is a test that breaks at midnight: `dte` counts from New York's calendar
 *  day, so a strike 30 days from the real date is 31 days from a frozen 2026-10-01 once the real date
 *  rolls over. That is exactly how this suite broke a day after it was written. Derive dates from
 *  here and the gap cannot open. */
export const NOW = new Date("2026-10-02T05:26:06.299Z");

/** A date `n` days from the harness's clock, as YYYY-MM-DD. */
export const daysFromNow = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const AUTH = { Authorization: `Bearer ${TOKEN}` };

/** A sweeper that has never swept, which is what a freshly started service looks like. */
export class FakeSweeper {
  sweepAt: Date | null = null;
  fetchAt: Date | null = null;
  /** null, as a service that has not asked yet: /health then falls back to the port probe */
  fetchOk: boolean | null = null;
  ok = true;
  failures = 0;
  label = "watching";
  bad = false;
  lastSweepAt() { return this.sweepAt; }
  lastFetchAt() { return this.fetchAt; }
  lastFetchOk() { return this.fetchOk; }
  lastSweepOk() { return this.ok; }
  consecutiveFailures() { return this.failures; }
  alarmState() { return { label: this.label, bad: this.bad }; }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  db: DatabaseSync;
  settings: Settings;
  sweeper: FakeSweeper;
  /** What the clock returns. Set it to state the time rather than wait for it. */
  now: Date;
  close(): void;
  /** `fetch` against the app, with the bearer token unless `anonymous` is passed. */
  call(path: string, init?: RequestInit & { anonymous?: boolean }): Promise<Response>;
}

/** A batch in which every code was priced — what a fake Provider answers unless the test is about
 *  one that was not. */
export const priced = (records: QuoteRecord[]): QuoteBatch => ({ records, unknown: [] });

/** What a test answers with: records alone, or a whole batch.
 *
 *  Nearly every test prices everything it is asked for, and writing `{ records, unknown: [] }`
 *  forty times says nothing. The tests that are ABOUT a code the Provider cannot price answer with
 *  the batch itself, and read as the exception they are (#168).
 */
export type FakeProvider = (codes: string[]) => Promise<QuoteRecord[] | QuoteBatch>;

/** A fake Provider as the port wants it. */
export function fakeFetcher(fetch: FakeProvider): QuoteFetcher {
  return async (codes) => {
    const answer = await fetch(codes);
    return Array.isArray(answer) ? priced(answer) : answer;
  };
}

/** The permissive default: every requested contract "exists". The same fixture the Python uses, and
 *  for the same reason — a test must never reach the real moomoo SDK, which blocks indefinitely on a
 *  dead port, so a missing fake looks like a hung suite rather than a failure (CLAUDE.md). */
export const echoFetcher: QuoteFetcher = (codes) =>
  Promise.resolve(priced(codes.map((code) => ({ code }))));

/** A fetcher that returns the given figures per code, and nothing for a code it does not know. */
export function quoting(byCode: Record<string, QuoteRecord>): QuoteFetcher {
  return (codes) =>
    Promise.resolve(priced(codes.filter((c) => c in byCode).map((c) => ({ code: c, ...byCode[c] }))));
}

/** A Provider that cannot price a code containing `fragment`, and says so.
 *
 *  It used to REJECT the batch with moomoo's own sentence, because containment lived above the
 *  port and read that sentence. Now the port carries the answer: a fake Provider reports what it
 *  could not price, and moomoo's prose is tested where it is spoken, in `opend/client.test.ts`
 *  (#168). */
export function poisonable(fragment: string): QuoteFetcher {
  return (codes) => {
    const unknown = codes.filter((c) => c.includes(fragment));
    return Promise.resolve({
      records: codes.filter((c) => !unknown.includes(c)).map((code) => ({ code })),
      unknown,
    });
  };
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  /** whether OpenD answers; false matches the Python's test port, where nothing listens */
  opend?: boolean;
  /** The Provider's name, for the one test that checks /health prints it. */
  providerName?: string;
  /** the bounded OpenD call. Defaults to the permissive echo. */
  fetchQuotes?: FakeProvider;
}

export function harness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "optionality-http-"));
  const db = createDatabase(join(dir, "test.db"));
  const settings = settingsFor({
    apiToken: TOKEN,
    // the owner's own zone, so that a UTC-only test cannot pass by coincidence
    displayTz: "Asia/Singapore",
    // the dashboard refresh floor; low so tests can pick any interval
    monitorIntervalSeconds: 5,
    ...options.settings,
  });
  const sweeper = new FakeSweeper();

  const state = { now: NOW };
  const deps: Deps = {
    settings,
    db,
    now: () => state.now,
    sweeper,
    provider: {
      name: options.providerName ?? "moomoo",
      fetchQuotes: options.fetchQuotes ? fakeFetcher(options.fetchQuotes) : echoFetcher,
      reachable: () => Promise.resolve(options.opend ?? false),
      close: () => { /* nothing to hang up */ },
    },
  };

  const app = createApp(deps);
  const h: Harness = {
    app, db, settings, sweeper,
    get now() { return state.now; },
    set now(value: Date) { state.now = value; },
    close() {
      // a test may have closed it on purpose, to see what /health says when the database is gone
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
    async call(path, init = {}) {
      const { anonymous, headers, ...rest } = init;
      return app.request(path, {
        ...rest,
        headers: { ...(anonymous ? {} : AUTH), ...(headers as Record<string, string>) },
      });
    },
  };
  return h;
}

/** The fetcher the position tests want: every leg priced, so cost to close and P&L are real. */
export const pricedFetcher: QuoteFetcher = (codes) => Promise.resolve(priced(codes.map((code) => {
  const mids: Record<string, number> = { C8050: 5.0, C8075: 2.0, P7100: 3.0, P7075: 1.5 };
  const hit = Object.entries(mids).find(([suffix]) => code.endsWith(`${suffix}000`));
  return {
    code,
    mid_price: hit ? hit[1] : 1.0,
    option_delta: 0.2,
    option_contract_size: 100.0,
  };
})));

/** POST JSON, the shape nearly every write test needs. */
export function json(body: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The parsed JSON body of a response.
 *
 *  Typed loosely on purpose. A route test exists to assert the shape that goes over the wire, and
 *  taking that shape from the route's own inferred type would make the assertion agree with the
 *  implementation by construction — the test would then pass whatever the route returned. The
 *  types are checked where it means something instead: against `hc`, in hc.test-d.ts.
 */
export async function body(resp: Response): Promise<any> {
  return resp.json() as Promise<any>;
}
