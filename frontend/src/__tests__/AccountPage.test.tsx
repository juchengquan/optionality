/** The account page (#471): reaching it and leaving it, when it reads `/account`, and what it draws
 *  of each answer — on made-up accounts (`testing/account.ts`). Layout is the browser suite's
 *  (`__browser__/Account*.test.tsx`); this is behaviour, which jsdom can answer.
 *
 *  jsdom's window is 0 wide, which is the phone; the desk is forced as the owner forces it, by the
 *  arrangement cookie. Where the poll is driven, only the clock and the interval are faked,
 *  installed BEFORE render: the fetches resolve on real microtasks. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Page, pageAt } from "../Page";
import { readAccountRefresh } from "../shared/prefs";
import {
  ACCOUNT, EMPTY, NO_RATE, NOT_LIVE, ODD_OPTIONS, PAPER, REFUSALS, serveAccount, TWO_CURRENCIES, type AccountService,
} from "../testing/account";
import { servePage } from "../testing/pageService";
import { until } from "../testing/until";

const inner = window.fetch;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.fetch = inner;
  setVisibility(null);
  for (const n of ["ui_arrangement", "ui_account_refresh", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

/** Monday 23 November 2026, 21:05 Singapore: the page reads by its own clock, never New York's. */
const NOW = new Date("2026-11-23T13:05:00Z");

/** Lets every answer already given reach the screen: real timers, so a fake clock does not stall it. */
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** The poll's clock moved on by `ms`, and whatever it asked answered. */
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await drain();
}

/** The page as `document.visibilityState` says it is: `null` puts jsdom's own back. */
let visibilityDescriptor: PropertyDescriptor | undefined;
function setVisibility(state: "visible" | "hidden" | null) {
  if (state === null) {
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    return;
  }
  visibilityDescriptor ??= Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
async function becomes(state: "visible" | "hidden") {
  setVisibility(state);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await drain();
}

/** The account page opened on `answer`, its first read landed. The poll's interval is the test's on
 *  every open, so nothing is read but where a test moves the clock: at a second's cadence (#478) a
 *  real one would read on top of what a test counts. */
async function open(arrangement: Arrangement, answer: AccountService["answer"] = ACCOUNT): Promise<AccountService> {
  const svc = serveAccount(answer);
  // the clock pinned on every open, not only where the poll is driven: a served stamp is written
  // with its date where it is not from today, so an unpinned clock past midnight +08 changed the words
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Page path="/opt/account" base="/opt/" />);
  await until(() => expect(svc.reads()).toBe(1));
  await drain();
  return svc;
}

const page = () => document.querySelector<HTMLElement>(".nx-acct")!;
const text = () => page().textContent ?? "";
const refreshButton = () => document.querySelector<HTMLButtonElement>('[aria-label="refresh now"]')!;

describe("the page a path names", () => {
  it("is the account after the bundle's base, and the book anywhere else", () => {
    expect(pageAt("/opt/account", "/opt/")).toBe("account");
    expect(pageAt("/opt/account/", "/opt/")).toBe("account");
    expect(pageAt("/opt/", "/opt/")).toBe("book");
    expect(pageAt("/opt", "/opt/")).toBe("book");
    expect(pageAt("/opt/accounts", "/opt/")).toBe("book");
    expect(pageAt("/opt/next", "/opt/")).toBe("book");
    expect(pageAt("/opt/account/x", "/opt/")).toBe("book");
    // the dev server and the suites, at the root
    expect(pageAt("/account", "/")).toBe("account");
    expect(pageAt("/", "/")).toBe("book");
    // the base alone names it, never a path that merely ends in it
    expect(pageAt("/account", "/opt/")).toBe("book");
    expect(pageAt("/api/account", "/opt/")).toBe("book");
  });

  for (const arrangement of arrangements) {
    it(`draws the account at /opt/account and the book at /opt/, on the ${arrangement}`, async () => {
      if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
      serveAccount();
      render(<Page path="/opt/account" base="/opt/" />);
      expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeTruthy();
      cleanup();

      const svc = servePage();
      render(<Page path="/opt/" base="/opt/" />);
      expect(await screen.findByRole("heading", { level: 1, name: "optionality" })).toBeTruthy();
      expect(document.querySelector(".nx-acct")).toBeNull();
      await waitFor(() => expect(svc.count("/quotes")).toBeGreaterThan(0));
      // the book never reads the account
      expect(svc.gets.filter((p) => p.startsWith("/account"))).toEqual([]);
    });

    it(`is reached from the book's header by a plain link, and left by one, on the ${arrangement}`, async () => {
      if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
      servePage();
      render(<Page path="/opt/" base="/opt/" />);
      const head = await waitFor(() => document.querySelector<HTMLElement>(".nx-head")!);
      const to = within(head).getByRole("link", { name: "account" });
      expect(to.tagName).toBe("A");
      expect(to.getAttribute("href")).toBe("/opt/account");
      cleanup();

      serveAccount();
      render(<Page path={to.getAttribute("href")!} base="/opt/" />);
      const back = await screen.findByRole("link", { name: "back to the book" });
      expect(back.getAttribute("href")).toBe("/opt/");
      expect(pageAt(back.getAttribute("href")!, "/opt/")).toBe("book");
    });
  }
});

