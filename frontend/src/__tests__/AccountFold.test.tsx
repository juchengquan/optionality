/** The account page's folds and combined options (the owner, 2026-11-24), on made-up accounts
 *  (`testing/account.ts`), on the desk and the phone:
 *
 *  - Options, Stocks and Other, in that order, each fold, and so does each underlying inside
 *    Options. Stocks starts folded and the rest open (the owner, 2026-11-25); a folded heading keeps
 *    its name and adds its count, value and P&L in the base currency; where a fold differs from how
 *    it starts is remembered in `ui_account_folded` — Stocks opened as `stocks:open`.
 *  - Every option on one underlying and expiry is ONE row, its legs written as the book writes a
 *    structure, its prices netted per share and its money summed; it starts closed and opens to
 *    its legs, each drawn as a contract's row is.
 *
 *  Layout — a fold moving what is under it, nothing sideways — is the browser suite's
 *  (`__browser__/Account*.test.tsx`). */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Page } from "../Page";
import { readAccountFolded } from "../shared/prefs";
import { ACCOUNT, COMBOS, NO_RATE, serveAccount, TWO_CURRENCIES, type AccountService } from "../testing/account";
import { until } from "../testing/until";

const inner = window.fetch;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.fetch = inner;
  for (const n of ["ui_arrangement", "ui_account_refresh", "ui_privacy", "ui_account_folded"]) {
    document.cookie = `${n}=;path=/;max-age=0`;
  }
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];
const NOW = new Date("2026-11-23T13:05:00Z");

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** The page opened on `answer`, its poll's interval the test's: at a second's cadence (#478) a real
 *  one would read on top of what a test presses. */
async function open(arrangement: Arrangement, answer: AccountService["answer"] = ACCOUNT) {
  const svc = serveAccount(answer);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Page path="/opt/account" base="/opt/" />);
  await until(() => expect(svc.reads()).toBe(1));
  await drain();
  return svc;
}

/** A section's fold: its heading's button, and what it folds. */
const section = (name: string) => screen.getByRole("region", { name });
const sectionButton = (name: string) => within(section(name)).getAllByRole("button")[0]!;
const underlying = (symbol: string) => document.querySelector<HTMLElement>(`[data-underlying="${symbol}"]`)!;
const underlyingButton = (symbol: string) => within(underlying(symbol)).getAllByRole("button")[0]!;
const controlled = (button: HTMLElement) =>
  button.getAttribute("aria-controls")!.split(" ").map((id) => document.getElementById(id)!);
const words = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const storedCookie = () => document.cookie.split("; ").find((c) => c.startsWith("ui_account_folded="));

/** The combined row of an underlying's expiry, and its own button. */
const combo = (symbol: string, expiry: string) =>
  underlying(symbol).querySelector<HTMLElement>(`[data-expiry="${expiry}"] [data-combo]`)!;
const comboButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-controls]")!;
const fig = (row: Element, k: string) => {
  // the row's own figure, never one of its legs'
  const own = [...row.querySelectorAll<HTMLElement>(`[data-fig="${k}"]`)].find((f) => f.closest("[data-holding]") === row);
  return own?.textContent;
};
/** The legs of a combined row, where they are drawn: the rows after it on the desk, inside its card on the phone. */
const legRows = (row: HTMLElement) => controlled(comboButton(row))
  .flatMap((el) => (el.matches("[data-leg]") ? [el] : [...el.querySelectorAll<HTMLElement>("[data-leg]")]));

