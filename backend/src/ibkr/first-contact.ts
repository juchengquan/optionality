/** First contact: the five questions no amount of reading settles (ADR 0015, PR 6 of the plan).
 *
 *  Everything in `ibkr/` so far is proved against a stub, which proves its shape and nothing about
 *  a gateway. This is the other half — and it is split the way it is for one reason: the OBSERVING
 *  needs an account, and the READING does not. `tools/ibkr-first-contact.ts` is the thin part that
 *  reaches a real gateway; every judgement it then makes is a pure function here, with tests.
 *
 *  So the harness is honest about itself in the only way it can be: it can be wrong about the
 *  gateway, but it cannot quietly round an unanswered question up to an answer. Each probe returns
 *  one of three verdicts, and `unproven` is a first-class one — most of the five start there.
 *
 *  The questions, from §07 of the plan:
 *
 *  1. **Entitlements.** Do the figures the owner's rules actually watch arrive? Greeks need OPRA
 *     AND the CBOE index feed for SPX. This decides whether the Provider is usable at all.
 *  2. **The pre-flight.** What does a cold sweep really cost in calls, and is the documented empty
 *     first answer real?
 *  3. **Session life.** What does the service SEE when the browser session dies — an outage, or a
 *     watchlist of unknown contracts? The second would quarantine every rule the owner has (#167),
 *     which is the one failure shape this architecture cannot tolerate.
 *  4. **Rate limits**, against one sweep a minute plus a dashboard poll per open tab (ADR 0010).
 *  5. **Agreement.** The same contract through both Providers at the same moment. A silent
 *     disagreement would undermine every stored sample.
 */
import type { QuoteBatch, QuoteRecord } from "../quotes.ts";
import type { AuthStatus } from "./types.ts";

export type Verdict = "yes" | "no" | "unproven";

/** One question, what was observed about it, and whether that settles it. */
export interface Finding {
  question: string;
  verdict: Verdict;
  lines: string[];
}