describe.each(arrangements)("on the %s, reading the account", (arrangement) => {
  it("reads it once on opening, and asks for nothing else", async () => {
    const svc = await open(arrangement);
    expect(svc.requests).toEqual(["GET /account"]);
  });

  it("reads it every second until another cadence is chosen (#478)", async () => {
    const svc = await open(arrangement);
    await tick(999);
    expect(svc.reads()).toBe(1);
    await tick(1);
    expect(svc.reads()).toBe(2);
    await tick(1_000);
    expect(svc.reads()).toBe(3);
    await tick(58_000);
    expect(svc.reads()).toBe(61);
  });

  it("offers 1 s, 5 s, 15 s, 30 s, 1 min and off, reads at the cadence chosen on the page, and remembers it", async () => {
    const svc = await open(arrangement);
    const choice = screen.getByLabelText<HTMLSelectElement>("refresh every");
    expect([...choice.options].map((o) => o.textContent)).toEqual(["1 s", "5 s", "15 s", "30 s", "1 min", "off"]);
    expect(choice.value).toBe("1");
    fireEvent.change(choice, { target: { value: "15" } });
    expect(readAccountRefresh()).toBe(15);
    expect(document.cookie).toContain("ui_account_refresh=15");
    await tick(15_000);
    expect(svc.reads()).toBe(2);
    await tick(15_000);
    expect(svc.reads()).toBe(3);

    // and opened again, the page starts at the choice
    cleanup();
    const again = await open(arrangement);
    expect(screen.getByLabelText<HTMLSelectElement>("refresh every").value).toBe("15");
    expect(again.reads()).toBe(1);
  });

  it("reads a cadence no longer offered as the default: 3 min, chosen before #478, is a second", async () => {
    document.cookie = "ui_account_refresh=180;path=/";
    expect(readAccountRefresh()).toBe(1);
    const svc = await open(arrangement);
    expect(screen.getByLabelText<HTMLSelectElement>("refresh every").value).toBe("1");
    await tick(1_000);
    expect(svc.reads()).toBe(2);
    for (const stale of ["3", "120", "0", ""]) {
      document.cookie = `ui_account_refresh=${stale};path=/`;
      expect(readAccountRefresh(), stale).toBe(1);
    }
  });

  it("reads nothing by itself when the cadence is off, and still on the button", async () => {
    document.cookie = "ui_account_refresh=off;path=/";
    const svc = await open(arrangement);
    expect(screen.getByLabelText<HTMLSelectElement>("refresh every").value).toBe("off");
    await tick(600_000);
    expect(svc.reads()).toBe(1);
    // nor on coming back into view
    await becomes("hidden");
    await becomes("visible");
    expect(svc.reads()).toBe(1);
    fireEvent.click(refreshButton());
    await until(() => expect(svc.reads()).toBe(2));
  });

  it("turned off on the page, stops reading", async () => {
    const svc = await open(arrangement);
    fireEvent.change(screen.getByLabelText("refresh every"), { target: { value: "off" } });
    expect(readAccountRefresh()).toBeNull();
    await tick(600_000);
    expect(svc.reads()).toBe(1);
  });
});

/** The poll's rules, held at the default of a second (#478) and at a minute, the slowest offered:
 *  every time below is a share of the cadence, `u`. */
const CADENCES = [
  { name: "every second, the default", cookie: null, u: 1_000 },
  { name: "every minute", cookie: "60", u: 60_000 },
] as const;