describe.each(arrangements)("on the %s, the folds", (arrangement) => {
  const unit = arrangement === "desk" ? "row" : "card";

  it("draw Options, then Stocks, then Other", async () => {
    await open(arrangement);
    expect([...document.querySelectorAll<HTMLElement>("section[data-section]")].map((x) => x.dataset.section))
      .toEqual(["options", "stocks", "other"]);
    // and with nothing in Options, Stocks first
    cleanup();
    await open(arrangement, { ...ACCOUNT, options: [] });
    expect([...document.querySelectorAll<HTMLElement>("section[data-section]")].map((x) => x.dataset.section))
      .toEqual(["stocks", "other"]);
  });

  it("start with Stocks folded and the rest open, nothing written, each heading a button saying what it folds", async () => {
    await open(arrangement);
    expect(storedCookie()).toBeUndefined();
    for (const name of ["Options", "Stocks", "Other"]) {
      const button = sectionButton(name);
      const folded = name === "Stocks";
      expect(button.tagName).toBe("BUTTON");
      expect(button.closest("h2"), name).toBeTruthy();
      expect(button.getAttribute("aria-expanded"), name).toBe(String(!folded));
      const body = controlled(button);
      expect(body).toHaveLength(1);
      expect(body[0]!.hidden, name).toBe(folded);
      // folded, the rows kept mounted
      expect(body[0]!.querySelectorAll("[data-holding]").length, name).toBeGreaterThan(0);
      // open, a heading says its name alone; folded, its count, value and P&L too
      // (19,000 + 18,000 − 1,240; −1,000 + 3,000 − 40)
      expect(words(button), name).toBe(folded ? `Stocks · 3 ${unit}s · value $35,760 · P&L +$1,960` : name);
    }
    for (const symbol of ["QQQ", "SPX"]) {
      const button = underlyingButton(symbol);
      expect(button.closest("h3"), symbol).toBeTruthy();
      expect(button.getAttribute("aria-expanded"), symbol).toBe("true");
      expect(words(button)).toBe(symbol);
      expect(controlled(button)[0]!.hidden).toBe(false);
    }
  });

  it("open Stocks to its rows, its heading its name alone, and fold it again, its rows kept and hidden", async () => {
    await open(arrangement);
    const button = sectionButton("Stocks");
    const body = controlled(button)[0]!;
    const rows = body.querySelectorAll("[data-holding]").length;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(words(button)).toBe("Stocks");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    expect(body.querySelectorAll("[data-holding]").length, "the folded rows unmounted").toBe(rows);
    expect(words(button)).toBe(`Stocks · 3 ${unit}s · value $35,760 · P&L +$1,960`);
    expect(button.querySelector('[data-fold-fig="pnl"]')!.getAttribute("data-outcome")).toBe("gain");
    // the region keeps its name
    expect(section("Stocks")).toBeTruthy();
  });

  it("fold a section that starts open, its rows kept and hidden, and open it again", async () => {
    await open(arrangement);
    const button = sectionButton("Other");
    const body = controlled(button)[0]!;
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    expect(body.querySelectorAll("[data-holding]").length, "the folded rows unmounted").toBe(1);
    expect(words(button)).toBe(`Other · 1 ${unit} · value $3,000`);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(words(button)).toBe("Other");
  });

  it("count what the arrangement draws under Options: a combined expiry is one", async () => {
    await open(arrangement);
    fireEvent.click(sectionButton("Options"));
    // QQQ's one contract, SPX's lone contract and SPX's three legs on one expiry, combined
    expect(words(sectionButton("Options"))).toBe(`Options · 3 ${unit}s · value $35 · P&L +$230`);
    fireEvent.click(sectionButton("Other"));
    // what carries no P&L sums none
    expect(words(sectionButton("Other"))).toBe(`Other · 1 ${unit} · value $3,000`);
  });

  it("fold an underlying inside Options, the others left open", async () => {
    await open(arrangement);
    fireEvent.click(underlyingButton("SPX"));
    const button = underlyingButton("SPX");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(controlled(button)[0]!.hidden).toBe(true);
    expect(words(button)).toBe(`SPX · 2 ${unit}s · value −$1,150 · P&L +$305`);
    expect(button.querySelector('[data-fold-fig="value"]')!.getAttribute("data-outcome")).toBeNull();
    expect(underlyingButton("QQQ").getAttribute("aria-expanded")).toBe("true");
    expect(sectionButton("Options").getAttribute("aria-expanded")).toBe("true");
  });

  it("sum in the base at IBKR's rates, and say where a currency has none rather than sum it", async () => {
    await open(arrangement, TWO_CURRENCIES);
    // 35,760 + 16,800 EUR × 1.0841; 1,960 + 1,400 EUR × 1.0841
    expect(words(sectionButton("Stocks"))).toBe(`Stocks · 4 ${unit}s · value $53,973 · P&L +$3,478`);
    cleanup();
    document.cookie = "ui_account_folded=;path=/;max-age=0";
    await open(arrangement, NO_RATE);
    expect(words(sectionButton("Stocks"))).toBe(`Stocks · 5 ${unit}s · no total: no rate for SEK`);
  });

  it("hide every amount in a folded heading under the book's privacy setting", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await open(arrangement, TWO_CURRENCIES);
    // Stocks starts folded
    for (const name of ["Options", "Other"]) fireEvent.click(sectionButton(name));
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
    expect(words(sectionButton("Stocks"))).toBe(`Stocks · 4 ${unit}s · value $••• · P&L $•••`);
    expect(words(sectionButton("Other"))).toBe(`Other · 2 ${unit}s · value $•••`);
    fireEvent.click(sectionButton("Options"));
    fireEvent.click(underlyingButton("SPX"));
    expect(words(underlyingButton("SPX"))).toBe(`SPX · 2 ${unit}s · value $••• · P&L $•••`);
    expect(document.querySelector(".nx-acct")!.textContent).not.toMatch(/\$\d|\d,\d{3}/);
  });

  it("are remembered in a cookie of their own where they differ from how they start, and drawn so on opening", async () => {
    await open(arrangement);
    // Stocks opened is `stocks:open`; an underlying folded is its name
    fireEvent.click(sectionButton("Stocks"));
    expect([...readAccountFolded()]).toEqual(["stocks:open"]);
    fireEvent.click(underlyingButton("SPX"));
    expect([...readAccountFolded()].sort()).toEqual(["options:SPX", "stocks:open"]);
    expect(document.cookie).not.toMatch(/(^|; )ui_folded=/);
    cleanup();
    await open(arrangement);
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("true");
    expect(underlyingButton("SPX").getAttribute("aria-expanded")).toBe("false");
    expect(underlyingButton("QQQ").getAttribute("aria-expanded")).toBe("true");
    expect(sectionButton("Options").getAttribute("aria-expanded")).toBe("true");
    // Stocks folded again, as it starts: its entry gone
    fireEvent.click(sectionButton("Stocks"));
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
    expect([...readAccountFolded()]).toEqual(["options:SPX"]);
    cleanup();
    await open(arrangement);
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
  });

  it("read an old cookie's `stocks` as folded, as Stocks now starts, and drop it at the next write", async () => {
    document.cookie = "ui_account_folded=stocks,other;path=/";
    await open(arrangement);
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
    expect(sectionButton("Other").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(underlyingButton("SPX"));
    expect(storedCookie()).toBe(`ui_account_folded=${encodeURIComponent("options:SPX,other")}`);
    // and the press that opens Stocks writes its own entry, the old one long gone
    fireEvent.click(sectionButton("Stocks"));
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("true");
    expect(storedCookie()).toBe(`ui_account_folded=${encodeURIComponent("options:SPX,other,stocks:open")}`);
  });

  it("read a hand-edited cookie tolerantly, and drop what it does not know at the next write", async () => {
    document.cookie = "ui_account_folded=other,bogus,%zz,options:QQQ;path=/";
    await open(arrangement);
    // a stray % leaves the whole value undecoded, and the entries around it still read
    expect(sectionButton("Other").getAttribute("aria-expanded")).toBe("false");
    expect(underlyingButton("QQQ").getAttribute("aria-expanded")).toBe("false");
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
    expect(sectionButton("Options").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(sectionButton("Stocks"));
    expect([...readAccountFolded()].sort()).toEqual(["options:QQQ", "other", "stocks:open"]);
    expect(storedCookie()).not.toMatch(/bogus|zz/);
  });

  it("keep another tab's folds, and fold or open what THIS tab shows", async () => {
    await open(arrangement);
    // another tab folds Other and SPX, and opens Stocks, after this one read the cookie
    document.cookie = `ui_account_folded=${encodeURIComponent("other,options:SPX,stocks:open")};path=/`;
    // this tab still shows Stocks folded: a press here opens it, never folds it again
    fireEvent.click(sectionButton("Stocks"));
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("true");
    expect([...readAccountFolded()].sort()).toEqual(["options:SPX", "other", "stocks:open"]);
    // another tab folds Stocks, which this one shows open: a press here folds it, never opens it again
    document.cookie = "ui_account_folded=other;path=/";
    fireEvent.click(sectionButton("Stocks"));
    expect(sectionButton("Stocks").getAttribute("aria-expanded")).toBe("false");
    expect([...readAccountFolded()]).toEqual(["other"]);
  });

  it("drop an underlying the account no longer holds at the next write, and keep the sections", async () => {
    document.cookie = "ui_account_folded=options%3AXYZ%2Cother;path=/";
    await open(arrangement);
    fireEvent.click(sectionButton("Stocks"));
    expect([...readAccountFolded()].sort()).toEqual(["other", "stocks:open"]);
    // a section the account has nothing in is kept: it is a section, not a holding
    cleanup();
    document.cookie = `ui_account_folded=${encodeURIComponent("other,stocks:open")};path=/`;
    await open(arrangement, { ...ACCOUNT, other: [], options: ACCOUNT.options.filter((o) => o.symbol !== "QQQ") });
    fireEvent.click(underlyingButton("SPX"));
    expect([...readAccountFolded()].sort()).toEqual(["options:SPX", "other", "stocks:open"]);
    // and Stocks' entry with nothing in Stocks
    cleanup();
    await open(arrangement, { ...ACCOUNT, stocks: [] });
    fireEvent.click(underlyingButton("SPX"));
    expect([...readAccountFolded()].sort()).toEqual(["other", "stocks:open"]);
  });

  it("stay as they are through the poll's next read", async () => {
    const svc = await open(arrangement, COMBOS);
    fireEvent.click(underlyingButton("QQQ"));
    const row = combo("SPX", "20270115");
    fireEvent.click(comboButton(row));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await drain();
    expect(svc.reads()).toBe(2);
    expect(underlyingButton("QQQ").getAttribute("aria-expanded")).toBe("false");
    expect(comboButton(combo("SPX", "20270115")).getAttribute("aria-expanded")).toBe("true");
  });
});

describe.each(arrangements)("on the %s, the options combined", (arrangement) => {
  it("draw each expiry's contracts as ONE row, written as the book writes a structure, closed", async () => {
    await open(arrangement, COMBOS);
    const row = combo("SPX", "20270115");
    // the legs short first, the short one bold, each type in its colour
    expect(row.querySelector('[data-fig="legs"]')!.textContent).toBe("−P5900 +P5850");
    const legs = [...row.querySelector('[data-fig="legs"]')!.querySelectorAll<HTMLElement>(".nx-leg")];
    expect(legs.map((l) => l.dataset.side)).toEqual(["short", "long"]);
    expect(legs.map((l) => l.querySelector(".nx-leg-t")!.getAttribute("data-type"))).toEqual(["PUT", "PUT"]);
    // closed, its legs drawn and hidden
    const button = comboButton(row);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const legRowsDrawn = legRows(row);
    expect(legRowsDrawn).toHaveLength(2);
    for (const leg of controlled(button)) expect(leg.hidden).toBe(true);
    // one row for the expiry: nothing else there but its legs
    const expiry = underlying("SPX").querySelector<HTMLElement>('[data-expiry="20270115"]')!;
    expect([...expiry.querySelectorAll("[data-holding]")].filter((r) => !r.matches("[data-leg]"))).toEqual([row]);
  });

  it("net its prices per share, a credit negative, and sum its money", async () => {
    await open(arrangement, COMBOS);
    const row = combo("SPX", "20270115");
    expect(fig(row, "qty")).toBe("1");
    expect(fig(row, "cost")).toBe("−2.60");
    expect(fig(row, "mark")).toBe("−1.80");
    expect(fig(row, "value")).toBe("−$180");
    expect(fig(row, "pnl")).toBe("+$80");
    // its legs' daily P&L summed (#478): −25 + 60
    expect(fig(row, "daily")).toBe("+$35");
    expect(row.querySelector('[data-fig="daily"]')!.getAttribute("data-outcome")).toBe("gain");
    const four = combo("SPX", "20270219");
    expect(four.querySelector('[data-fig="legs"]')!.textContent).toBe("−P5700 −C6700 +P5650 +C6750");
    expect(fig(four, "qty")).toBe("2");
    expect(fig(four, "cost")).toBe("−5.50");
    expect(fig(four, "mark")).toBe("−4.90");
    expect(fig(four, "value")).toBe("−$980");
    expect(fig(four, "pnl")).toBe("+$120");
    expect(fig(four, "daily")).toBe("+$85");
  });

  it("sum no daily P&L where a leg has none, and draw each leg's own (#478)", async () => {
    await open(arrangement, COMBOS);
    const ratio = combo("SPX", "20270319");
    expect(fig(ratio, "daily")).toBe("—");
    expect(ratio.querySelector('[data-fig="daily"]')!.hasAttribute("data-outcome")).toBe(false);
    fireEvent.click(comboButton(ratio));
    expect(legRows(ratio).map((l) => fig(l, "daily"))).toEqual(["+$44", "—"]);
  });

  it("say no daily P&L in a folded heading (#478)", async () => {
    await open(arrangement, COMBOS);
    fireEvent.click(sectionButton("Options"));
    expect(words(sectionButton("Options"))).not.toMatch(/daily/);
    expect(sectionButton("Options").querySelectorAll("[data-fold-fig]")).toHaveLength(2);
  });

  it("write unequal quantities in the legs and count the units they share", async () => {
    await open(arrangement, COMBOS);
    const ratio = combo("SPX", "20270319");
    expect(ratio.querySelector('[data-fig="legs"]')!.textContent).toBe("−2P5600 +P5650");
    expect(fig(ratio, "qty")).toBe("1");
    expect(fig(ratio, "cost")).toBe("−4.00");
    expect(fig(ratio, "value")).toBe("−$350");
  });

  it("leave a contract alone on its expiry as its own row, and never combine two expiries", async () => {
    await open(arrangement, COMBOS);
    const lone = underlying("SPX").querySelector<HTMLElement>('[data-expiry="20261204"]')!;
    expect(lone.querySelector("[data-combo]")).toBeNull();
    const [row] = [...lone.querySelectorAll<HTMLElement>("[data-holding]")];
    expect(row!.querySelector('[data-fig="contract"]')!.textContent).toBe("C7500");
    expect(fig(row!, "qty")).toBe("+1");
    const qqq = underlying("QQQ");
    expect(qqq.querySelectorAll("[data-combo]")).toHaveLength(0);
    expect([...qqq.querySelectorAll('[data-fig="contract"]')].map((c) => c.textContent)).toEqual(["C520", "C520"]);
  });

  it("open on a press of the row to its legs, each with its own figures, and close again", async () => {
    await open(arrangement, COMBOS);
    const row = combo("SPX", "20270115");
    // a click anywhere on the row: its money, here
    fireEvent.click(row.querySelector('[data-fig="value"]')!);
    const button = comboButton(row);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    for (const el of controlled(button)) expect(el.hidden).toBe(false);
    const legs = legRows(row);
    expect(legs.map((l) => l.querySelector('[data-fig="contract"]')!.textContent)).toEqual(["P5850", "P5900"]);
    const short = legs[1]!;
    expect(short.querySelector(".nx-leg")!.getAttribute("data-side")).toBe("short");
    expect(fig(short, "qty")).toBe("−1");
    expect(fig(short, "cost")).toBe("7.20");
    expect(fig(short, "mark")).toBe("5.10");
    expect(fig(short, "value")).toBe("−$510");
    expect(fig(short, "pnl")).toBe("+$210");
    // a press on a leg leaves it open
    fireEvent.click(short.querySelector('[data-fig="value"]')!);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // its own button closes it: a button, so Enter and Space press it
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    for (const el of controlled(button)) expect(el.hidden).toBe(true);
    // the others never opened
    expect(comboButton(combo("SPX", "20270219")).getAttribute("aria-expanded")).toBe("false");
  });

  it("start closed on every opening: an opened row is not remembered", async () => {
    await open(arrangement, COMBOS);
    fireEvent.click(comboButton(combo("SPX", "20270115")));
    expect(storedCookie()).toBeUndefined();
    cleanup();
    await open(arrangement, COMBOS);
    expect(comboButton(combo("SPX", "20270115")).getAttribute("aria-expanded")).toBe("false");
  });

  it("hide its money and its count under the book's privacy setting, its prices per share kept", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await open(arrangement, COMBOS);
    const row = combo("SPX", "20270219");
    fireEvent.click(comboButton(row));
    expect(fig(row, "qty")).toBe("•••");
    expect(fig(row, "value")).toBe("$•••");
    expect(fig(row, "pnl")).toBe("$•••");
    expect(fig(row, "daily")).toBe("$•••");
    expect(fig(row, "cost")).toBe("−5.50");
    // a leg's quantity per unit is the structure's shape, not its size, which the hidden count is: kept
    const ratio = combo("SPX", "20270319");
    expect(ratio.querySelector('[data-fig="legs"]')!.textContent).toBe("−2P5600 +P5650");
    for (const leg of legRows(row)) {
      expect(fig(leg, "qty")).toMatch(/^[+−]•••$/);
      expect(fig(leg, "value")).toBe("$•••");
      expect(fig(leg, "daily")).toBe("$•••");
    }
    expect(document.querySelector(".nx-acct")!.textContent).not.toMatch(/\$\d|\d,\d{3}/);
  });
});
