/** The redesigned page as a whole (ADR 0023, #287): what it asks the service for in session and out
 *  of it, that it draws the same page at every hour, and the settings that change what it draws. Layout is the browser suite's (`NextLayout`); this is
 *  behaviour, which jsdom can answer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { until } from "../testing/until";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
const spread = {
  id: "w1", code: "1218_7150P", strike_date: "2026-12-18", option_type: "CMB",
  field: "mid_price", threshold: 6.01, direction: "above", compare: "abs", triggered: false,
  quote: null, legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 }],
  combo_value: 2, combo_greeks: {}, dte: 38, scope: null, positions: [], cost_to_close: null,
  entry: null, pnl: null, fill: 33, schedule: null, watched: 2, distance: 4.01, in_combos: [],
  held: false,
};
const shortLeg = {
  ...spread, id: "w2", code: "US.SPXW261218P7150000", option_type: "PUT", field: "option_delta",
  threshold: 0.2, legs: undefined, combo_value: undefined, combo_greeks: undefined,
  quote: { name: "SPXW 261218 7150.00P", option_delta: -0.15 }, watched: -0.15, distance: 0.05,
  in_combos: ["w1"],
};
const quarantined = {
  id: "q1", code: "US.SPXW261211C8300000", strike_date: "2026-12-11", option_type: "CALL",
  strike: 8300, field: "option_delta", threshold: 0.1, direction: "above", compare: "abs",
  legs: null, enabled: false, scope: null, positions: [], disabled_reason: "unknown-contract",
  triggered: false, last_value: null, last_checked_at: null, created_at: null,
};
const holding = {
  id: "p1", name: "1231_7000P", strategy: null, strike_date: "2026-12-31", contracts: 1,
  entry: 3, legs: [{ side: "short", option_type: "PUT", strike: 7000 }, { side: "long", option_type: "PUT", strike: 6950 }],
  created_at: null, opened_at: "2026-11-03", closed_on: null, exit: null, realized_points: null,
  cost_to_close: 1.2, pnl: 180, contract_size: 100, greeks: {}, fetched_at: "x", dte: 51,
  schedule: null, captured: 0.6,
};

const holdingRule = {
  ...spread, id: "r1", code: "1231_7000P", strike_date: "2026-12-31", field: "option_delta",
  threshold: 0.3, positions: [{ id: "p1", name: "1231_7000P" }], scope: "all", held: true,
  watched: 0.22, distance: 0.08,
};

const reference = {
  id: "ref1", code: "US..SPX", label: "S&P 500", source: "moomoo", figure: 7612.25, change: 0.0042,
  field: "mid_price", name: "S&P 500", error: null, last_known: false,
};
/** a Reference its source could not price: a dash, read at a time like any other */
const unread = {
  id: "ref2", code: "VIX", label: null, source: "ibkr", figure: null, change: null, field: null,
  name: null, error: "no ibkr client in this build", last_known: null,
};
/** what the fake service serves, and the stamps it writes on them in DISPLAY_TZ (+08:00) — never
 *  the zone this suite runs in (TZ=UTC), so a time drawn from the device's clock would differ */
let references: object[] = [];
let referenceStamp = "";
let holdingStamp = "";
/** the market-closed line, wherever the arrangement draws it */
const closedLine = () => document.querySelector<HTMLElement>(".nx-mkt-closed");

/** the GETs the page made, by path; writes are kept apart in `writes` */
let calls: string[] = [];
let writes: string[] = [];
/** every GET since the test began, with when — `calls` is reset, this is not — and how many of
 *  them the fake service has not yet answered */
let heard: string[] = [];
let unanswered = 0;
/** what the page asked for, in order and when, for a failure to say */
const said = () => `asked since the reset: ${JSON.stringify(calls)}\nall, in ms:\n${heard.join("\n")}`;
/** paths the fake service refuses, with a 502 as a Provider outage gives */
let refusing = new Set<string>();
let quotes: object[] = [spread, shortLeg];
/** when set, every valuation waits for the test to settle it, in the order asked */
let held: { settle: (ok: boolean, body?: unknown) => void }[] | null = null;

const reply = (ok: boolean, body: unknown) => Promise.resolve(ok
  ? { ok: true, status: 200, json: () => Promise.resolve(body) }
  : { ok: false, status: 502, json: () => Promise.resolve({ detail: "moomoo call failed" }) });

