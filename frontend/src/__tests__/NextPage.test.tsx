/** The redesigned page as a whole (ADR 0023, #287): what it asks the service for in each mode, and
 *  the settings that change what it draws. Layout is the browser suite's (`NextLayout`); this is
 *  behaviour, which jsdom can answer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";

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

let calls: string[] = [];
/** paths the fake service refuses, with a 502 as a Provider outage gives */
let refusing = new Set<string>();
let quotes: object[] = [spread, shortLeg];

function serve() {
  calls = [];
  refusing = new Set();
  quotes = [spread, shortLeg];
  window.fetch = ((url: string) => {
    const path = String(url).replace(/^.*\/api/, "");
    calls.push(path);
    if (refusing.has(path)) {
      return Promise.resolve({
        ok: false, status: 502, json: () => Promise.resolve({ detail: "moomoo call failed" }),
      });
    }
    const body = path === "/quotes" ? quotes
      : path === "/monitors" ? [quarantined]
        : path === "/health" ? health
          : path === "/references" ? []
            : path === "/positions/values" ? [holding] : null;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** A Monday in the session (10:00 EST) or a Sunday, so the clock picks the mode. Only the clock
 *  and the poll's interval are faked: the fetches resolve on real microtasks. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date(iso) });
}
const SESSION = "2026-11-09T15:00:00Z";
const SUNDAY = "2026-11-08T15:00:00Z";

async function open() {
  render(<Next />);
  await waitFor(() => expect(screen.getByText("1218_7150P")).toBeTruthy());
}

const COOKIES = ["ui_up", "ui_entry", "ui_privacy", "ui_arrangement", "ui_refresh"];
beforeEach(serve);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const n of COOKIES) document.cookie = `${n}=;path=/;max-age=0`;
});

describe("what it asks for in each mode", () => {
  it("polls the watchlist, the rules, health, References and the holdings in LIVE", async () => {
    at(SESSION);
    await open();
    calls = [];
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(calls).toContain("/positions/values"));
    expect(new Set(calls)).toEqual(
      new Set(["/quotes", "/monitors", "/health", "/references", "/positions/values"]));
  });

  it("polls only what the needs-you line reads in REVIEW, having asked for the rest once", async () => {
    at(SUNDAY);
    await open();
    // the rest WAS asked for, once, on entering REVIEW
    expect(calls).toContain("/positions/values");
    calls = [];
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(calls).toContain("/health"));
    expect(new Set(calls)).toEqual(new Set(["/quotes", "/monitors", "/health"]));
  });
});

describe("asking again", () => {
  it("asks for the holdings, and not the References, on switching into REVIEW", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(calls).toContain("/positions/values"));
    expect(calls).not.toContain("/references");
  });

  it("values the holdings and reads the References afresh when Settings opens, in REVIEW too", async () => {
    at(SUNDAY);
    await open();
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(calls).toContain("/positions/values"));
    // REVIEW polls neither, and Settings is where References are kept or dropped
    expect(calls).toContain("/references");
    expect(screen.getByText(/holdings valued at/)).toBeTruthy();
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

describe("the mode", () => {
  it("ends a choice when the clock's own mode next changes", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at("2026-11-09T13:00:00Z"); // Monday 08:00 New York, before the open
    await open();
    const root = document.querySelector(".nx")!;
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByText("your choice")).toBeTruthy();

    vi.setSystemTime(new Date("2026-11-09T14:31:00Z")); // 09:31: the clock agrees now
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByText("by the clock")).toBeTruthy();
    expect(root.getAttribute("data-mode")).toBe("live");

    vi.setSystemTime(new Date("2026-11-09T21:16:00Z")); // 16:16: the session is over
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(root.getAttribute("data-mode")).toBe("review");
  });

  it("follows the clock until the owner picks one, and goes back to it", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    at(SESSION);
    await open();
    const root = document.querySelector(".nx")!;
    expect(root.getAttribute("data-mode")).toBe("live");
    expect(screen.getByText("by the clock")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(root.getAttribute("data-mode")).toBe("review");
    expect(screen.getByText("your choice")).toBeTruthy();

    // picking what the clock says hands the page back to the clock
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(root.getAttribute("data-mode")).toBe("live");
    expect(screen.getByText("by the clock")).toBeTruthy();
  });

  it("is the phone's Live and Review tabs", async () => {
    at(SESSION);
    await open();
    const tabs = screen.getByRole("navigation", { name: "views" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Review" }));
    expect(document.querySelector(".nx")!.getAttribute("data-mode")).toBe("review");
    expect(within(tabs).getByRole("button", { name: "Review" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("the needs-you line", () => {
  for (const [mode, now] of [["LIVE", SESSION], ["REVIEW", SUNDAY]] as const) {
    it(`names a quarantined rule as a fault in ${mode}`, async () => {
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
    expect(document.querySelector('[data-ref="w2"]')!.hasAttribute("data-revealed")).toBe(true);
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
    // still open, now as the desk's panel over the page — whose mode switch is behind it
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "mode", hidden: true })).toBeTruthy();
  });
});
