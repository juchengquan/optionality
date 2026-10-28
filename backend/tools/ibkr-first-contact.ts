/** First contact with a real Client Portal gateway (ADR 0015, PR 6 of the plan).
 *
 *  The thin half of the harness: this does the OBSERVING, and every judgement it reports is a
 *  pure function in `backend/src/ibkr/first-contact.ts` with tests of its own. That split is the
 *  only honest shape available — the observing needs an IBKR account, which no test has.
 *
 *  ## Run it like this
 *
 *      make ibkr-first-contact
 *
 *  It is **safe while the live service is up**: it opens the database READ-ONLY, writes nothing,
 *  sends no Telegram, and starts no bot. It does spend market-data calls — one extra moomoo batch
 *  for the agreement question, and a handful against the gateway.
 *
 *  It asks the gateway about the contracts the owner's own rules watch, because the question that
 *  matters is not "does IBKR serve greeks" but "does it serve the five fields these nine rules
 *  read". Pass `--codes a,b` to ask about something else, and `--no-moomoo` to skip the comparison
 *  when OpenD is down or its quota is spent.
 *
 *  Two things it cannot do by itself: question 3 needs the session to be DEAD, so the run says so
 *  and tells the owner to log the gateway out and run it again; and question 2's cold numbers are
 *  only cold because this process is new.
 */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

import { openReadOnly } from "../src/db/open.ts";
import { listMonitors } from "../src/db/queries.ts";
import { parseSpxCode } from "../src/domain/contract.ts";
import { settingsFromEnv } from "../src/env.ts";
import { IbkrClient } from "../src/ibkr/client.ts";
import {
  type CallLog, type Finding, describeFetchError, probeAgreement, probeEntitlements,
  probePreflight, probeRate, probeReachable, probeSession, report,
} from "../src/ibkr/first-contact.ts";
import type { AuthStatus } from "../src/ibkr/types.ts";
import { moomooProvider } from "../src/opend/provider.ts";
import type { QuoteBatch } from "../src/quotes.ts";

const args = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
}
const settings = settingsFromEnv();
const gatewayUrl = option("url", settings.ibkrGatewayUrl)!;
const limit = Number(option("limit", "8"));

/** Every call this run made, in order, so question 2 can count them and question 4 can time them.
 *  The client takes its `fetch` from its config, which is what makes this possible without the
 *  client knowing it is being watched. */
const calls: CallLog[] = [];
async function watchedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const started = performance.now();
  const path = String(url).replace(gatewayUrl, "");
  try {
    const response = await globalThis.fetch(url, init);
    calls.push({
      method: init?.method ?? "GET", path, status: response.status,
      ms: Math.round(performance.now() - started),
    });
    return response;
  } catch (err) {
    // status 0 for "never answered": question 4 counts refusals, and a transport failure is not
    // a refusal — it is the gateway not being there, which question 0 reports
    calls.push({ method: init?.method ?? "GET", path, status: 0, ms: Math.round(performance.now() - started) });
    throw err;
  }
}
function since(mark: number): CallLog[] {
  return calls.slice(mark);
}
function newClient(): IbkrClient {
  return new IbkrClient({
    baseUrl: gatewayUrl, fetch: watchedFetch as unknown as typeof globalThis.fetch,
    // no keepalive: this process lives for seconds, and an interval would be noise in the counts
    tickleEverySeconds: 0,
  });
}

/** The contracts and the figures the owner's rules actually watch.
 *
 *  Read-only, because the live service is the one writer and its alarm rows tolerate no second
 *  (CLAUDE.md). A combo's own code is not a contract — `1120_IC` is a name — so only codes the
 *  domain can parse are asked about.
 */
function fromWatchlist(): { codes: string[]; watched: string[] } {
  const given = option("codes");
  const db = openReadOnly(settings.dbPath);
  try {
    const rows = listMonitors(db);
    const watched = [...new Set(rows.map((r) => r.field))].sort();
    const codes = given
      ? given.split(",").map((c) => c.trim()).filter(Boolean)
      : [...new Set(rows.map((r) => r.code).filter((c) => parseSpxCode(c) !== null))];
    return { codes: codes.slice(0, limit), watched };
  } finally {
    db.close();
  }
}

const { codes, watched } = fromWatchlist();
const findings: Finding[] = [];

// Question 0, and the one most likely to be the whole answer on a first attempt.
let status: AuthStatus | undefined;
let reachError: string | undefined;
try {
  const response = await watchedFetch(`${gatewayUrl}/iserver/auth/status`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  status = await response.json() as AuthStatus;
} catch (err) {
  // unwrapped: node buries the reason in `cause`, and the reason is the diagnosis
  reachError = describeFetchError(err);
}
findings.push(probeReachable({ url: gatewayUrl, status, error: reachError }));

if (!status) {
  console.log(report(findings));
  console.log("\nNothing else could be asked. Fix the above and run again.");
  process.exit(1);
}

console.log(`asking about ${codes.length} contract(s) the watchlist watches: ${codes.join(", ")}`);
console.log(`fields those rules read: ${watched.join(", ")}\n`);

// Questions 1 and 2. A new client, so these numbers are a restarted process's first sweep.
const client = newClient();
const coldMark = calls.length;
let cold: QuoteBatch = { records: [], unknown: [] };
let coldError: string | undefined;
try {
  cold = await client.batch(codes);
} catch (err) {
  coldError = describeFetchError(err);
}
const coldCalls = since(coldMark);

const warmMark = calls.length;
if (!coldError) await client.batch(codes).catch(() => { /* counted below */ });
const warmCalls = since(warmMark);

findings.push(probeEntitlements({ watched, codes, batch: cold }));
findings.push(probePreflight({ cold: coldCalls, warm: warmCalls }));

// Question 3. A live session cannot answer it; `probeSession` says so and says how.
findings.push(probeSession({
  status,
  deadBatch: status.authenticated === false ? coldError : undefined,
  deadBatchUnknown: status.authenticated === false ? cold.unknown : undefined,
}));

// Question 4. Three batches back to back, which is harder than this service ever asks.
const batches: { calls: number; ms: number; statuses: number[] }[] = [];
for (let i = 0; i < 3; i += 1) {
  const mark = calls.length;
  const started = performance.now();
  await client.batch(codes).catch(() => { /* a refusal is the reading */ });
  const made = since(mark);
  batches.push({
    calls: made.length, ms: Math.round(performance.now() - started),
    statuses: made.map((c) => c.status),
  });
}
findings.push(probeRate({ batches, sweepSeconds: settings.monitorIntervalSeconds }));

// Question 5. Both at once, because "the same instant" is the whole point of the comparison.
if (args.includes("--no-moomoo")) {
  findings.push({
    question: "5. Do the two Providers agree about the same contract?",
    verdict: "unproven",
    lines: ["skipped with --no-moomoo; nothing was compared, which is not agreement"],
  });
} else {
  const moomoo = moomooProvider(settings);
  try {
    const [mine, theirs] = await Promise.all([
      moomoo.fetchQuotes(codes).catch((err: unknown) => {
        console.warn(`moomoo did not answer: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [], unknown: [] } as QuoteBatch;
      }),
      client.batch(codes).catch(() => ({ records: [], unknown: [] }) as QuoteBatch),
    ]);
    findings.push(probeAgreement({ moomoo: mine.records, ibkr: theirs.records }));
  } finally {
    moomoo.close();
  }
}

client.close();

const text = report(findings);
console.log(text);
const out = option("out");
if (out) {
  writeFileSync(out, `${text}\n`);
  console.log(`\nwritten to ${out}`);
}