function serve() {
  calls = [];
  writes = [];
  heard = [];
  unanswered = 0;
  refusing = new Set();
  quotes = [spread, shortLeg];
  held = null;
  references = [reference, unread];
  referenceStamp = "2026-11-10 06:58:11+08:00";
  holdingStamp = "2026-11-10 07:00:12+08:00";
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    if (init?.method && init.method !== "GET") {
      writes.push(`${init.method} ${path}`);
      return reply(true, {});
    }
    calls.push(path);
    heard.push(`${performance.now().toFixed(1)} ${path}`);
    unanswered += 1;
    const answered = <T,>(p: Promise<T>) => p.finally(() => { unanswered -= 1; });
    if (path === "/positions/values" && held) {
      const queue = held;
      return answered(new Promise((resolve) => {
        queue.push({ settle: (ok, body = [{ ...holding, fetched_at: holdingStamp }]) => resolve(reply(ok, body)) });
      }));
    }
    if (refusing.has(path)) return answered(reply(false, null));
    const body = path === "/quotes" ? quotes
      : path === "/monitors" ? [quarantined]
        : path === "/health" ? health
          : path === "/references" ? references.map((r) => ({ fetched_at: referenceStamp, ...r }))
            : path === "/positions/values" ? [{ ...holding, fetched_at: holdingStamp }]
              // every holding on record, as stored: the closed trades' fold reads it (#296, #373)
              : path === "/positions" ? [holding]
                // its days, an empty week: the shape the service answers, so the history drawn
                // (#353) is drawn from samples rather than said to be unreadable
                : path === "/positions/p1/samples" ? { levels: null, plan: [], samples: [] } : null;
    return answered(reply(true, body));
  }) as unknown as typeof fetch;
}

/** A Monday in the session (10:00 EST) or a Sunday, so the clock decides the session. Only the
 *  clock and the poll's interval are faked: the fetches resolve on real microtasks. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date(iso) });
}
const SESSION = "2026-11-09T15:00:00Z";
const SUNDAY = "2026-11-08T15:00:00Z";

/** How long a wait on a condition may take under a full suite's load, well past waitFor's 1s. */
const SLOW = 10_000;

/** Until the page has stopped asking: every request answered, and none new for QUIET turns of
 *  the event loop, each drawn through `act` — so a read that an answer sets off (a holding drawn,
 *  then its samples asked for) has been asked by the next turn. What the page reads is whatever it
 *  asks for, not a list kept here: a read added outside the session is waited for without this test knowing
 *  its name. Turns, not milliseconds — every request here is answered on microtasks — so load
 *  cannot make it stop early. */
const QUIET = 3;
async function quiet() {
  let still = 0;
  let seen = -1;
  await until(() => {
    if (unanswered === 0 && heard.length === seen) still += 1;
    else { still = 0; seen = heard.length; }
    expect(still, `still asking (${unanswered} unanswered)\n${said()}`).toBeGreaterThanOrEqual(QUIET);
  });
}

async function open() {
  render(<Next />);
  await waitFor(() => expect(screen.getByText("1218_7150P")).toBeTruthy(), { timeout: SLOW });
}

const COOKIES = ["ui_up", "ui_entry", "ui_privacy", "ui_arrangement", "ui_refresh"];
beforeEach(serve);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const n of COOKIES) document.cookie = `${n}=;path=/;max-age=0`;
});

/** How many times each path was asked, since the last reset of `calls`. */
const count = (path: string) => calls.filter((c) => c === path).length;
const LINE = ["/quotes", "/monitors", "/health"];
const VALUED = ["/positions/values", "/references"];
/** Monday 18:00 New York, after the close */
const EVENING = "2026-11-09T23:00:00Z";

/** `n` polls of the page's interval, each waited out until the page has stopped asking. */
async function polls(n: number) {
  for (let i = 0; i < n; i++) {
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await quiet();
  }
}

/** The session clock read again now, as a phone woken or a window focused reads it. */
async function readClock(iso: string) {
  vi.setSystemTime(new Date(iso));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}

