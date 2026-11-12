/** Every figure of a rule's contract or combo, in the desk's inspector and the phone's sheet (#332).
 *
 *  Today's sheet at `/opt` lists a contract's bid, ask, last trade, IV and every greek, and a
 *  combo's greeks (ADR 0008: "the sheet shows every figure"). These hold `/opt/next` to the same:
 *  each figure the service served, at the decimals ADR 0023 fixes per field, and each one it did
 *  not serve as a dash WITH its reason — never 0, and never a sum worked out here.
 *
 *  Behaviour only; what the two arrangements must MEASURE is in `__browser__/NextRuleFigures*`. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry } from "../api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { ruleFigures, wholeMissing } from "../next/quotefigures";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

afterEach(cleanup);

/** w-lone with everything a Provider serves for one contract. */
const FULL = {
  name: "SPXW 261231 8000.00C", bid_price: 0.45, ask_price: 0.55, mid_price: 0.5, last_price: 0.6,
  update_time: "2026-11-11 23:58:12+08:00", fetched_at: "2026-11-12 04:10:00+08:00",
  option_implied_volatility: 14.237, option_delta: 0.04, option_gamma: 0.000123,
  option_theta: -0.0567, option_vega: 0.4321,
};

const quote = (id: string) => QUOTES.find((q) => q.id === id)!;
const withQuote = (id: string, over: Partial<Entry>) => ({ ...quote(id), ...over }) as Entry;
const figure = (rows: ReturnType<typeof ruleFigures>, label: string) => {
  const f = rows.find((r) => r.label === label);
  if (!f) throw new Error(`no figure "${label}" in ${rows.map((r) => r.label).join(", ")}`);
  return f;
};