/** One call the harness watched the client make. */
export interface CallLog {
  method: string;
  path: string;
  status: number;
  ms?: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Q1. Which of the fields the owner's rules watch actually arrived, and for how many contracts.
 *
 *  A field present for SOME contracts is an entitlement that exists — the gaps are illiquidity or
 *  a quote that has not printed, which is the sweep's business and already has a notice (#167). A
 *  field present for NONE is a subscription the account does not hold. And nothing priced at all
 *  is neither: an outage and an unentitled account look identical if you only count fields, and a
 *  harness that guessed would have the owner buying a subscription to fix a dead gateway.
 */
export function probeEntitlements(
  o: { watched: string[]; codes: string[]; batch: QuoteBatch },
): Finding {
  const question = "1. Do the figures the owner's rules watch arrive on this account?";
  const priced = o.batch.records.length;
  const lines = [`asked for ${o.codes.length} contract(s), priced ${priced}`];
  if (o.batch.unknown.length > 0) {
    lines.push(`no conid at all: ${o.batch.unknown.join(", ")}`);
  }
  if (priced === 0) {
    lines.push(
      "nothing was priced, so this says NOTHING about entitlements: an outage and an",
      "unentitled account are indistinguishable from here. Re-run with a gateway that answers.",
    );
    return { question, verdict: "unproven", lines };
  }

  const missing: string[] = [];
  for (const field of o.watched) {
    const have = o.batch.records.filter((r) => num(r[field]) !== null).length;
    lines.push(`${field}: ${have}/${priced} priced contracts carried it`);
    if (have === 0) missing.push(field);
  }
  if (missing.length === 0) return { question, verdict: "yes", lines };
  lines.push(
    `${missing.join(", ")} arrived for nothing — on this account that is an entitlement, not a`,
    "gap: greeks need the option (OPRA) AND the underlying index (CBOE Streaming Market Indexes),",
    "and OPRA does not include it. Every rule watching one of these can never be evaluated; the",
    "sweep will quarantine each with a notice rather than go quiet about it (#167).",
  );
  return { question, verdict: "no", lines };
}

const GROUPS = [
  ["/iserver/accounts", "accounts (pre-flight)"],
  ["/iserver/secdef/search", "secdef/search (underlying)"],
  ["/iserver/secdef/info", "secdef/info (one per month+strike+side)"],
  ["/iserver/marketdata/snapshot", "snapshot"],
  ["/tickle", "tickle (keepalive)"],
] as const;

function count(calls: CallLog[], prefix: string): number {
  return calls.filter((c) => c.path.startsWith(prefix)).length;
}

/** Q2. What the first sweep of a restarted process costs, and what the next one costs.
 *
 *  Both numbers, because only the difference is interesting: the conid cache is what makes the
 *  second cheap, and if it does not then the cache is not working.
 */
export function probePreflight(o: { cold: CallLog[]; warm: CallLog[] }): Finding {
  const lines = [
    `cold sweep: ${o.cold.length} call(s) to the gateway`,
    `warm sweep: ${o.warm.length} call(s) — the difference is the conid cache`,
  ];
  for (const [prefix, label] of GROUPS) {
    const cold = count(o.cold, prefix);
    const warm = count(o.warm, prefix);
    if (cold + warm > 0) lines.push(`  ${label}: ${cold} cold, ${warm} warm`);
  }
  const snapshots = count(o.cold, "/iserver/marketdata/snapshot");
  if (snapshots > 1) {
    lines.push(
      `the documented empty first answer is real: the first snapshot carried no figures, and it`,
      `took ${snapshots} request(s) before one did. The client's retry is load-bearing.`,
    );
  } else {
    lines.push(
      "the gateway answered first time with figures — the documented empty first answer did NOT",
      "happen here. The client's retry cost nothing, but it is also unexercised: it may be the",
      "cold-conid case only, which this run did not reach.",
    );
  }
  return { question: "2. What does a cold sweep cost, and is the empty first answer real?", verdict: "yes", lines };
}

/** Q3. The one failure shape this architecture cannot tolerate.
 *
 *  A quarantine disables a rule and says so on Telegram, and never deletes it (#167) — which is
 *  right for a contract that has expired or does not exist, and catastrophic for a browser login
 *  that lapsed overnight. So what a dead session looks like from inside the service is not a
 *  curiosity: if it reads as unknown contracts, the whole watchlist disables itself by morning.
 *
 *  A live session cannot answer it. The honest verdict there is `unproven`, with the instruction
 *  for how to answer it — logging the gateway out is the experiment.
 */
export function probeSession(o: {
  status: AuthStatus;
  /** the error a batch threw while the session was dead, if the owner ran that experiment */
  deadBatch?: string;
  /** the codes a batch reported UNKNOWN while the session was dead, if any */
  deadBatchUnknown?: string[];
}): Finding {
  const question = "3. What does the service see when the gateway's session dies?";
  const { authenticated, connected, competing } = o.status;
  const lines = [
    `/iserver/auth/status: authenticated=${authenticated} connected=${connected}`
    + `${competing === undefined ? "" : ` competing=${competing}`}`,
  ];
  if (competing) {
    lines.push(
      "competing=true: another session has taken the connection over. The client does not consult",
      "this flag — what it does to market data is exactly what this run should record.",
    );
  }
  if (o.deadBatchUnknown && o.deadBatchUnknown.length > 0) {
    lines.push(
      `with the session dead, a batch reported ${o.deadBatchUnknown.length} contract(s) UNKNOWN`,
      "rather than failing. This is the bad answer: the sweep would quarantine every one of them —",
      "disabled, with a Telegram notice each — because a browser login expired. The client must",
      "treat this gateway state as an outage before ibkr is used in anger.",
    );
    return { question, verdict: "no", lines };
  }
  if (o.deadBatch) {
    lines.push(
      `with the session dead, a batch threw: ${o.deadBatch}`,
      "which is the right answer: an outage. /health reports the Provider down, the top line",
      "paints bad, and nothing is quarantined for it.",
    );
    return { question, verdict: "yes", lines };
  }
  lines.push(
    "the session is alive, which says nothing about what a dead one does.",
    "To answer this: log the gateway out in its browser window (or let it lapse), then run this",
    "harness again — it records whichever of the two answers comes back, and only one of them is",
    "survivable.",
  );
  return { question, verdict: "unproven", lines };
}

/** Q4. How fast it actually went, against what this service asks of it. */
export function probeRate(o: {
  batches: { calls: number; ms: number; statuses: number[] }[];
  sweepSeconds: number;
}): Finding {
  const question = "4. What are the rate limits in practice?";
  const calls = o.batches.reduce((n, b) => n + b.calls, 0);
  const ms = o.batches.reduce((n, b) => n + b.ms, 0);
  const fastest = Math.max(...o.batches.map((b) => (b.ms > 0 ? (b.calls / b.ms) * 1000 : 0)));
  const refused = o.batches.flatMap((b) => b.statuses).filter((s) => s === 429 || s === 503);
  const lines = [
    `${o.batches.length} batch(es), ${calls} call(s), ${ms}ms total`,
    `fastest batch: ${fastest.toFixed(1)} req/s (the endpoint's documented limit is 10 req/s)`,
    `this service asks for one batch every ${o.sweepSeconds}s, plus one per dashboard poll per`,
    "open tab (ADR 0010) — so the budget is spent by tabs, not by the sweep",
  ];
  if (refused.length > 0) {
    lines.push(`the gateway REFUSED ${refused.length} call(s) with ${[...new Set(refused)].join(", ")}`);
    return { question, verdict: "no", lines };
  }
  return { question, verdict: "yes", lines };
}

/** How far apart two readings of the same figure may be before it is a disagreement rather than
 *  two instants. Prices move between the two calls; a greek barely does. */
const TOLERANCE: Record<string, number> = {
  mid_price: 0.02, bid_price: 0.02, ask_price: 0.02, last_price: 0.02,
  option_delta: 0.03, option_gamma: 0.05, option_theta: 0.05, option_vega: 0.05,
  option_implied_volatility: 0.03,
};
const DEFAULT_TOLERANCE = 0.02;

/** Q5. Whether the two Providers are describing the same instrument.
 *
 *  The factor-of-100 check is the point of this probe. `position_samples` stores IV and the vol
 *  attribution reads it, so 0.185 against 18.5 is not a disagreement about the market — it is a
 *  unit, it would pass every test in the suite, and it would corrupt every sample taken after the
 *  switch. Everything else is a sanity check; this one is the reason to run it.
 */
export function probeAgreement(o: { moomoo: QuoteRecord[]; ibkr: QuoteRecord[] }): Finding {
  const question = "5. Do the two Providers agree about the same contract?";
  const mine = new Map(o.moomoo.map((r) => [String(r.code), r]));
  const theirs = new Map(o.ibkr.map((r) => [String(r.code), r]));
  const shared = [...mine.keys()].filter((c) => theirs.has(c));
  if (shared.length === 0) {
    return {
      question, verdict: "unproven",
      lines: [
        `moomoo priced ${o.moomoo.length}, ibkr priced ${o.ibkr.length}, and no contract is in both.`,
        "Nothing can be compared — which is NOT agreement. Re-run with both gateways answering.",
      ],
    };
  }

  const lines: string[] = [`${shared.length} contract(s) priced by both`];
  let disagreed = false;
  for (const code of shared) {
    const a = mine.get(code)!;
    const b = theirs.get(code)!;
    for (const field of Object.keys(TOLERANCE)) {
      const x = num(a[field]);
      const y = num(b[field]);
      // a figure only one of them sent is question 1's business, not a disagreement
      if (x === null || y === null) continue;
      const scale = Math.max(Math.abs(x), Math.abs(y));
      const off = scale === 0 ? 0 : Math.abs(x - y) / scale;
      const tolerance = TOLERANCE[field] ?? DEFAULT_TOLERANCE;
      if (off <= tolerance) continue;
      disagreed = true;
      const ratio = y === 0 ? 0 : x / y;
      const hundredfold = Math.abs(ratio - 100) < 1 || Math.abs(ratio - 0.01) < 1e-4;
      lines.push(
        `${code} ${field}: moomoo ${x}, ibkr ${y} — ${(off * 100).toFixed(1)}% apart`
        + ` (tolerance ${(tolerance * 100).toFixed(0)}%)`,
      );
      if (hundredfold) {
        lines.push(
          `  a FACTOR OF 100, not a disagreement: one of them is reporting ${field} in the`,
          "  other's units. This would pass every test in the suite and corrupt every sample",
          "  stored after the switch — position_samples keeps this figure and the vol",
          "  attribution reads it. Fix the mapping before any deployment reads ibkr.",
        );
      }
    }
  }
  if (!disagreed) {
    lines.push("every figure both of them sent agrees inside tolerance");
    return { question, verdict: "yes", lines };
  }
  return { question, verdict: "no", lines };
}

/** Whether there is a gateway there at all, which is question 0 and the one most likely to fail
 *  on a first attempt.
 *
 *  The port-5000 note is not hypothetical: measured on this machine before any gateway existed,
 *  macOS ControlCenter holds 5000 for AirPlay Receiver — and 5000 is the gateway's own default.
 *  Without saying so, the first contact is a TLS error that reads like a gateway fault.
 */
/** What actually went wrong, out of the layers node buries it under.
 *
 *  `fetch` reports every transport failure as a bare `TypeError: fetch failed` and puts the reason
 *  in `cause` — sometimes two deep. Unwrapped, because the reason IS the diagnosis: a self-signed
 *  certificate and a refused connection need opposite things done about them, and the probe below
 *  cannot tell them apart from "fetch failed".
 */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let at: unknown = err;
  for (let depth = 0; depth < 5 && at !== undefined && at !== null; depth += 1) {
    const message = at instanceof Error ? at.message : String(at);
    const code = at instanceof Error ? (at as { code?: unknown }).code : undefined;
    const text = typeof code === "string" && !message.includes(code)
      ? `${message} (${code})` : message;
    if (text && !parts.includes(text)) parts.push(text);
    at = at instanceof Error ? (at as { cause?: unknown }).cause : undefined;
  }
  return parts.join(": ") || String(err);
}