describe("what it asks for, by New York's session (#371)", () => {
  for (const where of ["desk", "phone"] as const) {
    it(`polls the line, the holdings and the References in session on the ${where}`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(SESSION);
      await open();
      await quiet();
      calls = [];
      await polls(3);
      for (const path of [...LINE, ...VALUED]) expect(count(path), `${path}, each poll\n${said()}`).toBe(3);
    });
  }

  for (const [when, now] of [["an evening", EVENING], ["a Sunday", SUNDAY]] as const) {
    it(`outside the session on ${when}: values once on opening, then polls only the line`, async () => {
      document.cookie = "ui_arrangement=desk;path=/";
      at(now);
      await open();
      await quiet();
      for (const path of VALUED) expect(count(path), `${path}, once on opening\n${said()}`).toBe(1);
      calls = [];
      await polls(3);
      for (const path of LINE) expect(count(path), `${path}, each poll\n${said()}`).toBe(3);
      for (const path of VALUED) expect(count(path), `${path}, never by the poll\n${said()}`).toBe(0);
    });
  }

  it("at the open, asks everything at once and polls it from then on", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T14:29:30Z"); // Monday 09:29:30 New York
    await open();
    await quiet();
    await polls(1);
    calls = [];
    await readClock("2026-11-09T14:30:05Z"); // 09:30:05
    await quiet();
    for (const path of VALUED) expect(count(path), `${path}, once at the open\n${said()}`).toBe(1);
    calls = [];
    await polls(2);
    for (const path of [...LINE, ...VALUED]) expect(count(path), `${path}, each poll\n${said()}`).toBe(2);
  });

  it("crosses the night by the clock: from 16:14:59 to 09:30 the next day", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T21:14:59Z"); // Monday 16:14:59, the session's last second but one
    await open();
    await quiet();
    calls = [];
    await polls(1); // 16:15:14: the clock is read past the close
    calls = [];
    await polls(3);
    for (const path of VALUED) expect(count(path), `${path}, after the close\n${said()}`).toBe(0);
    vi.setSystemTime(new Date("2026-11-10T14:29:50Z")); // Tuesday 09:29:50
    await polls(1); // 09:30:05: the clock reads the open
    calls = [];
    await polls(2);
    for (const path of [...LINE, ...VALUED]) expect(count(path), `${path}, from the open\n${said()}`).toBe(2);
  });

  for (const [what, from, to] of [
    ["a whole session", "2026-11-10T01:00:00Z", "2026-11-11T01:00:00Z"], // Monday 20:00 → Tuesday 20:00
    ["a weekend and a session", "2026-11-07T01:00:00Z", "2026-11-10T01:00:00Z"], // Friday 20:00 → Monday 20:00
  ] as const) {
    it(`values the book once on waking from ${what} slept through, out of session at both ends`, async () => {
      // iOS suspends a tab's timers: nothing ticks between the two, and the session reads false at
      // both ends, so only WHICH session it is after can say the valuation is a session old
      document.cookie = "ui_arrangement=desk;path=/";
      at(from);
      await open();
      await quiet();
      calls = [];
      vi.setSystemTime(new Date(to));
      const visible = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      try {
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
          document.dispatchEvent(new Event("visibilitychange"));
        });
      } finally {
        delete (document as unknown as { visibilityState?: unknown }).visibilityState;
        if (visible) Object.defineProperty(Document.prototype, "visibilityState", visible);
      }
      await quiet();
      for (const path of VALUED) expect(count(path), `${path}, once on waking\n${said()}`).toBe(1);
    });
  }

  it("the close stops polling the holdings and the References", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T21:14:00Z"); // Monday 16:14
    await open();
    await quiet();
    await readClock("2026-11-09T21:16:00Z"); // 16:16
    await quiet();
    calls = [];
    await polls(3);
    for (const path of LINE) expect(count(path), `${path}\n${said()}`).toBe(3);
    for (const path of VALUED) expect(count(path), `${path}\n${said()}`).toBe(0);
  });
});

describe("the market-closed line and its refresh (#371)", () => {
  for (const where of ["desk", "phone"] as const) {
    it(`says when the service valued the holdings outside the session on the ${where}`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(EVENING);
      holdingStamp = "2026-11-10 07:00:12+08:00";
      await open();
      await until(() => expect(closedLine()?.textContent).toContain("market closed — valued at 07:00"));
    });

    it(`is not drawn in session on the ${where}`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(SESSION);
      await open();
      await quiet();
      expect(closedLine()).toBeNull();
    });
  }

  it("dates a valuation from before the session's last edge (#371's review)", async () => {
    // Monday 18:00 New York, Tuesday 07:00 in the service's +08:00; valued on Saturday's +08 morning,
    // which is Friday's close in New York: "valued at 05:15" alone would read as this morning's
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    holdingStamp = "2026-11-07 05:15:00+08:00";
    await open();
    await until(() => expect(closedLine()?.textContent).toContain("market closed — valued at Sat 05:15"));
  });

  it("says no time when the valuation failed", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    refusing.add("/positions/values");
    await open();
    await until(() => expect(screen.getByText(/could not be valued/)).toBeTruthy());
    expect(closedLine()?.textContent).toMatch(/^market closed/);
    expect(closedLine()?.textContent).not.toMatch(/valued at/);
  });

  it("says no time when nothing is held, rather than the device's clock in the service's place", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    held = [];
    await open();
    await until(() => expect(held!.length).toBe(1));
    await act(async () => { held![0]!.settle(true, []); });
    await until(() => expect(screen.getByText("nothing held")).toBeTruthy());
    expect(closedLine()?.firstElementChild?.textContent).toBe("market closed");
  });

  for (const where of ["desk", "phone"] as const) {
    it(`re-values once on the ${where}, and starts no poll of it`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(SUNDAY);
      await open();
      await quiet();
      calls = [];
      fireEvent.click(within(closedLine()!).getByRole("button", { name: "refresh the valuation" }));
      await quiet();
      for (const path of VALUED) expect(count(path), `${path}, once by the press\n${said()}`).toBe(1);
      calls = [];
      await polls(3);
      for (const path of VALUED) expect(count(path), `${path}, never after\n${said()}`).toBe(0);
    });
  }

  it("is disabled while its valuation is out", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SUNDAY);
    await open();
    await quiet();
    held = [];
    const button = within(closedLine()!).getByRole("button", { name: "refresh the valuation" });
    fireEvent.click(button);
    await until(() => expect(held!.length).toBe(1));
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => { held![0]!.settle(true); });
    await until(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
});