describe("a single contract's figures", () => {
  it("are every figure its quote carries, at the decimals fixed per field", () => {
    const rows = ruleFigures(withQuote("w-lone", { quote: FULL }));
    expect(rows.map((r) => [r.label, r.text, r.why])).toEqual([
      ["bid", "0.45", null],
      ["ask", "0.55", null],
      ["mid", "0.50", null],
      ["last", "0.60", null],
      // the time of the last TRADE, not the quote's freshness: a far strike can go days unprinted
      ["last trade", "2026-11-11 23:58:12", null],
      ["IV", "14.24%", null],
      ["Δ", "0.040", null],
      ["γ", "0.0001", null],
      ["θ", "-0.06", null],
      ["vega", "0.43", null],
    ]);
  });

  it("say a figure the Provider did not send as a dash with why, never 0", () => {
    // w-dec18-delta's quote carries its name and its delta, and nothing else
    const rows = ruleFigures(quote("w-dec18-delta"));
    expect(figure(rows, "Δ")).toMatchObject({ text: "-0.170", why: null });
    for (const label of ["bid", "ask", "last", "IV", "γ", "θ", "vega"]) {
      expect(figure(rows, label)).toMatchObject({ text: "—", why: "not served for this contract" });
    }
    // the mid is derived, and only from both sides
    expect(figure(rows, "mid")).toMatchObject({ text: "—", why: "needs both a bid and an ask" });
    // no stamp at all is a Provider that sends none (IB Gateway never does), not an untraded contract
    expect(figure(rows, "last trade")).toMatchObject({ text: "—", why: "not served by the provider" });
    expect(rows.some((r) => /^-?0(\.0+)?%?$/.test(r.text))).toBe(false);
  });

  it("are one reason, not ten dashes repeating it, when the batch carried no quote for it", () => {
    const none = withQuote("w-lone", { quote: null });
    expect(ruleFigures(none)).toEqual([]);
    expect(wholeMissing(none)).toBe("no quote in this poll");
    expect(wholeMissing(withQuote("w-lone", { quote: FULL }))).toBeNull();
  });

  it("say the service's own word when the Provider does not know the contract", () => {
    const unknown = withQuote("w-lone", { quote: null, error: "unknown contract" });
    expect(ruleFigures(unknown)).toEqual([]);
    expect(wholeMissing(unknown)).toBe("unknown contract");
  });

  it("read IB Gateway's quote, which carries a last price and never a last-trade time", () => {
    const ibkr = { bid_price: 1.1, ask_price: 1.2, mid_price: 1.15, last_price: 1.15, option_delta: 0.2 };
    const rows = ruleFigures(withQuote("w-lone", { quote: ibkr }));
    expect(figure(rows, "last")).toMatchObject({ text: "1.15", why: null });
    expect(figure(rows, "last trade")).toMatchObject({ text: "—", why: "not served by the provider" });
  });

  it("read moomoo's N/A for a contract that has not traded as no trade, never as a time", () => {
    const untraded = { ...FULL, update_time: "N/A" };
    const rows = ruleFigures(withQuote("w-lone", { quote: untraded }));
    expect(figure(rows, "last trade")).toMatchObject({ text: "—", why: "no trade reported" });
    // a price beside a real stamp stays a figure
    expect(figure(rows, "last")).toMatchObject({ text: "0.60", why: null });
    // and the price of no trade — the 0 a never-traded contract arrives with — is no price at all
    const zero = ruleFigures(withQuote("w-lone", { quote: { ...untraded, last_price: 0 } }));
    expect(figure(zero, "last")).toMatchObject({ text: "—", why: "no trade reported" });
    // anything that is not a stamp is not drawn as one
    const odd = ruleFigures(withQuote("w-lone", { quote: { ...FULL, update_time: "--" } }));
    expect(figure(odd, "last trade")).toMatchObject({ text: "—", why: "no trade reported" });
  });

  it("derive no mid in the browser: bid and ask without the served mid is a dash", () => {
    const rows = ruleFigures(withQuote("w-lone", { quote: { ...FULL, mid_price: undefined } }));
    expect(figure(rows, "bid")).toMatchObject({ text: "0.45", why: null });
    expect(figure(rows, "mid")).toMatchObject({ text: "—", why: "needs both a bid and an ask" });
  });

  it("say a served γ too small for four places as under 0.0001, never 0.0000", () => {
    const tiny = (g: number) => figure(ruleFigures(withQuote("w-lone", { quote: { ...FULL, option_gamma: g } })), "γ").text;
    expect(tiny(0.00004)).toBe("<0.0001");
    expect(tiny(-0.00004)).toBe(">-0.0001");
    expect(tiny(0)).toBe("0.0000");
    expect(tiny(0.00006)).toBe("0.0001");
  });

  it("read a figure that is not a finite number as not served, rather than printing it", () => {
    const rows = ruleFigures(withQuote("w-lone", {
      quote: { ...FULL, bid_price: "0.45", option_gamma: null } as unknown as Entry["quote"],
    }));
    expect(figure(rows, "bid")).toMatchObject({ text: "—", why: "not served for this contract" });
    expect(figure(rows, "γ")).toMatchObject({ text: "—", why: "not served for this contract" });
    // a zero the Provider DID serve is a figure, and says so
    const zero = ruleFigures(withQuote("w-lone", { quote: { ...FULL, bid_price: 0 } }));
    expect(figure(zero, "bid")).toMatchObject({ text: "0.00", why: null });
  });
});