export function probeReachable(o: { url: string; status?: AuthStatus; error?: string }): Finding {
  const question = "0. Is there a Client Portal gateway at this URL?";
  if (o.status) {
    return {
      question, verdict: "yes",
      lines: [
        `${o.url} answered /iserver/auth/status`,
        `authenticated=${o.status.authenticated} connected=${o.status.connected}`,
      ],
    };
  }
  const lines = [`${o.url} did not answer: ${o.error ?? "no reason given"}`];
  const port = (/:(\d+)/.exec(o.url) ?? [])[1];
  if (port === "5000") {
    lines.push(
      "port 5000 is the gateway's default AND, on macOS, AirPlay Receiver's: ControlCenter holds",
      "it unless AirPlay is turned off in System Settings > General > AirDrop & Handoff. Either",
      "turn that off, or move the gateway (conf.yaml: listenPort) and set IBKR_GATEWAY_URL to",
      "match. A reply from AirPlay reads exactly like a gateway fault.",
    );
  }
  if (/ECONNREFUSED/i.test(o.error ?? "")) {
    lines.push(
      "nothing is listening there at all: the gateway is not running, or is bound to a different",
      "port than IBKR_GATEWAY_URL names. Start it and check its conf.yaml listenPort.",
    );
  }
  if (/certificate/i.test(o.error ?? "")) {
    lines.push(
      "a certificate refusal is configuration, not a fault: the gateway serves TLS with a",
      "self-signed certificate and node is right to refuse it. Point NODE_EXTRA_CA_CERTS at the",
      "gateway's own certificate. Do NOT disable verification — this process holds the Telegram",
      "token and the positions database.",
    );
  }
  return { question, verdict: "no", lines };
}

/** The whole run, as something the owner reads once and acts on.
 *
 *  The count leads, and `unproven` is in it. A reader who stops after the first screen must not
 *  be able to mistake a question nobody answered for one that came back clean.
 */
export function report(findings: Finding[]): string {
  const by = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  const mark: Record<Verdict, string> = { yes: "[yes]", no: "[NO] ", unproven: "[?]  " };
  const out: string[] = [
    "IBKR first contact",
    "=".repeat(72),
    `${by("yes")} answered, ${by("no")} refuted, ${by("unproven")} unproven`,
    "",
  ];
  for (const f of findings) out.push(`${mark[f.verdict]} ${f.question}`);
  out.push("", "-".repeat(72), "");
  for (const f of findings) {
    out.push(`${mark[f.verdict]} ${f.question}`);
    for (const line of f.lines) out.push(`      ${line}`);
    out.push("");
  }
  out.push(
    "-".repeat(72),
    "This is one run against one account, on one day, at one moment of the session's life.",
    "It settles what it says it settles and nothing else; an unproven line above is a question",
    "still open, not a quiet pass.",
  );
  return out.join("\n");
}