describe("the References strip outside the session (#371)", () => {
  for (const where of ["desk", "phone"] as const) {
    it(`is drawn on the ${where} with the service's time on every reading`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(EVENING);
      await open();
      await until(() => expect(document.querySelectorAll(".references .reference")).toHaveLength(2));
      for (const r of document.querySelectorAll(".references .reference")) {
        expect(r.textContent, "every reading says when").toMatch(/(read|tried) at 06:58$/);
      }
    });
  }

  it("dates a reading from another day (#371's review)", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    referenceStamp = "2026-11-03 21:04:11+08:00";
    await open();
    await until(() => expect(document.querySelectorAll(".references .reference")).toHaveLength(2));
    expect(document.querySelector(".references")!.textContent).toContain("read at 3 Nov 21:04");
  });

  it("never draws a reading without its time", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    references = [reference, { ...unread, fetched_at: undefined }];
    await open();
    await until(() => expect(document.querySelectorAll(".references .reference")).toHaveLength(1));
    expect(document.querySelector(".references")!.textContent).toContain("read at 06:58");
    expect(document.querySelector(".references")!.textContent).not.toContain("VIX");
  });

  it("is drawn in session as it was, with no time", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    await until(() => expect(document.querySelectorAll(".references .reference")).toHaveLength(2));
    expect(document.querySelector(".references")!.textContent).not.toContain("read at");
  });

  it("is read again by the refresh, with its new time", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(EVENING);
    await open();
    await until(() => expect(document.querySelector(".references")!.textContent).toContain("read at 06:58"));
    referenceStamp = "2026-11-10 07:09:30+08:00";
    fireEvent.click(within(closedLine()!).getByRole("button", { name: "refresh the valuation" }));
    await until(() => expect(document.querySelector(".references")!.textContent).toContain("read at 07:09"));
  });
});

describe("a holding's history in session (#353)", () => {
  for (const where of ["desk", "phone"] as const) {
    it(`is read once when opened on the ${where}, and never by the poll`, async () => {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(SESSION);
      await open();
      await quiet();
      fireEvent.click(await screen.findByRole("button",
        { name: where === "desk" ? "1231_7000P" : "details of 1231_7000P" }));
      await quiet();
      expect(calls.filter((c) => c.endsWith("/samples")), `shut, nothing\n${said()}`).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "history" }));
      await quiet();
      expect(calls.filter((c) => c === "/positions/p1/samples"), `opened, once\n${said()}`).toHaveLength(1);
      // three polls with it open, each its own new valuation of the holding
      calls = [];
      for (let i = 0; i < 3; i++) {
        await act(async () => { vi.advanceTimersByTime(15_000); });
        await quiet();
      }
      expect(new Set(calls), said()).toEqual(
        new Set(["/quotes", "/monitors", "/health", "/references", "/positions/values"]));
    });
  }
});

describe("the desk inspector's history, by the session (#372)", () => {
  const samplesAsked = () => calls.filter((c) => c === "/positions/p1/samples").length;
  const history = () => screen.getByRole("button", { name: "history" });
  const inspect = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "1231_7000P" }));
    await quiet();
  };
  const shut = async () => {
    fireEvent.click(screen.getByRole("button", { name: "close the inspector" }));
    await quiet();
  };

  it("starts shut in session, and asks for nothing until it is opened", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    await quiet();
    await inspect();
    expect(history().getAttribute("aria-expanded")).toBe("false");
    await polls(2);
    expect(samplesAsked(), `shut, nothing\n${said()}`).toBe(0);
  });

  for (const [when, now] of [["an evening", EVENING], ["a Sunday", SUNDAY]] as const) {
    it(`starts open outside the session, on ${when}, and reads the samples once`, async () => {
      document.cookie = "ui_arrangement=desk;path=/";
      at(now);
      await open();
      await quiet();
      await inspect();
      expect(history().getAttribute("aria-expanded")).toBe("true");
      expect(samplesAsked(), `open, once\n${said()}`).toBe(1);
      // the charts load once: polls, and shutting and opening the section, ask nothing more
      await polls(3);
      fireEvent.click(history());
      fireEvent.click(history());
      await quiet();
      expect(samplesAsked(), `still once\n${said()}`).toBe(1);
    });
  }

  it("crossing 16:15 with the inspector open does not unfold its shut section", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T21:14:00Z"); // Monday 16:14 New York
    await open();
    await quiet();
    await inspect();
    expect(history().getAttribute("aria-expanded")).toBe("false");
    await readClock("2026-11-09T21:16:00Z"); // 16:16: the session is over
    await quiet();
    expect(closedLine(), "the page has not seen the close").toBeTruthy();
    expect(history().getAttribute("aria-expanded"), "the close unfolded it under the reader").toBe("false");
    expect(samplesAsked()).toBe(0);
    // the next holding opened takes the new default: here the same one, opened afresh
    await shut();
    await inspect();
    expect(history().getAttribute("aria-expanded")).toBe("true");
    expect(samplesAsked()).toBe(1);
  });

  it("crossing 09:30 with the history open outside the session does not fold it", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T14:29:00Z"); // Monday 09:29 New York
    await open();
    await quiet();
    await inspect();
    expect(history().getAttribute("aria-expanded")).toBe("true");
    await readClock("2026-11-09T14:31:00Z"); // 09:31: the session is open
    await quiet();
    expect(closedLine(), "the page has not seen the open").toBeNull();
    expect(history().getAttribute("aria-expanded"), "the open folded it under the reader").toBe("true");
    await shut();
    await inspect();
    expect(history().getAttribute("aria-expanded")).toBe("false");
    // read once, for the opening outside the session, and not again
    expect(samplesAsked(), said()).toBe(1);
  });
});