describe("a combo's figures", () => {
  it("are its value and its greeks as the service summed them, and no IV", () => {
    const rows = ruleFigures(withQuote("w-dec18", {
      combo_greeks: { option_delta: -0.0512, option_gamma: -0.00031, option_theta: 0.731, option_vega: -1.284 },
    }));
    expect(rows.map((r) => [r.label, r.text, r.why])).toEqual([
      ["spread value", "-2.40", null],
      ["Δ", "-0.051", null],
      ["γ", "-0.0003", null],
      ["θ", "0.73", null],
      ["vega", "-1.28", null],
    ]);
  });

  it("say a greek the service could not sum as a dash, never a partial sum", () => {
    const rows = ruleFigures(withQuote("w-dec18", {
      combo_value: null, combo_greeks: { option_delta: -0.05, option_gamma: null },
    }));
    const partial = "a leg has no figure, and no sum is taken from part of them";
    expect(figure(rows, "spread value")).toMatchObject({ text: "—", why: partial });
    expect(figure(rows, "Δ")).toMatchObject({ text: "-0.050", why: null });
    for (const label of ["γ", "θ", "vega"]) expect(figure(rows, label)).toMatchObject({ text: "—", why: partial });
    // the fixture's own combo carries no greeks at all, as a row from before they were served
    for (const label of ["Δ", "γ", "θ", "vega"]) {
      expect(figure(ruleFigures(quote("w-dec18")), label)).toMatchObject({ text: "—", why: partial });
    }
  });

  it("list no spread value for a rule watching a greek: its sum is that greek, not a price", () => {
    const rows = ruleFigures(withQuote("w-dec18", {
      field: "option_delta", combo_value: -0.05, combo_greeks: { option_delta: -0.0512 },
    }));
    expect(rows.some((r) => r.label === "spread value")).toBe(false);
    expect(rows.some((r) => r.text === "-0.05")).toBe(false);
    expect(figure(rows, "Δ")).toMatchObject({ text: "-0.051", why: null });
  });

  it("say why a held spread has no cost to close when every leg is priced but not held once", () => {
    const rows = ruleFigures(withQuote("r-calls", { field: "mid_price", combo_value: -4.4, cost_to_close: null }));
    expect(figure(rows, "cost to close")).toMatchObject({
      text: "—", why: "not every leg is held exactly once by one holding" });
    const unpriced = ruleFigures(withQuote("r-calls", { field: "mid_price", combo_value: null, cost_to_close: null }));
    expect(figure(unpriced, "cost to close").why).toBe("a leg has no figure, and no sum is taken from part of them");
  });

  it("add the cost to close where the rule covers a holding", () => {
    const rows = ruleFigures(withQuote("r-calls", { combo_value: -4.4, cost_to_close: 4.4 }));
    expect(figure(rows, "cost to close")).toMatchObject({ text: "4.40", why: null });
    expect(ruleFigures(quote("w-dec18")).some((r) => r.label === "cost to close")).toBe(false);
  });
});

function props(quotes: Entry[], over: Partial<BookProps> = {}): BookProps {
  return {
    quotes, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    mode: "live", privacy: false, entryStyle: "opportunity", ...over,
  };
}

const BOOK = QUOTES.map((q) => q.id === "w-lone" ? { ...q, quote: FULL } as Entry : q);

/** A figure as drawn: its label's `<dt>`, and the `<dd>` beside it. */
function drawn(scope: HTMLElement, label: string): string {
  const list = within(scope).getByRole("group", { name: "figures" });
  const dt = within(list).getAllByText(label, { selector: "dt" });
  expect(dt).toHaveLength(1);
  return dt[0]!.nextElementSibling!.textContent!;
}

const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref)!;

async function openDesk(id: string, book: Entry[] = BOOK, privacy = false): Promise<HTMLElement> {
  render(<DeskBook {...props(book, { privacy })} />);
  fireEvent.click(within(deskRow(id)).getAllByRole("button")[0]!);
  return screen.getByRole("complementary", { name: /inspector/ });
}

async function openPhone(id: string, book: Entry[] = BOOK, privacy = false): Promise<HTMLElement> {
  render(<div className="nx"><PhoneBook {...props(book, { privacy })} /></div>);
  fireEvent.click(within(card(id)).getByRole("button", { name: /details of/ }));
  return screen.findByRole("dialog");
}