describe.each(arrangements.flatMap((arrangement) => CADENCES.map((c) => ({ arrangement, ...c }))))(
  "on the $arrangement, reading the account $name", ({ arrangement, cookie, u }) => {
  const openAt = (answer: AccountService["answer"] = ACCOUNT) => {
    if (cookie !== null) document.cookie = `ui_account_refresh=${cookie};path=/`;
    return open(arrangement, answer);
  };

  it("reads at each tick of the cadence", async () => {
    const svc = await openAt();
    await tick(u - 1);
    expect(svc.reads()).toBe(1);
    await tick(1);
    expect(svc.reads()).toBe(2);
    await tick(u);
    expect(svc.reads()).toBe(3);
  });

  it("reads nothing while the page is hidden, and reads at once when it is seen again after a missed read", async () => {
    const svc = await openAt();
    await becomes("hidden");
    await tick(5 * u);
    expect(svc.reads(), "read while hidden").toBe(1);
    await becomes("visible");
    await until(() => expect(svc.reads()).toBe(2));
    // and the poll goes on from there
    await tick(u);
    expect(svc.reads()).toBe(3);
  });

  it("does not read again on being seen again before a read was due", async () => {
    const svc = await openAt();
    await tick(0.2 * u);
    await becomes("hidden");
    await tick(0.1 * u);
    await becomes("visible");
    expect(svc.reads()).toBe(1);
    await tick(0.7 * u);
    expect(svc.reads()).toBe(2);
  });

  it("reads at once on the refresh button, which restarts the clock and stacks nothing", async () => {
    const svc = await openAt();
    await tick(0.9 * u);
    const release = svc.hold();
    fireEvent.click(refreshButton());
    await until(() => expect(svc.reads()).toBe(2));
    await waitFor(() => expect(refreshButton().disabled).toBe(true));
    fireEvent.click(refreshButton());
    expect(svc.reads()).toBe(2);
    release();
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    // what remained of the old interval is no longer owed
    await tick(0.1 * u);
    expect(svc.reads(), "the old interval fired on top of the refresh").toBe(2);
    await tick(0.9 * u);
    expect(svc.reads()).toBe(3);
  });

  it("stacks no tick's read on the button's while the button's is still out (review of #474)", async () => {
    const svc = await openAt();
    await tick(0.9 * u);
    const release = svc.hold();
    fireEvent.click(refreshButton());
    await until(() => expect(svc.reads()).toBe(2));
    // the old interval's tick falls due at u, while the button's read is held: it reads nothing
    await tick(0.2 * u);
    expect(svc.reads(), "a tick read on top of the button's held read").toBe(2);
    // nor does the restarted cadence's first tick, at 1.9u, while the button's read is held still
    await tick(u);
    expect(svc.reads(), "the restarted cadence read on top of the button's held read").toBe(2);
    release();
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    // and the cadence runs on, a cadence after that tick
    await tick(0.8 * u);
    expect(svc.reads()).toBe(3);
  });

  it("stacks no tick's read on the opening read while it is still out (review of #474)", async () => {
    if (cookie !== null) document.cookie = `ui_account_refresh=${cookie};path=/`;
    const svc = serveAccount(ACCOUNT);
    const release = svc.hold();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
    if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
    render(<Page path="/opt/account" base="/opt/" />);
    await until(() => expect(svc.reads()).toBe(1));
    // the first tick falls due at u, while the opening read is held: it reads nothing
    await tick(u);
    expect(svc.reads(), "a tick read on top of the held opening read").toBe(1);
    release();
    await waitFor(() => expect(screen.getByRole("region", { name: "totals" })).toBeTruthy());
    await tick(u);
    expect(svc.reads()).toBe(2);
  });

  it("asks afresh on the button while a tick's read is held, rather than waiting on it (review of #474)", async () => {
    const svc = await openAt();
    const release = svc.hold();
    await tick(u);
    expect(svc.reads(), "the tick read").toBe(2);
    // that read is held: the button gives up on it and sends its own
    fireEvent.click(refreshButton());
    await until(() => expect(svc.reads(), "the button waited on the tick's held read").toBe(3));
    release();
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
  });

  it("gives up on a read held for a minute, or two ticks where those are longer, and asks afresh", async () => {
    const svc = await openAt();
    const release = svc.hold();
    await tick(u);
    expect(svc.reads()).toBe(2);
    const givenUp = Math.max(2 * u, 60_000);
    // every tick while it is held, short of the bound, reads nothing
    await tick(givenUp - u);
    expect(svc.reads(), "a tick read on top of a held read").toBe(2);
    // and the first tick past it asks again
    await tick(u);
    expect(svc.reads()).toBe(3);
    release();
  });
});