describe("a holding's history in the phone's sheet, by the session (#374)", () => {
  const samples = () => calls.filter((c) => c === "/positions/p1/samples").length;
  const toggle = () => within(screen.getByRole("dialog")).getByRole("button", { name: "history" });
  async function openSheet() {
    fireEvent.click(await screen.findByRole("button", { name: "details of 1231_7000P" }));
    await screen.findByRole("dialog");
    await quiet();
  }

  for (const [when, now] of [["an evening", EVENING], ["a Sunday", SUNDAY]] as const) {
    it(`opens with it open outside the session, on ${when}, read once and never by the poll`, async () => {
      document.cookie = "ui_arrangement=phone;path=/";
      at(now);
      await open();
      await quiet();
      calls = [];
      await openSheet();
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(samples(), `open, once\n${said()}`).toBe(1);
      await polls(3);
      expect(samples(), `never by the poll\n${said()}`).toBe(1);
    });
  }

  it("opens with it shut in session, reading nothing", async () => {
    document.cookie = "ui_arrangement=phone;path=/";
    at(SESSION);
    await open();
    await quiet();
    calls = [];
    await openSheet();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await polls(3);
    expect(samples(), `shut, nothing\n${said()}`).toBe(0);
  });

  it("neither folds nor unfolds an open sheet's history when the session changes; the next sheet takes it", async () => {
    document.cookie = "ui_arrangement=phone;path=/";
    at("2026-11-09T21:14:00Z"); // Monday 16:14 New York
    await open();
    await quiet();
    calls = [];
    await openSheet();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await readClock("2026-11-09T21:16:00Z"); // the close, with the sheet open
    await quiet();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(samples(), `still shut, nothing\n${said()}`).toBe(0);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await until(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openSheet();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(samples(), `the next sheet, open, once\n${said()}`).toBe(1);
  });
});

describe("asking again", () => {
  it("values the holdings and reads the References afresh when Settings opens outside the session", async () => {
    at(SUNDAY);
    await open();
    await quiet();
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await quiet();
    expect(calls, said()).toContain("/positions/values");
    // nothing polls either outside the session, and Settings is where References are kept or dropped
    expect(calls, said()).toContain("/references");
    expect(screen.getByText(/holdings valued at/)).toBeTruthy();
  });

  it("values them afresh when the desk's Settings panel opens outside the session", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SUNDAY);
    await open();
    await quiet();
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await quiet();
    for (const path of VALUED) expect(count(path), `${path}\n${said()}`).toBe(1);
  });
});

