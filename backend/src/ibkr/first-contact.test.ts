/** The first-contact harness's readings, which is the part of it that can be proved (ADR 0015).
 *
 *  The harness itself reaches a real gateway, and nobody here has one — that is the whole reason
 *  it exists. So it is split: the probes are pure functions over what was observed, tested here
 *  against observations written by hand, and `tools/ibkr-first-contact.ts` is the thin part that
 *  does the observing. What these tests prove is that a reading is reported HONESTLY — that
 *  "unproven" is said when nothing was learned, and that the one answer which would quietly
 *  corrupt every stored sample is the one the harness shouts about.
 */
import { describe, expect, it } from "vitest";

import {
  describeFetchError, probeAgreement, probeEntitlements, probePreflight, probeRate,
  probeReachable, probeSession, report,
} from "./first-contact.ts";

const CALL = "US.SPXW261030C8100000";
const PUT = "US.SPXW261030P7900000";

describe("question 1 — do the figures the owner's rules watch arrive", () => {
  it("answers yes, naming the fields it saw", () => {
    const finding = probeEntitlements({
      watched: ["option_delta", "mid_price"],
      codes: [CALL, PUT],
      batch: {
        records: [
          { code: CALL, mid_price: 4.5, option_delta: 0.17 },
          { code: PUT, mid_price: 3.1, option_delta: -0.14 },
        ],
        unknown: [],
      },
    });
    expect(finding.verdict).toBe("yes");
    expect(finding.lines.join("\n")).toMatch(/option_delta.*2\/2/);
  });

  it("answers no when a watched figure arrived for nothing at all", () => {
    // the risk the whole plan was built around: greeks need OPRA AND the index feed, and five of
    // the owner's nine rules watch option_delta. A Provider that cannot serve them is unusable,
    // and this is the question that decides it.
    const finding = probeEntitlements({
      watched: ["option_delta", "mid_price"],
      codes: [CALL, PUT],
      batch: {
        records: [{ code: CALL, mid_price: 4.5 }, { code: PUT, mid_price: 3.1 }],
        unknown: [],
      },
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/option_delta.*0\/2/);
    expect(finding.lines.join("\n")).toMatch(/entitle/i);
  });

  it("calls a figure that arrived for some contracts an entitlement, not a gap", () => {
    // a field present for one contract and absent for another is served by the account and
    // missing for that contract — illiquidity, or a quote that has not printed. The entitlement
    // question is answered yes; the gaps are the sweep's business (#167), not this harness's.
    const finding = probeEntitlements({
      watched: ["option_delta"],
      codes: [CALL, PUT],
      batch: { records: [{ code: CALL, option_delta: 0.17 }, { code: PUT }], unknown: [] },
    });
    expect(finding.verdict).toBe("yes");
    expect(finding.lines.join("\n")).toMatch(/1\/2/);
  });

  it("says unproven when nothing was priced, instead of blaming the subscriptions", () => {
    // an outage and an unentitled account look identical from here if you only count fields. A
    // harness that reported "no" would have the owner buying a subscription to fix a dead gateway.
    const finding = probeEntitlements({
      watched: ["option_delta"], codes: [CALL], batch: { records: [], unknown: [] },
    });
    expect(finding.verdict).toBe("unproven");
  });

  it("says which contracts the gateway could not place at all", () => {
    const finding = probeEntitlements({
      watched: ["option_delta"], codes: [CALL, PUT],
      batch: { records: [{ code: CALL, option_delta: 0.1 }], unknown: [PUT] },
    });
    expect(finding.lines.join("\n")).toContain(PUT);
  });
});

describe("question 2 — what a cold sweep really costs", () => {
  it("counts the calls, cold and warm, by what they were for", () => {
    const finding = probePreflight({
      cold: [
        { method: "GET", path: "/iserver/accounts", status: 200 },
        { method: "GET", path: "/iserver/secdef/search?symbol=SPX", status: 200 },
        { method: "GET", path: "/iserver/secdef/info?conid=1&strike=8100", status: 200 },
        { method: "GET", path: "/iserver/secdef/info?conid=1&strike=7900", status: 200 },
        { method: "GET", path: "/iserver/marketdata/snapshot?conids=1,2", status: 200 },
        { method: "GET", path: "/iserver/marketdata/snapshot?conids=1,2", status: 200 },
      ],
      warm: [{ method: "GET", path: "/iserver/marketdata/snapshot?conids=1,2", status: 200 }],
    });
    expect(finding.verdict).toBe("yes");
    const text = finding.lines.join("\n");
    expect(text).toMatch(/cold.*6/);
    expect(text).toMatch(/warm.*1/);
    expect(text).toMatch(/secdef\/info.*2/);
  });

  it("says so when the documented empty first answer actually happened", () => {
    // the reference says the first snapshot for a conid returns no data. The client retries for
    // it; whether that is real is one of the things only a gateway can say.
    const finding = probePreflight({
      cold: [
        { method: "GET", path: "/iserver/marketdata/snapshot?conids=1", status: 200 },
        { method: "GET", path: "/iserver/marketdata/snapshot?conids=1", status: 200 },
      ],
      warm: [{ method: "GET", path: "/iserver/marketdata/snapshot?conids=1", status: 200 }],
    });
    expect(finding.lines.join("\n")).toMatch(/empty first answer is real/i);
  });

  it("says so when it is not, which would mean the retry is dead weight", () => {
    const finding = probePreflight({
      cold: [{ method: "GET", path: "/iserver/marketdata/snapshot?conids=1", status: 200 }],
      warm: [{ method: "GET", path: "/iserver/marketdata/snapshot?conids=1", status: 200 }],
    });
    expect(finding.lines.join("\n")).toMatch(/answered first time/i);
  });
});

describe("question 3 — what a dead session looks like from in here", () => {
  it("reports a live session as live, and says the question is still open", () => {
    // a session that is alive tells you nothing about what a dead one does. The honest verdict is
    // unproven until the owner logs the gateway out and runs it again.
    const finding = probeSession({ status: { authenticated: true, connected: true } });
    expect(finding.verdict).toBe("unproven");
    expect(finding.lines.join("\n")).toMatch(/log the gateway out/i);
  });

  it("reports what the service actually saw when the session was dead", () => {
    const finding = probeSession({
      status: { authenticated: false, connected: true },
      deadBatch: "ibkr GET /iserver/marketdata/snapshot failed: HTTP 401",
    });
    expect(finding.verdict).toBe("yes");
    const text = finding.lines.join("\n");
    expect(text).toMatch(/401/);
    expect(text, "an outage, not a watchlist of unknown contracts").toMatch(/threw/i);
  });

  it("says it loudly when a dead session reads as contracts that do not exist", () => {
    // the failure shape this architecture cannot tolerate: a quarantine disables rules and says so
    // on Telegram (#167), so a session lapse that reads as unknown contracts would disable the
    // owner's whole watchlist overnight on the strength of a browser login expiring.
    const finding = probeSession({
      status: { authenticated: false, connected: true },
      deadBatchUnknown: [CALL, PUT],
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/would quarantine/i);
  });

  it("notes a competing session rather than guessing what it does", () => {
    // the status line prints `competing=` either way, so this asserts on the EXPLANATION: the
    // client deliberately does not consult the flag, and what it does to market data is one of
    // the things a first run should record.
    const finding = probeSession({
      status: { authenticated: true, connected: true, competing: true },
    });
    expect(finding.lines.join("\n")).toMatch(/another session has taken the connection over/i);
    const quiet = probeSession({ status: { authenticated: true, connected: true } });
    expect(quiet.lines.join("\n")).not.toMatch(/taken the connection over/i);
  });
});

describe("question 4 — the rate limit, against this service's cadence", () => {
  it("reports the fastest it actually went, and the budget it is against", () => {
    const finding = probeRate({
      batches: [
        { calls: 3, ms: 400, statuses: [200, 200, 200] },
        { calls: 1, ms: 90, statuses: [200] },
        { calls: 1, ms: 95, statuses: [200] },
      ],
      sweepSeconds: 60,
    });
    expect(finding.verdict).toBe("yes");
    expect(finding.lines.join("\n")).toMatch(/11\.1 req\/s|11 req\/s/);
  });

  it("says no when the gateway started refusing", () => {
    const finding = probeRate({
      batches: [{ calls: 2, ms: 100, statuses: [200, 429] }], sweepSeconds: 60,
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/429/);
  });

  it("counts a 503 as a refusal too, because it is what an overloaded gateway answers", () => {
    // 429 is the documented one; a gateway buckling under a burst answers 503, and for THIS
    // question both mean the same thing — it would not take what this service asked of it
    const finding = probeRate({
      batches: [{ calls: 2, ms: 100, statuses: [200, 503] }], sweepSeconds: 60,
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/503/);
  });
});

describe("question 5 — whether the two providers agree", () => {
  it("answers yes when both priced the same contract the same way", () => {
    const finding = probeAgreement({
      moomoo: [{ code: CALL, mid_price: 4.5, option_delta: 0.17, option_implied_volatility: 18.5 }],
      ibkr: [{ code: CALL, mid_price: 4.52, option_delta: 0.171, option_implied_volatility: 18.6 }],
    });
    expect(finding.verdict).toBe("yes");
  });

  it("shouts when one of them is reporting IV in the other's units", () => {
    // the one disagreement that would pass every test in the suite and corrupt every stored
    // sample: `position_samples` keeps IV, the vol attribution reads it, and 0.185 against 18.5
    // is not a disagreement about the market — it is a factor of 100.
    const finding = probeAgreement({
      moomoo: [{ code: CALL, option_implied_volatility: 18.5 }],
      ibkr: [{ code: CALL, option_implied_volatility: 0.185 }],
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/factor of 100/i);
  });

  it("reports a real disagreement as a disagreement, with the numbers", () => {
    const finding = probeAgreement({
      moomoo: [{ code: CALL, mid_price: 4.5 }], ibkr: [{ code: CALL, mid_price: 6.2 }],
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/4\.5.*6\.2/);
  });

  it("tolerates a tick of difference, because the two were not asked at the same instant", () => {
    const finding = probeAgreement({
      moomoo: [{ code: CALL, mid_price: 4.5 }], ibkr: [{ code: CALL, mid_price: 4.55 }],
    });
    expect(finding.verdict).toBe("yes");
  });

  it("says unproven when only one of them priced anything", () => {
    // which is the state the owner will be in if moomoo's quota is spent or OpenD is down, and it
    // must not read as agreement
    expect(probeAgreement({
      moomoo: [], ibkr: [{ code: CALL, mid_price: 4.5 }],
    }).verdict).toBe("unproven");
  });

  it("compares only the fields both of them sent", () => {
    // IBKR sends no update_time and no rho. An absent figure on one side is question 1's
    // business, not a disagreement about the market.
    // option_theta, which IS one of the compared fields — unlike option_rho and update_time,
    // which IBKR never sends and this probe never looks at. A field on one side only must not
    // read as a 100% disagreement, which is what comparing it against nothing computes.
    const finding = probeAgreement({
      moomoo: [{ code: CALL, mid_price: 4.5, option_theta: -0.85, option_rho: 0.3 }],
      ibkr: [{ code: CALL, mid_price: 4.5 }],
    });
    expect(finding.verdict).toBe("yes");
    expect(finding.lines.join("\n")).not.toMatch(/option_theta|option_rho/);
  });
});

describe("whether there is a gateway there at all", () => {
  it("names what answered when it was not the gateway", () => {
    // measured on the owner's own machine before any gateway existed: macOS ControlCenter holds
    // port 5000 for AirPlay Receiver, which is the gateway's default port. Without this the first
    // contact would be a TLS error that reads like a gateway fault.
    const finding = probeReachable({
      url: "https://127.0.0.1:5000/v1/api", error: "self-signed certificate",
    });
    expect(finding.verdict).toBe("no");
    expect(finding.lines.join("\n")).toMatch(/AirPlay/i);
  });

  it("explains a certificate refusal as the configuration it is", () => {
    const finding = probeReachable({
      url: "https://127.0.0.1:5001/v1/api", error: "unable to verify the first certificate",
    });
    expect(finding.lines.join("\n")).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(finding.lines.join("\n"), "never this").not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it("says nothing is listening when nothing is", () => {
    // the difference between a gateway that is down and a gateway that is wrong: one is "start
    // it", the other is "look at what answered"
    const finding = probeReachable({
      url: "https://127.0.0.1:5001/v1/api", error: "fetch failed: connect ECONNREFUSED",
    });
    expect(finding.lines.join("\n")).toMatch(/nothing is listening/i);
  });

  it("says yes when the gateway answered its own status endpoint", () => {
    const finding = probeReachable({
      url: "https://127.0.0.1:5001/v1/api", status: { authenticated: true, connected: true },
    });
    expect(finding.verdict).toBe("yes");
  });
});

describe("what actually went wrong", () => {
  it("unwraps the reason node hides behind 'fetch failed'", () => {
    // node's fetch reports every transport failure as a bare TypeError and puts the reason in
    // `cause`. Without unwrapping it, the certificate and refused-connection advice below can
    // never fire, and the owner's first contact reads "fetch failed" and nothing else.
    const err = new TypeError("fetch failed", { cause: new Error("self-signed certificate") });
    expect(describeFetchError(err)).toBe("fetch failed: self-signed certificate");
  });

  it("includes an errno code the message itself does not mention", () => {
    // undici's real shape, measured on this machine against the port AirPlay holds: the message
    // names an address and a timeout, and the only word that says WHAT happened is the code.
    const cause = Object.assign(
      new Error("Connect Timeout Error (attempted address: 127.0.0.1:5000, timeout: 10000ms)"),
      { code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    expect(describeFetchError(new TypeError("fetch failed", { cause })))
      .toMatch(/UND_ERR_CONNECT_TIMEOUT/);
  });

  it("does not repeat a code the message already carries", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5001"), {
      code: "ECONNREFUSED",
    });
    expect(describeFetchError(new TypeError("fetch failed", { cause })))
      .toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:5001");
  });

  it("does not repeat a cause that says the same thing twice", () => {
    const inner = new Error("boom");
    expect(describeFetchError(new Error("boom", { cause: inner }))).toBe("boom");
  });

  it("says something for a thing that is not an error at all", () => {
    expect(describeFetchError("weird")).toBe("weird");
  });
});

describe("the report", () => {
  it("leads with what was settled and what was not", () => {
    const text = report([
      { question: "q1", verdict: "yes", lines: ["EVIDENCE-ONE"] },
      { question: "q2", verdict: "no", lines: ["EVIDENCE-TWO"] },
      { question: "q3", verdict: "unproven", lines: ["EVIDENCE-THREE"] },
    ]);
    expect(text).toMatch(/1 answered, 1 refuted, 1 unproven/);
    // a reader who stops after the first screen must not mistake an unanswered question for a
    // settled one: the count and all three verdicts come before any evidence
    expect(text.indexOf("1 answered")).toBeLessThan(text.indexOf("EVIDENCE-ONE"));
    expect(text.indexOf("q3")).toBeLessThan(text.indexOf("EVIDENCE-ONE"));
  });

  it("says plainly that it proves nothing about a gateway it never reached", () => {
    const text = report([{ question: "q", verdict: "unproven", lines: [] }]);
    expect(text).toMatch(/one run against one account/i);
  });
});