describe.each(arrangements)("on the %s, reading the account and nothing else", (arrangement) => {
  it("writes nothing: no request but the read, and no control but the cadence, the refresh and the folds", async () => {
    const svc = await open(arrangement);
    fireEvent.click(refreshButton());
    await until(() => expect(svc.reads()).toBe(2));
    // every fold and every combined row pressed, and still only the read
    for (const b of page().querySelectorAll<HTMLButtonElement>("button[aria-expanded]")) fireEvent.click(b);
    await drain();
    expect(svc.requests.every((r) => r === "GET /account")).toBe(true);
    const controls = [...page().querySelectorAll("button, input, select, textarea, form")];
    const named = controls.filter((el) => !el.hasAttribute("aria-expanded"))
      .map((el) => el.getAttribute("aria-label") ?? el.id ?? el.tagName);
    expect(named).toEqual(["refresh now", "nx-acct-refresh"]);
    // the rest fold or open what is drawn: three sections, two underlyings and one combined row
    const folds = controls.filter((el) => el.hasAttribute("aria-expanded"));
    expect(folds.every((el) => el.tagName === "BUTTON" && el.getAttribute("type") === "button")).toBe(true);
    expect(folds).toHaveLength(6);
  });
});

describe.each(arrangements)("on the %s, the account drawn", (arrangement) => {
  it("says the totals, daily P&L the fifth, the masked account as served, when IBKR marked it and the live line", async () => {
    await open(arrangement);
    const top = screen.getByRole("region", { name: "totals" });
    expect(within(top).getByText("U•••••567")).toBeTruthy();
    const pairs = [["net liquidation", "$250,000", null], ["cash", "$40,001", null],
      ["unrealised P&L", "+$12,500", "gain"], ["realised P&L", "−$1,200", "loss"], ["daily P&L", "−$42", "loss"]] as const;
    expect([...top.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(pairs.map(([label]) => label));
    for (const [label, figure, outcome] of pairs) {
      const figureOf = within(top).getByText(label).nextElementSibling!;
      expect(figureOf.textContent, label).toBe(figure);
      expect(figureOf.getAttribute("data-outcome"), label).toBe(outcome);
    }
    // net liquidation and cash keep IBKR's time; the P&L stream's is the live line, in place of
    // "read at": the stream's stamp on its own clock and zone, as every served time is written
    expect(text()).toContain("IBKR marked at 14:32");
    const live = top.querySelector<HTMLElement>("[data-live]")!;
    expect(live.textContent).toMatch(/^live · updated 21:04:36 (SGT|GMT\+8)$/);
    expect(text()).not.toMatch(/read at/);
    expect(screen.queryByText(/PAPER account/)).toBeNull();
  });

  it("says when the service read it, in place of the live line, before the P&L stream has spoken", async () => {
    await open(arrangement, NOT_LIVE);
    const top = screen.getByRole("region", { name: "totals" });
    expect(top.querySelector("[data-live]")).toBeNull();
    expect(text()).not.toMatch(/live · updated/);
    expect(text()).toContain("IBKR marked at 14:32");
    expect(text()).toMatch(/read at 21:04:37 (SGT|GMT\+8)/);
    // no daily P&L anywhere: a dash
    expect(within(top).getByText("daily P&L").nextElementSibling?.textContent).toBe("—");
    expect(document.querySelector('[data-holding="AAPL"] [data-fig="daily"]')?.textContent).toBe("—");
  });

  it("dates the live line when the stream last spoke on an earlier day", async () => {
    await open(arrangement, { ...ACCOUNT, live: { updated_at: "2026-11-22 23:59:58+08:00" } });
    expect(document.querySelector("[data-live]")!.textContent).toMatch(/^live · updated Sun 20261122 23:59:58 (SGT|GMT\+8)$/);
  });

  it("draws each stock's and option's daily P&L beside its P&L, signed and coloured, a dash where it has none", async () => {
    await open(arrangement);
    const daily = (holding: string) => document.querySelector<HTMLElement>(`[data-holding="${holding}"] [data-fig="daily"]`)!;
    expect(daily("AAPL").textContent).toBe("+$260");
    expect(daily("AAPL").getAttribute("data-outcome")).toBe("gain");
    expect(daily("MSFT").textContent).toBe("−$415");
    expect(daily("MSFT").getAttribute("data-outcome")).toBe("loss");
    // QQQ's put, alone on its expiry
    expect(daily("P500").textContent).toBe("−$36");
    // the lone SPX contract's stream has said nothing
    expect(daily("C7500").textContent).toBe("—");
    expect(daily("C7500").hasAttribute("data-outcome")).toBe(false);
    // labelled where the arrangement labels a figure: the desk's column, the phone's line
    const label = (holding: string) => {
      const cell = daily(holding).closest<HTMLElement>("td, .nx-acct-figs > div")!;
      if (cell.tagName === "TD") {
        const table = cell.closest("table")!;
        return table.querySelectorAll("thead th")[[...cell.parentElement!.children].indexOf(cell)]!.textContent;
      }
      return cell.querySelector("dt")!.textContent;
    };
    expect(label("AAPL")).toBe("daily P&L");
    expect(label("P500")).toBe("daily P&L");
    // the stocks' after their P&L and its share, the options' after their P&L
    const order = (holding: string) => [...document.querySelector(`[data-holding="${holding}"]`)!.querySelectorAll("[data-fig]")]
      .filter((f) => f.closest("[data-holding]")!.getAttribute("data-holding") === holding)
      .map((f) => f.getAttribute("data-fig"));
    expect(order("AAPL")).toEqual(["qty", "cost", "mark", "value", "pnl", "pnl-share", "daily", "weight"]);
    expect(order("P500")).toEqual(["contract", "qty", "cost", "mark", "value", "pnl", "daily"]);
  });

  it("writes a daily P&L in another currency with its code beside it", async () => {
    await open(arrangement, TWO_CURRENCIES);
    const sap = document.querySelector<HTMLElement>('[data-holding="SAP"] [data-fig="daily"]')!;
    expect(sap.textContent).toBe("+95");
    expect(sap.parentElement!.querySelector("[data-currency]")?.textContent).toBe("EUR");
  });

  it("lists the stocks by value, with cost, mark, value, P&L in money and %, and weight", async () => {
    await open(arrangement);
    const stocks = screen.getByRole("region", { name: "Stocks" });
    const rows = [...stocks.querySelectorAll<HTMLElement>("[data-holding]")];
    expect(rows.map((r) => r.dataset.holding)).toEqual(["MSFT", "AAPL", "KO"]);
    const aapl = rows[1]!;
    const fig = (k: string) => aapl.querySelector(`[data-fig="${k}"]`)?.textContent;
    expect(fig("qty")).toBe("+100");
    expect(fig("cost")).toBe("150.00");
    expect(fig("mark")).toBe("180.00");
    expect(fig("value")).toBe("$18,000");
    expect(fig("pnl")).toBe("+$3,000");
    expect(fig("pnl-share")).toBe("+20.0%");
    expect(fig("weight")).toBe("7.2%");
    expect(aapl.querySelector('[data-fig="pnl"]')!.closest("[data-outcome]")?.getAttribute("data-outcome")).toBe("gain");
    const ko = rows[2]!;
    expect(ko.querySelector('[data-fig="qty"]')?.textContent).toBe("−20");
    expect(ko.querySelector('[data-fig="value"]')?.textContent).toBe("−$1,240");
  });

  it("lists a large short above a small long: by the size of its value, whatever its sign", async () => {
    const short = { ...ACCOUNT.stocks[0]!, symbol: "SHRT", position: -100, market_price: 250, market_value: -25_000 };
    await open(arrangement, { ...ACCOUNT, stocks: [...ACCOUNT.stocks, short] });
    const rows = [...screen.getByRole("region", { name: "Stocks" }).querySelectorAll<HTMLElement>("[data-holding]")];
    expect(rows.map((r) => r.dataset.holding)).toEqual(["SHRT", "MSFT", "AAPL", "KO"]);
  });

  it("groups the options by underlying, then expiry, prices per share, contracts as legs", async () => {
    await open(arrangement);
    const options = screen.getByRole("region", { name: "Options" });
    const underlyings = [...options.querySelectorAll<HTMLElement>("[data-underlying]")];
    expect(underlyings.map((u) => u.dataset.underlying)).toEqual(["QQQ", "SPX"]);
    const spx = underlyings[1]!;
    expect([...spx.querySelectorAll<HTMLElement>("[data-expiry]")].map((e) => e.dataset.expiry))
      .toEqual(["20261204", "20261218"]);
    // its three contracts on one expiry are one row (the owner, 2026-11-24), each a leg under it
    const dec18 = spx.querySelector<HTMLElement>('[data-expiry="20261218"]')!;
    expect(dec18.querySelectorAll("[data-combo]")).toHaveLength(1);
    const rows = [...dec18.querySelectorAll<HTMLElement>("[data-leg]")];
    expect(rows.map((r) => r.querySelector('[data-fig="contract"]')?.textContent)).toEqual(["P6750", "P6800", "C7300"]);
    const short = rows[1]!;
    // the contract written through Legs.tsx: its type in the type's colour, a short leg bold
    expect(short.querySelector('.nx-leg')?.getAttribute("data-side")).toBe("short");
    expect(short.querySelector('.nx-leg-t')?.getAttribute("data-type")).toBe("PUT");
    const fig = (k: string) => short.querySelector(`[data-fig="${k}"]`)?.textContent;
    expect(fig("qty")).toBe("−2");
    // per share, as IBKR marks it and as the page writes every price
    expect(fig("cost")).toBe("11.30");
    expect(fig("mark")).toBe("8.45");
    expect(fig("value")).toBe("−$1,690");
    expect(fig("pnl")).toBe("+$570");
  });

  it("draws a put before a call at one strike, and an option with no expiry last, under \"no expiry\"", async () => {
    await open(arrangement, ODD_OPTIONS);
    const spx = document.querySelector<HTMLElement>('[data-underlying="SPX"]')!;
    const expiries = [...spx.querySelectorAll<HTMLElement>("[data-expiry]")];
    expect(expiries.map((e) => e.dataset.expiry)).toEqual(["20261204", "20261218", ""]);
    const last = expiries.at(-1)!;
    expect(last.textContent).toContain("no expiry");
    expect([...last.querySelectorAll('[data-fig="contract"]')].map((c) => c.textContent)).toEqual(["P7000"]);
    expect([...expiries[1]!.querySelectorAll('[data-fig="contract"]')].map((c) => c.textContent))
      .toEqual(["P6750", "P6800", "P7000", "C7000", "C7300"]);
  });

  it("lists what is neither a stock nor an option", async () => {
    await open(arrangement);
    const other = screen.getByRole("region", { name: "Other" });
    const row = other.querySelector<HTMLElement>('[data-holding="MES"]')!;
    expect(row.textContent).toContain("FUT");
    expect(row.querySelector('[data-fig="qty"]')?.textContent).toBe("+1");
    expect(row.querySelector('[data-fig="value"]')?.textContent).toBe("$3,000");
  });

  it("names no currency when everything is in the base", async () => {
    await open(arrangement);
    expect(page().querySelectorAll("[data-currency]")).toHaveLength(0);
    expect(text()).not.toMatch(/\bEUR\b/);
  });

  it("names the currency beside every figure not in the base, and weighs and sorts it in the base", async () => {
    await open(arrangement, TWO_CURRENCIES);
    const stocks = screen.getByRole("region", { name: "Stocks" });
    const row = stocks.querySelector<HTMLElement>('[data-holding="SAP"]')!;
    for (const k of ["cost", "mark", "value", "pnl"]) {
      const cell = row.querySelector<HTMLElement>(`[data-fig="${k}"]`)!;
      expect(cell.parentElement!.querySelector("[data-currency]")?.textContent, k).toBe("EUR");
    }
    // shown in its own currency, weighed at IBKR's rate: 16,800 EUR × 1.0841 on 250,000 USD
    expect(row.querySelector('[data-fig="value"]')?.textContent).toBe("16,800");
    expect(row.querySelector('[data-fig="weight"]')?.textContent).toBe("7.3%");
    expect(row.querySelector('[data-fig="weight"]')!.parentElement!.querySelector("[data-currency]")).toBeNull();
    // and listed by that value, above AAPL, not by the smaller number it is written as
    expect([...stocks.querySelectorAll<HTMLElement>("[data-holding]")].map((r) => r.dataset.holding))
      .toEqual(["MSFT", "SAP", "AAPL", "KO"]);
    // the USD rows beside it carry no code and keep their weights
    const aapl = stocks.querySelector<HTMLElement>('[data-holding="AAPL"]')!;
    expect(aapl.querySelectorAll("[data-currency]")).toHaveLength(0);
    expect(aapl.querySelector('[data-fig="weight"]')?.textContent).toBe("7.2%");
    const fesx = screen.getByRole("region", { name: "Other" }).querySelector<HTMLElement>('[data-holding="FESX"]')!;
    expect(fesx.querySelector("[data-currency]")?.textContent).toBe("EUR");
    // the totals as served, in the base
    const top = screen.getByRole("region", { name: "totals" });
    expect(within(top).getByText("net liquidation").nextElementSibling?.textContent).toBe("$250,000");
  });

  it("weighs nothing in a currency IBKR sent no rate for, and lists it after every one that converts", async () => {
    await open(arrangement, NO_RATE);
    const stocks = screen.getByRole("region", { name: "Stocks" });
    expect([...stocks.querySelectorAll<HTMLElement>("[data-holding]")].map((r) => r.dataset.holding))
      .toEqual(["MSFT", "SAP", "AAPL", "KO", "VOLV.B"]);
    const row = stocks.querySelector<HTMLElement>('[data-holding="VOLV.B"]')!;
    expect(row.querySelector('[data-fig="weight"]')?.textContent).toBe("—");
    expect(row.querySelector('[data-fig="value"]')?.textContent).toBe("78,000");
    expect(row.querySelector('[data-fig="value"]')!.parentElement!.querySelector("[data-currency]")?.textContent).toBe("SEK");
  });

  it("hides the money and the counts as the book does, under the book's privacy setting", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await open(arrangement, TWO_CURRENCIES);
    const top = screen.getByRole("region", { name: "totals" });
    for (const label of ["net liquidation", "cash", "unrealised P&L", "realised P&L", "daily P&L"]) {
      expect(within(top).getByText(label).nextElementSibling?.textContent, label).toBe("$•••");
    }
    const fig = (holding: string, k: string) =>
      document.querySelector(`[data-holding="${holding}"] [data-fig="${k}"]`)?.textContent;
    expect(fig("AAPL", "value")).toBe("$•••");
    expect(fig("AAPL", "pnl")).toBe("$•••");
    expect(fig("AAPL", "daily")).toBe("$•••");
    expect(fig("SAP", "daily")).toBe("•••");
    expect(fig("AAPL", "qty")).toBe("+•••");
    expect(fig("SAP", "value")).toBe("•••");
    expect(fig("MES", "value")).toBe("$•••");
    expect(fig("MES", "qty")).toBe("+•••");
    // prices per share and the percentages stay, as the book keeps its points and %
    expect(fig("AAPL", "cost")).toBe("150.00");
    expect(fig("AAPL", "mark")).toBe("180.00");
    expect(fig("AAPL", "pnl-share")).toBe("+20.0%");
    expect(fig("AAPL", "weight")).toBe("7.2%");
    const short = document.querySelectorAll('[data-underlying="SPX"] [data-expiry="20261218"] [data-leg]')[1]!;
    expect(short.querySelector('[data-fig="qty"]')?.textContent).toBe("−•••");
    expect(short.querySelector('[data-fig="value"]')?.textContent).toBe("$•••");
    expect(short.querySelector('[data-fig="daily"]')?.textContent).toBe("$•••");
    // no amount anywhere on the page
    expect(text()).not.toMatch(/\$\d|\d,\d{3}/);
  });

  it("puts a PAPER account banner above the figures", async () => {
    await open(arrangement, PAPER);
    const banner = screen.getByText("PAPER account");
    const top = screen.getByRole("region", { name: "totals" });
    expect(banner.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(top).getByText("DU•••••890")).toBeTruthy();
  });

  it("says an account that holds nothing does, under its totals", async () => {
    await open(arrangement, EMPTY);
    expect(screen.getByText("nothing held in this account")).toBeTruthy();
    expect(screen.getByRole("region", { name: "totals" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Stocks" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Options" })).toBeNull();
  });

  it("says it is reading before the first answer", async () => {
    const svc = serveAccount();
    const release = svc.hold();
    if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
    render(<Page path="/account" base="/" />);
    expect(await screen.findByText("reading the account…")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "totals" })).toBeNull();
    release();
    await waitFor(() => expect(screen.getByRole("region", { name: "totals" })).toBeTruthy());
    expect(screen.queryByText("reading the account…")).toBeNull();
  });

  for (const [name, refusal, words] of [
    ["not configured", REFUSALS.notConfigured, "IB Gateway is not configured"],
    ["not answering", REFUSALS.notAnswering, REFUSALS.notAnswering.detail],
    ["past the deadline", REFUSALS.deadline, REFUSALS.deadline.detail],
    ["several accounts", REFUSALS.severalAccounts, REFUSALS.severalAccounts.detail],
    ["refusing the session", REFUSALS.refusedSession, REFUSALS.refusedSession.detail],
  ] as const) {
    it(`says the service's words when IB Gateway is ${name} on the first read, and no figure`, async () => {
      await open(arrangement, refusal);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(words);
      expect(screen.queryByRole("region", { name: "totals" })).toBeNull();
      expect(screen.queryByRole("region", { name: "Stocks" })).toBeNull();
      expect(text()).not.toMatch(/\$|IBKR marked/);
    });
  }

  it("keeps the last figures, dimmed, under the error and as of their read, when a refresh fails after a good read", async () => {
    const svc = await open(arrangement);
    const view = () => document.querySelector<HTMLElement>(".nx-acct-view")!;
    expect(view().hasAttribute("data-stale")).toBe(false);
    expect(screen.queryByText(/^as of /)).toBeNull();
    svc.answer = REFUSALS.notAnswering;
    fireEvent.click(refreshButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(REFUSALS.notAnswering.detail));
    // the figures of the last good read, still there and dimmed
    expect(within(screen.getByRole("region", { name: "totals" })).getByText("net liquidation").nextElementSibling?.textContent)
      .toBe("$250,000");
    expect(view().hasAttribute("data-stale")).toBe(true);
    // the error, then when they were read, then the figures
    const asOf = screen.getByText(/^as of /);
    expect(asOf.textContent).toMatch(/^as of 21:04:37 (SGT|GMT\+8)$/);
    const alert = screen.getByRole("alert");
    expect(alert.compareDocumentPosition(asOf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(asOf.compareDocumentPosition(view()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and the next good read draws them afresh, undimmed, with no error
    svc.answer = { ...ACCOUNT, read_at: "2026-11-23 21:06:00+08:00", live: { updated_at: "2026-11-23 21:05:59+08:00" } };
    fireEvent.click(refreshButton());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(view().hasAttribute("data-stale")).toBe(false);
    expect(screen.queryByText(/^as of /)).toBeNull();
    expect(text()).toMatch(/live · updated 21:05:59/);
  });

  it("dims the figures with \"as of\" when a read fails while live: the connection lost is a failed refresh (#478)", async () => {
    const svc = await open(arrangement);
    svc.answer = { status: 502, detail: "The connection to IB Gateway was lost" };
    await tick(1_000);
    await until(() => expect(screen.getByRole("alert").textContent).toContain("The connection to IB Gateway was lost"));
    expect(document.querySelector(".nx-acct-view")!.hasAttribute("data-stale")).toBe(true);
    // the last good figures kept, daily P&L among them, as of when the service last answered
    const top = screen.getByRole("region", { name: "totals" });
    expect(within(top).getByText("daily P&L").nextElementSibling?.textContent).toBe("−$42");
    expect(screen.getByText(/^as of /).textContent).toMatch(/^as of 21:04:37 (SGT|GMT\+8)$/);
  });

  it("dates a read from an earlier day, in 'read at' and in 'as of' when a refresh then fails", async () => {
    // a page left open overnight while the gateway is down: yesterday's figures must say so
    const svc = await open(arrangement, { ...NOT_LIVE, read_at: "2026-11-22 21:04:37+08:00" });
    expect(text()).toMatch(/read at Sun 20261122 21:04:37 (SGT|GMT\+8)/);
    svc.answer = REFUSALS.notAnswering;
    fireEvent.click(refreshButton());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/^as of /).textContent).toMatch(/^as of Sun 20261122 21:04:37 (SGT|GMT\+8)$/);
  });

  it("keeps them through a failure of the poll's own read too", async () => {
    const svc = await open(arrangement);
    svc.answer = REFUSALS.deadline;
    await tick(1_000);
    await until(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("region", { name: "totals" })).toBeTruthy();
    expect(document.querySelector(".nx-acct-view")!.hasAttribute("data-stale")).toBe(true);
  });
});
