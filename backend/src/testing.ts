/** Building the app for a test (ADR 0009, phase 5).
 *
 *  The counterpart of the Python's `client_factory`, and it keeps that fixture's most important
 *  property: a test can NEVER reach the real moomoo SDK, because it blocks indefinitely on a dead
 *  port and a missing fake looks like a hung suite (CLAUDE.md). Here the ports simply have no real
 *  implementations yet — the worker, scheduler and sweeper arrive in phase 6 — so the fakes below
 *  are the only thing they can be.
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
import type { CreateRunArgs } from "./ports.ts";
import type { QuoteFetcher, QuoteRecord } from "./quotes.ts";

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

/** A worker that records instead of running. One worker owns run execution, and in a route test
 *  the thing under test is that the route handed over an id — not what happened next. */
export class FakeWorker {
  readonly submitted: string[] = [];
  queueDepth(): number {
    return this.submitted.length;
  }
  submit(runId: string): void {
    this.submitted.push(runId);
  }
}

export class FakeRunFactory {
  readonly created: CreateRunArgs[] = [];
  private n = 0;
  createRun(args: CreateRunArgs): string {
    this.created.push(args);
    this.n += 1;
    return `run${this.n}`.padEnd(32, "0");
  }
}

export class FakeScheduler {
  refreshes = 0;
  refreshJobs(): void {
    this.refreshes += 1;
  }
}

/** A sweeper that has never swept, which is what a freshly started service looks like. */
export class FakeSweeper {
  sweepAt: Date | null = null;
  fetchAt: Date | null = null;
  ok = true;
  failures = 0;
  label = "watching";
  bad = false;
  lastSweepAt() { return this.sweepAt; }
  lastFetchAt() { return this.fetchAt; }
  lastSweepOk() { return this.ok; }
  consecutiveFailures() { return this.failures; }
  alarmState() { return { label: this.label, bad: this.bad }; }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  db: DatabaseSync;
  settings: Settings;
  worker: FakeWorker;
  runs: FakeRunFactory;
  scheduler: FakeScheduler;
  sweeper: FakeSweeper;
  /** What the clock returns. Set it to state the time rather than wait for it. */
  now: Date;
  close(): void;
  /** `fetch` against the app, with the bearer token unless `anonymous` is passed. */
  call(path: string, init?: RequestInit & { anonymous?: boolean }): Promise<Response>;
}

/** The permissive default: every requested contract "exists". The same fixture the Python uses, and
 *  for the same reason — a test must never reach the real moomoo SDK, which blocks indefinitely on a
 *  dead port, so a missing fake looks like a hung suite rather than a failure (CLAUDE.md). */
export const echoFetcher: QuoteFetcher = (codes) =>
  Promise.resolve(codes.map((code) => ({ code })));

/** A fetcher that returns the given figures per code, and nothing for a code it does not know. */
export function quoting(byCode: Record<string, QuoteRecord>): QuoteFetcher {
  return (codes) => Promise.resolve(codes.filter((c) => c in byCode).map((c) => ({ code: c, ...byCode[c] })));
}

/** A fetcher that rejects the whole batch while a code containing `fragment` is in it, as moomoo
 *  does — and names the culprit WITHOUT its market prefix, which is why fetchResilient matches the
 *  name as a suffix rather than for equality. */
export function poisonable(fragment: string): QuoteFetcher {
  return (codes) => {
    const bad = codes.filter((c) => c.includes(fragment));
    if (bad.length > 0) {
      return Promise.reject(new Error(`snapshot API failed: Unknown stock. ${bad[0]!.replace(/^US\./, "")}`));
    }
    return Promise.resolve(codes.map((code) => ({ code })));
  };
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  /** whether OpenD answers; false matches the Python's test port, where nothing listens */
  opend?: boolean;
  /** the bounded OpenD call. Defaults to the permissive echo. */
  fetchQuotes?: QuoteFetcher;
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
  const worker = new FakeWorker();
  const runs = new FakeRunFactory();
  const scheduler = new FakeScheduler();
  const sweeper = new FakeSweeper();

  const state = { now: NOW };
  const deps: Deps = {
    settings,
    db,
    now: () => state.now,
    worker,
    runs,
    scheduler,
    sweeper,
    opendReachable: () => Promise.resolve(options.opend ?? false),
    fetchQuotes: options.fetchQuotes ?? echoFetcher,
    htmlDocument: (body) => `<html><body>${body}</body></html>`,
  };

  const app = createApp(deps);
  const h: Harness = {
    app, db, settings, worker, runs, scheduler, sweeper,
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
export const pricedFetcher: QuoteFetcher = (codes) => Promise.resolve(codes.map((code) => {
  const mids: Record<string, number> = { C8050: 5.0, C8075: 2.0, P7100: 3.0, P7075: 1.5 };
  const hit = Object.entries(mids).find(([suffix]) => code.endsWith(`${suffix}000`));
  return {
    code,
    mid_price: hit ? hit[1] : 1.0,
    option_delta: 0.2,
    option_contract_size: 100.0,
  };
}));

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