describe("what is read again, and when", () => {
  it("reads the References again after one is kept from Settings, outside the session too", async () => {
    at(SUNDAY);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await quiet();
    expect(calls, said()).toContain("/references");
    calls = [];
    fireEvent.change(screen.getByLabelText("code"), { target: { value: "US.QQQ" } });
    fireEvent.click(screen.getByRole("button", { name: "keep it" }));
    await until(() => expect(writes).toContain("POST /references"));
    await quiet();
    expect(calls, said()).toContain("/references");
  });

  it("does not ask again on opening Settings in session, which polls both already", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    await quiet();
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await quiet();
    for (const path of VALUED) expect(count(path), `${path}\n${said()}`).toBe(0);
  });

  it("keeps the newer valuation when an older one lands after the close", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T21:14:00Z"); // Monday 16:14 New York
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
    held = [];
    await act(async () => { vi.advanceTimersByTime(15_000); }); // the session's poll asks: #0
    await until(() => expect(held!.length).toBe(1));
    await readClock("2026-11-09T21:16:00Z"); // the close: asked once more, #1
    await until(() => expect(held!.length).toBe(2));
    await act(async () => { held![1]!.settle(true); });
    await act(async () => { held![0]!.settle(false); }); // the older one fails, late
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-ref="p1"]')).toBeTruthy();
    expect(screen.queryByText(/could not be valued/)).toBeNull();
  });

  it("keeps the newer figures when an older valuation succeeds late", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T21:14:00Z");
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
    held = [];
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await until(() => expect(held!.length).toBe(1));
    await readClock("2026-11-09T21:16:00Z");
    await until(() => expect(held!.length).toBe(2));
    await act(async () => { held![1]!.settle(true, [{ ...holding, pnl: 180 }]); });
    await act(async () => { held![0]!.settle(true, [{ ...holding, pnl: 999 }]); });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-ref="p1"] [data-money]')!.textContent).toBe("+$180");
  });

  it("still lands a valuation when every one takes longer than the poll", async () => {
    // a half-up Provider answers in 10-18 s, past a 15 s poll: each answer then has a newer ask
    // behind it, and dropping every answer that does left the old figures drawn for ever
    at(SESSION);
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
    held = [];
    for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(15_000); });
    await until(() => expect(held!.length).toBe(3));
    await act(async () => { held![0]!.settle(false); });
    await waitFor(() => expect(screen.getByText(/could not be valued/)).toBeTruthy());
    expect(document.querySelector('[data-ref="p1"]')).toBeNull();
    await act(async () => { held![1]!.settle(true); });
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
  });

  it("forgets when the holdings were valued once a valuation fails", async () => {
    at(SUNDAY);
    await open();
    refusing.add("/positions/values");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText(/not valued/)).toBeTruthy());
    expect(screen.queryByText(/holdings valued at/)).toBeNull();
  });
});

describe("when part of the service fails", () => {
  it("still says the Provider is down and what is quarantined when /quotes fails", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    window.fetch = ((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/health" ? { ...health, provider: { name: "moomoo", ok: false } }
        : path === "/monitors" ? [quarantined] : [];
      return path === "/quotes"
        ? Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ detail: "moomoo call failed" }) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch;
    render(<Next />);
    const line = await screen.findByRole("status", { name: "needs you" });
    expect(line.textContent).toContain("moomoo down");
    expect(line.textContent).toContain("quarantined");
    expect(screen.getByRole("alert").textContent).toContain("/quotes → 502");
  });

  it("keeps a holding's rules on the page when its valuation fails", async () => {
    at(SESSION);
    quotes = [spread, holdingRule];
    refusing.add("/positions/values");
    render(<Next />);
    await waitFor(() => expect(screen.getByText(/could not be valued/)).toBeTruthy());
    expect(document.querySelector('[data-testid="unplaced"] [data-ref="r1"]')).toBeTruthy();
  });

  it("drops the money of a valuation that has since failed, rather than showing it as current", async () => {
    at(SESSION);
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"] [data-money]')).toBeTruthy());
    refusing.add("/positions/values");
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(screen.getByText(/could not be valued/)).toBeTruthy());
    expect(document.querySelector('[data-ref="p1"]')).toBeNull();
    expect(document.body.textContent).not.toContain("$180");
  });
});

/** One page at every hour, with no switch (#375; ADR 0023 amended 2026-11-13: one page, by the
 *  session). What is drawn is the same at 10:00 and at 21:00 New York; only the market-closed line
 *  says which side of the session it is, and only what is fetched differs (above). */
