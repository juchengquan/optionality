/** The payoff at expiry, drawn (#291, ADR 0023): in the desk's inspector and the phone's detail
 *  sheet, for a holding at its Entry and for a watched spread at its current value, with SPX's
 *  derived price as a marker. Behaviour only — what is asked for, what is said, what privacy hides.
 *  That the chart FITS is measured by the browser suite (`NextDesk.test.tsx`,
 *  `NextPhone.iphone.test.tsx` under `__browser__/`). */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, volAnswer } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";
import { until } from "../testing/until";

/** Every request the page made, as `METHOD path body`. */
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
    const body = payoffAnswer(path) ?? volAnswer(path);
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

/** A payoff once its answer is DRAWN. The group is drawn at once, saying "drawing…" until the
 *  service answers, so finding the group alone found that: what was asserted next held only while
 *  the answer happened to be drawn inside the one turn `findByRole` lets pass. Answered a turn later
 *  (a 20 ms timer in the fake), nine of these tests failed on figures not yet drawn (#350). */
async function payoffOf(root: HTMLElement): Promise<HTMLElement> {
  const payoff = await within(root).findByRole("group", { name: "payoff at expiry" });
  await until(() => expect(within(payoff).queryByText("drawing…")).toBeNull());
  return payoff;
}

describe("a holding's payoff, in the desk's inspector", () => {
  it("asks for it by the holding's id, and draws the curve, the breakevens and the maximums", async () => {
    const insp = await inspect("h-ic", "1231_IC");
    const payoff = await payoffOf(insp);
    expect(asked).toEqual(["GET /positions/h-ic/payoff"]);
    expect(within(payoff).getByRole("img", { name: /payoff at expiry/ })).toBeTruthy();
    expect(payoff.querySelector("[data-curve]")?.getAttribute("d")).toMatch(/^M/);
    // points across its two contracts times the contract size the valuation served (100): money
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+$1,000");
    expect(within(payoff).getByText("max loss").nextElementSibling?.textContent).toBe("-$9,000");
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

  it("never shows one holding's curve as another's while the other's is asked for", async () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(deskRow("h-ic")).getByRole("button", { name: "1231_IC" }));
    const first = await payoffOf(screen.getByRole("complementary", { name: /inspector/ }));
    await waitFor(() => expect(first.querySelector("svg")).toBeTruthy());
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    fireEvent.click(within(deskRow("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_C7300" });
    await waitFor(() => expect(within(insp).getByText("drawing…")).toBeTruthy());
    expect(insp.querySelector(".nx-payoff svg")).toBeNull();
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

  it("draws nothing for a spread watched on a greek, whose value is no price, and says why", async () => {
    // a combo's value is the signed sum of the field it WATCHES: on delta it is -0.12, not a credit
    const onDelta = QUOTES.map((q) => (q.id === "w-dec18"
      ? { ...q, field: "option_delta", combo_value: -0.12 } : q) as Entry);
    const insp = await inspect("w-dec18", "1218_P7150", { quotes: onDelta });
    expect(within(insp).getByText(/watches the spread delta, which is no price to draw it at/)).toBeTruthy();
    expect(insp.querySelector(".nx-payoff svg")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("keeps the last curve on screen while a moved value is asked for, marked as updating", async () => {
    const view = render(<DeskBook {...props()} />);
    fireEvent.click(within(deskRow("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    const payoff = await payoffOf(screen.getByRole("complementary", { name: /inspector/ }));
    await waitFor(() => expect(payoff.querySelector("svg")).toBeTruthy());
    // the next answer is held back, as a slow service would
    let release: () => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer("/positions/payoff")) });
    })));
    const moved = QUOTES.map((q) => (q.id === "w-dec18" ? { ...q, combo_value: -2.55 } : q) as Entry);
    view.rerender(<DeskBook {...props({ quotes: moved })} />);
    await waitFor(() => expect(payoff.dataset.updating).toBe(""));
    expect(payoff.querySelector("svg")).toBeTruthy();
    expect(within(payoff).queryByText("drawing…")).toBeNull();
    // the label is the curve's on screen, not the value still being asked for
    expect(within(payoff).getByText(/current value, 2\.40, as the credit/)).toBeTruthy();
    release();
    await waitFor(() => expect(payoff.dataset.updating).toBeUndefined());
    expect(within(payoff).getByText(/current value, 2\.55, as the credit/)).toBeTruthy();
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

describe("a combo drawn in the Watchlist because it names a contract its holding does not hold (#346)", () => {
  const overlap = { quotes: OVERLAP_QUOTES, holdings: OVERLAP_HOLDINGS, monitors: OVERLAP_MONITORS };

  it("is a watched spread in the desk's inspector: its payoff at its value, and not 'on something held'", async () => {
    const insp = await inspect("r-8100", "1231_8100", overlap);
    const payoff = await payoffOf(insp);
    expect(within(payoff).getByText("no Entry: drawn at its current value, 0.60, as the credit")).toBeTruthy();
    expect(insp.textContent).not.toContain("on something held");
    // neither held nor watch only: the note under it says what it shares, and with whom
    expect(within(insp).getByText("2026-12-31 · 38 DTE")).toBeTruthy();
    expect(insp.querySelector("[data-overlap]")!.textContent).toBe("shares C8100 with 1231_8050");
  });

  it("leaves a wing of a held condor a rule on something held, with no payoff of its own", () => {
    render(<DeskBook {...props(overlap)} />);
    fireEvent.click(within(deskRow("r-ic-calls")).getByRole("button", { name: "1231_C7400" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1231_C7400" });
    expect(insp.textContent).toContain("on something held");
    expect(within(insp).queryByRole("group", { name: "payoff at expiry" })).toBeNull();
    expect(insp.querySelector("[data-overlap]")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is a watched spread in the phone's sheet: its payoff at its value, with its note", async () => {
    render(<div className="nx"><PhoneBook {...props(overlap)} /></div>);
    const card = [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === "w-7700")!;
    fireEvent.click(within(card).getByRole("button", { name: /details of 1231_C7700/ }));
    const sheet = await screen.findByRole("dialog");
    const payoff = await payoffOf(sheet);
    expect(within(payoff).getByText(/drawn at its current value, 1\.50, as the credit/)).toBeTruthy();
    expect(sheet.querySelector("[data-overlap]")!.textContent).toBe("contains 1231_7700's C7700");
  });
});