describe.each([["the desk's inspector", openDesk], ["the phone's sheet", openPhone]])("%s", (_, open) => {
  it("shows every figure of a single contract", async () => {
    const at = await open("w-lone");
    expect(drawn(at, "bid")).toBe("0.45");
    expect(drawn(at, "ask")).toBe("0.55");
    expect(drawn(at, "mid")).toBe("0.50");
    expect(drawn(at, "last")).toBe("0.60");
    expect(drawn(at, "last trade")).toBe("2026-11-11 23:58:12");
    expect(drawn(at, "IV")).toBe("14.24%");
    expect(drawn(at, "Δ")).toBe("0.040");
    expect(drawn(at, "γ")).toBe("0.0001");
    expect(drawn(at, "θ")).toBe("-0.06");
    expect(drawn(at, "vega")).toBe("0.43");
  });

  it("says a figure not served as a dash with its reason, beside it", async () => {
    const at = await open("w-lone", BOOK.map((q) => q.id === "w-lone" ? { ...q, quote: { ...FULL, option_gamma: undefined } } as Entry : q));
    expect(drawn(at, "γ")).toBe("— not served for this contract");
    expect(drawn(at, "θ")).toBe("-0.06");
  });

  it("shows a combo's value and the greeks the service summed, and no IV", async () => {
    const greeks = { option_delta: -0.0512, option_gamma: -0.00031, option_theta: 0.731, option_vega: -1.284 };
    const at = await open("w-dec18", BOOK.map((q) => q.id === "w-dec18" ? { ...q, combo_greeks: greeks } as Entry : q));
    expect(drawn(at, "spread value")).toBe("-2.40");
    expect(drawn(at, "Δ")).toBe("-0.051");
    expect(drawn(at, "γ")).toBe("-0.0003");
    expect(drawn(at, "θ")).toBe("0.73");
    expect(drawn(at, "vega")).toBe("-1.28");
    expect(within(within(at).getByRole("group", { name: "figures" })).queryByText("IV")).toBeNull();
  });

  it("calls a delta rule's summed delta no spread value, anywhere", async () => {
    const delta = BOOK.map((q) => q.id === "w-dec18"
      ? { ...q, field: "option_delta", threshold: 0.2, combo_value: -0.05, watched: -0.05,
          combo_greeks: { option_delta: -0.0512 } } as Entry : q);
    const at = await open("w-dec18", delta);
    expect(at.textContent).not.toContain("spread value");
    expect(drawn(at, "Δ")).toBe("-0.051");
  });

  it("labels the spread value once in the whole of it, for a rule on the spread's price", async () => {
    const at = await open("w-dec18");
    // as a figure's label, anywhere in the sheet or inspector — the facts once had one of their own
    expect(within(at).getAllByText("spread value", { selector: "dt" })).toHaveLength(1);
    expect(drawn(at, "spread value")).toBe("-2.40");
  });

  it("says once why there are no figures, rather than a dash per figure", async () => {
    const at = await open("w-lone", BOOK.map((q) => q.id === "w-lone"
      ? { ...q, quote: null, error: "unknown contract", watched: null, fill: null } as Entry : q));
    expect(within(at).queryByRole("group", { name: "figures" })).toBeNull();
    const line = at.querySelector("[data-figures-missing]")!;
    expect(line.textContent).toBe("no figures — unknown contract");
    expect(at.querySelectorAll("[data-figure]")).toHaveLength(0);
  });

  it("hides none of them under privacy: they are a contract's figures in points, not $ amounts", async () => {
    const at = await open("w-lone", BOOK, true);
    expect(drawn(at, "bid")).toBe("0.45");
    expect(drawn(at, "vega")).toBe("0.43");
  });
});

describe("the desk's inspector, on a holding", () => {
  it("gives its γ beside its Δ, θ and vega, at four places", async () => {
    const held = HOLDINGS.map((h) => h.id === "h-ic"
      ? { ...h, greeks: { option_delta: -0.12, option_gamma: -0.00042, option_theta: 1.1, option_vega: -2.3 } } : h);
    render(<DeskBook {...props(BOOK, { holdings: held })} />);
    fireEvent.click(within(deskRow("h-ic")).getByRole("button", { name: "1231_IC" }));
    const insp = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(insp).getByText("position γ").nextElementSibling!.textContent).toBe("-0.0004");
    cleanup();
    // and a dash where the service summed none
    render(<DeskBook {...props(BOOK)} />);
    fireEvent.click(within(deskRow("h-ic")).getByRole("button", { name: "1231_IC" }));
    const bare = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(bare).getByText("position γ").nextElementSibling!.textContent).toBe("—");
  });
});