describe("one page at every hour (#375)", () => {
  const MORNING = SESSION; // Monday 10:00 New York
  const NIGHT = "2026-11-10T02:00:00Z"; // Monday 21:00 New York
  const labelOf = (el: Element) => el.getAttribute("aria-label") ?? el.textContent ?? "";
  /** what the page draws, as far as the hour could change it: never a figure */
  function drawn(where: "desk" | "phone") {
    const book = document.querySelector(".nx-book")!;
    const fold = screen.getByRole("region", { name: "closed trades" });
    return {
      header: [...document.querySelectorAll(".nx-head > *")].map((el) => `${el.tagName}:${labelOf(el)}`),
      columns: where === "desk"
        ? [...document.querySelectorAll(".nxd-head [data-col]")].map((h) => h.getAttribute("data-col")) : null,
      tabs: where === "phone"
        ? within(screen.getByRole("navigation", { name: "views" })).getAllByRole("button").map((b) => b.textContent)
        : null,
      rows: [...book.querySelectorAll<HTMLElement>("[data-ref]")].map((el) => el.dataset.ref),
      // the fold: in the book, after every row of it, shut
      foldLast: book.contains(fold) && [...book.querySelectorAll("[data-ref]")].every((el) =>
        fold.contains(el) || !(fold.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)),
      foldOpen: within(fold).getByRole("button", { name: "Closed trades" }).getAttribute("aria-expanded"),
      attributes: [...document.querySelector(".nx")!.attributes].map((a) => a.name).sort(),
    };
  }

  for (const where of ["desk", "phone"] as const) {
    it(`draws the same ${where} at 10:00 and at 21:00 New York: only the session line differs`, async () => {
      const seen: Record<string, ReturnType<typeof drawn>> = {};
      for (const [name, now] of [["10:00", MORNING], ["21:00", NIGHT]] as const) {
        document.cookie = `ui_arrangement=${where};path=/`;
        at(now);
        await open();
        await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy(), { timeout: SLOW });
        await quiet();
        seen[name] = drawn(where);
        // the session line, and nothing else, says which side of the session it is
        if (name === "10:00") expect(closedLine(), "in session, no market-closed line").toBeNull();
        else expect(closedLine()?.textContent).toContain("market closed");
        // no switch, at either hour: no mode group, no Live or Review, no "by the clock"
        expect(screen.queryByRole("group", { name: "mode" })).toBeNull();
        expect(screen.queryByRole("button", { name: /^(live|review)$/i })).toBeNull();
        expect(screen.queryByText(/by the clock|your choice/)).toBeNull();
        expect(document.querySelector("[data-mode]")).toBeNull();
        cleanup();
        vi.useRealTimers();
      }
      expect(seen["10:00"]!.rows.length).toBeGreaterThan(1);
      expect(seen["10:00"]!.foldLast).toBe(true);
      expect(seen["10:00"]!.foldOpen).toBe("false");
      if (where === "desk") expect(seen["10:00"]!.columns!.length).toBeGreaterThan(1);
      else expect(seen["10:00"]!.tabs).toEqual(["Book", "Add", "Settings"]);
      expect(seen["21:00"]).toEqual(seen["10:00"]);
    });
  }

  it("reads the clock again when the page comes back into view, without waiting for its timer", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T14:29:00Z"); // 09:29 New York
    await open();
    await until(() => expect(closedLine()).toBeTruthy());
    vi.setSystemTime(new Date("2026-11-09T14:31:00Z")); // a phone woken at 09:31
    const visible = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    try {
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
      if (visible) Object.defineProperty(Document.prototype, "visibilityState", visible);
    }
    expect(closedLine()).toBeNull();
  });

  it("reads the clock again when the window takes focus", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T14:29:00Z");
    await open();
    await until(() => expect(closedLine()).toBeTruthy());
    vi.setSystemTime(new Date("2026-11-09T14:31:00Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(closedLine()).toBeNull();
  });

  it("gives the phone three tabs, Book, Add and Settings, at every hour (#374)", async () => {
    for (const now of [SESSION, SUNDAY]) {
      at(now);
      await open();
      const tabs = screen.getByRole("navigation", { name: "views" });
      const tab = (name: string) => within(tabs).getByRole("button", { name });
      const current = () => within(tabs).getAllByRole("button")
        .filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent);
      expect(within(tabs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Book", "Add", "Settings"]);
      expect(current()).toEqual(["Book"]);
      fireEvent.click(tab("Settings"));
      expect(current()).toEqual(["Settings"]);
      expect(screen.queryByRole("region", { name: "Holdings" })).toBeNull();
      fireEvent.click(tab("Book"));
      expect(current()).toEqual(["Book"]);
      expect(screen.getByRole("region", { name: "Holdings" })).toBeTruthy();
      cleanup();
      vi.useRealTimers();
    }
  });
});

describe("the needs-you line", () => {
  for (const [when, now] of [["in session", SESSION], ["outside the session", SUNDAY]] as const) {
    it(`names a quarantined rule as a fault ${when}`, async () => {
      document.cookie = "ui_arrangement=desk;path=/";
      at(now);
      await open();
      const line = screen.getByRole("status", { name: "needs you" });
      expect(line.textContent).toContain("261211 8300C delta quarantined — the provider does not know its contract");
      expect(line.getAttribute("data-tone")).toBe("bad");
    });
  }

  it("is not drawn when nothing needs you", async () => {
    at(SESSION);
    window.fetch = ((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(String(url).endsWith("/health") ? health
        : String(url).endsWith("/quotes") ? [spread] : []),
    })) as unknown as typeof fetch;
    await open();
    expect(screen.queryByRole("status", { name: "needs you" })).toBeNull();
  });
});

describe("a combo drawn in the Watchlist because it names a contract its holding does not hold (#346)", () => {
  /** −P7000 +P6950 −P6900: the whole of the holding `1231_7000P` and an unheld P6900, so the
   *  service links it with scope `all` and serves it the holding's Levels */
  const moved = {
    ...holdingRule, id: "r2", code: "1231_7000W", field: "mid_price",
    legs: [{ sign: -1, option_type: "PUT", strike: 7000 }, { sign: 1, option_type: "PUT", strike: 6950 },
           { sign: -1, option_type: "PUT", strike: 6900 }],
    schedule: { reached: null, manage_by_due: true, position_id: "p1" },
  };

  for (const [when, now] of [["in session", SESSION], ["outside the session", SUNDAY]] as const) {
    it(`does not say its holding's manage-by under its own name ${when}`, async () => {
      document.cookie = "ui_arrangement=desk;path=/";
      at(now);
      serve();
      quotes = [spread, shortLeg, moved];
      await open();
      // the holdings have arrived, and the combo is drawn apart from its holding
      await screen.findByText("contains 1231_7000P's P7000 and P6950", undefined, { timeout: SLOW });
      const line = screen.getByRole("status", { name: "needs you" });
      expect(line.textContent).toContain("quarantined");
      expect(line.textContent).not.toContain("1231_7000W at its manage-by");
    });
  }
});

