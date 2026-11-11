/** The payoff at expiry, drawn (#291, ADR 0023): in the desk's inspector and the phone's detail
 *  sheet, for a holding at its Entry and for a watched spread at its current value, with SPX's
 *  derived price as a marker. Behaviour only — what is asked for, what is said, what privacy hides.
 *  That the chart FITS is measured by the browser suite (`NextDesk.test.tsx`,
 *  `NextPhone.iphone.test.tsx` under `__browser__/`). */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES } from "../testing/ownerBook";

/** Every request the page made, as `METHOD path body`. */
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
    const body = payoffAnswer(path);
    return Promise.resolve(body
      ? { ok: true, status: 200, json: () => Promise.resolve(body) }
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    mode: "live", privacy: false, entryStyle: "opportunity", ...over,
  };
}

const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

/** The desk, with one row's inspector open, and its payoff once it has arrived. */
async function inspect(id: string, name: string, over: Partial<BookProps> = {}) {
  render(<DeskBook {...props(over)} />);
  fireEvent.click(within(deskRow(id)).getByRole("button", { name }));
  return screen.getByRole("complementary", { name: `inspector: ${name}` });
}

const payoffOf = (root: HTMLElement) => within(root).findByRole("group", { name: "payoff at expiry" });

describe("a holding's payoff, in the desk's inspector", () => {
  it("asks for it by the holding's id, and draws the curve, the breakevens and the maximums", async () => {
    const insp = await inspect("h-ic", "1231_IC");
    const payoff = await payoffOf(insp);
    expect(asked).toEqual(["GET /positions/h-ic/payoff"]);
    expect(within(payoff).getByRole("img", { name: /payoff at expiry/ })).toBeTruthy();
    expect(payoff.querySelector("[data-curve]")?.getAttribute("d")).toMatch(/^M/);
    // points times the contract size the valuation served (100): money, as P&L is
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+$500");
    expect(within(payoff).getByText("max loss").nextElementSibling?.textContent).toBe("-$4,500");
    expect(within(payoff).getByText("breakevens").nextElementSibling?.textContent).toBe("6295 · 7405");
    expect(payoff.querySelectorAll("[data-breakeven]")).toHaveLength(2);
  });

  it("marks SPX's derived price on it", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const marker = payoff.querySelector("[data-marker='spx']");
    expect(marker?.textContent).toBe("SPX 6900.50");
  });

  it("draws no marker without a derived price, and says why in its place", async () => {
    const reason = "the Provider gives no option premium to derive it from";
    const blind = HOLDINGS.map((h) => ({ ...h, spx: null, spx_reason: reason }) as Holding);
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC", { holdings: blind }));
    expect(payoff.querySelector("[data-marker='spx']")).toBeNull();
    expect(within(payoff).getByText(`SPX — ${reason}`)).toBeTruthy();
  });

  it("hides every $ figure under privacy, and keeps the breakevens and SPX", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC", { privacy: true }));
    const text = payoff.textContent ?? "";
    expect(text).not.toMatch(/\$\d/);
    // the points are the money divided by a size the privacy setting also hides, so they go too
    expect(text).not.toMatch(/\d pts/);
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("$•••");
    expect(within(payoff).getByText("max loss").nextElementSibling?.textContent).toBe("$•••");
    expect(within(payoff).getByText("breakevens").nextElementSibling?.textContent).toBe("6295 · 7405");
    expect(payoff.querySelector("[data-marker='spx']")?.textContent).toBe("SPX 6900.50");
  });

  it("asks for nothing for a holding with no Entry, and says why", async () => {
    const blank = HOLDINGS.map((h) => (h.id === "h-ic" ? { ...h, entry: null } : h) as Holding);
    const insp = await inspect("h-ic", "1231_IC", { holdings: blank });
    expect(within(insp).getByText(/no Entry recorded/)).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("says so when the service refuses, rather than drawing nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false, status: 502, json: () => Promise.resolve({ detail: "x" }),
    })));
    const insp = await inspect("h-ic", "1231_IC");
    expect(await within(insp).findByText(/payoff could not be drawn/)).toBeTruthy();
  });
});

describe("a watched spread's payoff", () => {
  it("is drawn at its current value as the credit, and labelled so", async () => {
    const payoff = await payoffOf(await inspect("w-dec18", "1218_P7150"));
    // minus is short (ADR 0013), and the combo's value is signed under those signs, so the credit
    // it would be sold for now is the NEGATIVE of its value
    expect(asked).toEqual([
      'POST /positions/payoff {"legs":[{"side":"short","option_type":"PUT","strike":7150},'
        + '{"side":"long","option_type":"PUT","strike":7100}],"entry":2.4,"contracts":1}',
    ]);
    expect(within(payoff).getByText("no Entry: drawn at its current value, 2.40, as the credit")).toBeTruthy();
    // one spread nobody holds, so points rather than money
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+2.40 pts");
    expect(payoff.querySelector("[data-marker='spx']")?.textContent).toBe("SPX 6900.50");
  });

  it("asks again when its value moves, since the curve is drawn at it", async () => {
    const view = render(<DeskBook {...props()} />);
    fireEvent.click(within(deskRow("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    const moved = QUOTES.map((q) => (q.id === "w-dec18" ? { ...q, combo_value: -2.55 } : q) as Entry);
    view.rerender(<DeskBook {...props({ quotes: moved })} />);
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain('"entry":2.55');
  });

  it("draws nothing without a current value, and says so", async () => {
    const insp = await inspect("w-dec31", "1231_C7600");
    expect(within(insp).getByText(/no current value to draw it at/)).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("is not drawn for a rule on a single contract", async () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(deskRow("w-lone")).getByRole("button"));
    const insp = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(insp).queryByRole("group", { name: "payoff at expiry" })).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("in the phone's detail sheet", () => {
  const draw = (over: Partial<BookProps> = {}) =>
    render(<div className="nx"><PhoneBook {...props(over)} /></div>);
  const card = (ref: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref)!;

  it("draws a holding's, with its $ figures hidden under privacy", async () => {
    draw({ privacy: true });
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of 1218_C7300/ }));
    const payoff = await payoffOf(await screen.findByRole("dialog"));
    expect(asked).toEqual(["GET /positions/h-calls/payoff"]);
    expect(payoff.textContent).not.toMatch(/\$\d/);
    expect(within(payoff).getByText("breakevens").nextElementSibling?.textContent).toBe("7302");
  });

  it("draws a watched spread's at its current value, labelled so", async () => {
    draw();
    fireEvent.click(within(card("w-dec18")).getByRole("button", { name: /details of 1218_P7150/ }));
    const payoff = await payoffOf(await screen.findByRole("dialog"));
    expect(within(payoff).getByText(/drawn at its current value, 2\.40, as the credit/)).toBeTruthy();
  });
});