describe("the book", () => {
  it("sits a short leg's delta rule under the spread that holds its contract", async () => {
    at(SESSION);
    await open();
    const row = document.querySelector('[data-ref="w1"]')!;
    expect(row.textContent).toContain("|spread value| ≥ 6.01 — now 2.00, 4.01 away");
    expect(document.querySelector('[data-ref="w2"]')!.textContent)
      .toContain("|delta| ≥ 0.2 — now -0.150, 0.050 away");
    // nested: inside the spread's own list item, not beside it
    expect(row.closest("li")!.contains(document.querySelector('[data-ref="w2"]'))).toBe(true);
  });

  it("hides the money and keeps the share captured when privacy is on", async () => {
    document.cookie = "ui_privacy=on;path=/";
    at(SESSION);
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
    const money = [...document.querySelectorAll("[data-money]")];
    expect(money.length).toBeGreaterThan(0);
    for (const m of money) expect(m.textContent).not.toMatch(/\d/);
    expect(document.querySelector('[data-ref="p1"]')!.textContent).toContain("captured 60%");
  });

  it("shows the money otherwise", async () => {
    at(SESSION);
    await open();
    await waitFor(() => expect(document.querySelector('[data-ref="p1"]')).toBeTruthy());
    expect(document.querySelector('[data-ref="p1"] [data-money]')!.textContent).toBe("+$180");
  });
});

describe("a banner leads to its row", () => {
  it("marks a rule nested under its spread", async () => {
    at(SESSION);
    quotes = [spread, { ...shortLeg, triggered: true }];
    await open();
    const banners = screen.getByRole("status", { name: "needs you" });
    fireEvent.click(within(banners).getByRole("button", { name: /261218 7150P entry signal/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-ref="w2"]')!.hasAttribute("data-revealed")).toBe(true));
  });

  it("leaves the Settings tab for the book, where the row is", async () => {
    at(SESSION);
    quotes = [spread, { ...shortLeg, triggered: true }];
    await open();
    const tabs = screen.getByRole("navigation", { name: "views" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Settings" }));
    expect(document.querySelector('[data-ref="w2"]')).toBeNull();
    const banners = screen.getByRole("status", { name: "needs you" });
    fireEvent.click(within(banners).getByRole("button", { name: /261218 7150P entry signal/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-ref="w2"]')?.hasAttribute("data-revealed")).toBe(true));
  });
});

describe("every item that needs you carries its glyph", () => {
  it("on the line, in the banners and in Settings' full list", async () => {
    for (const where of ["desk", "phone"]) {
      document.cookie = `ui_arrangement=${where};path=/`;
      at(SESSION);
      quotes = [spread, { ...shortLeg, triggered: true }];
      await open();
      const line = screen.getByRole("status", { name: "needs you" });
      const items = [...line.querySelectorAll("[data-kind]")];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.querySelector("svg.nx-glyph")).toBeTruthy();
      cleanup();
      vi.useRealTimers();
    }
    at(SESSION);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const full = [...screen.getByTestId("needs").querySelectorAll("li")];
    expect(full.length).toBeGreaterThan(0);
    for (const item of full) expect(item.querySelector("svg.nx-glyph")).toBeTruthy();
  });
});

describe("settings", () => {
  it("gives its Back entry back when the desk turns into the phone with it open", async () => {
    // jsdom's traversal is not to be relied on (BackButton.test.tsx), so watch the calls
    const pushed = vi.spyOn(window.history, "pushState");
    const back = vi.spyOn(window.history, "back");
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    expect(pushed).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("arrangement"), { target: { value: "phone" } });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("turns the page red-up and remembers it", async () => {
    at(SESSION);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("up is"), { target: { value: "red" } });
    expect(document.querySelector(".nx")!.getAttribute("data-up")).toBe("red");
    expect(document.cookie).toContain("ui_up=red");
  });

  it("forces the desk on a phone-sized screen, and the desk's settings open as a panel", async () => {
    at(SESSION);
    await open();
    expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("phone");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("arrangement"), { target: { value: "desk" } });
    expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("desk");
    // still open, now as the desk's panel over the page — whose "add" is behind it
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "add", hidden: true })).toBeTruthy();
  });
});
