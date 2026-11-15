/** The payoff at expiry, drawn (#291, ADR 0023): in the desk's inspector and the phone's detail
 *  sheet, for a holding at its Entry and for a watched spread at its current value, with SPX's
 *  derived price as a marker. Behaviour only — what is asked for, what is said, what privacy hides.
 *  That the chart FITS is measured by the browser suite (`NextDesk.test.tsx`,
 *  `NextPhone.iphone.test.tsx` under `__browser__/`). */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftPayoff, Entry, Holding, Payoff } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, volAnswer } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";
import { until } from "../testing/until";
import { legMarks } from "../testing/legs";

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
    session: true, privacy: false, entryStyle: "opportunity", ...over,
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
    expect(within(payoff).getByRole("group", { name: /payoff at expiry by SPX price/ })).toBeTruthy();
    expect(payoff.querySelector("[data-curve]")?.getAttribute("d")).toMatch(/^M/);
    // points per contract, and money across its two contracts at the contract size served (100)
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+5.00 pts per contract · +$1,000");
    expect(within(payoff).getByText("max loss").nextElementSibling?.textContent).toBe("-45.00 pts per contract · -$9,000");
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

  it("hides every $ figure under privacy, and keeps the points per contract, the breakevens and SPX", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC", { privacy: true }));
    const text = payoff.textContent ?? "";
    expect(text).not.toMatch(/\$\d/);
    // points PER CONTRACT say no count; across the contracts held, times 100 they would be the money
    expect(text).not.toMatch(/\b10\.00 pts|-90\.00 pts/);
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+5.00 pts per contract · $•••");
    expect(within(payoff).getByText("max loss").nextElementSibling?.textContent).toBe("-45.00 pts per contract · $•••");
    expect(payoff.querySelector("[data-max='profit']")?.textContent).toBe("max profit +5.00 pts");
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

  it("is drawn with each leg's quantity, as the rule values it (#351)", async () => {
    const ratio = QUOTES.map((q) => (q.id === "w-dec18"
      ? { ...q, legs: q.legs!.map((l, i) => (i === 1 ? { ...l, qty: 2 } : l)) } : q) as Entry);
    render(<DeskBook {...props({ quotes: ratio })} />);
    fireEvent.click(within(deskRow("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain('{"side":"long","option_type":"PUT","strike":7100,"qty":2}');
    // and the inspector writes it beside its side
    expect(screen.getByRole("list", { name: "legs" }).textContent).toContain("long 2× PUT 7100");
    // a watched spread's legs in the inspector, each type marked for its colour (#391)
    expect(legMarks(screen.getByRole("list", { name: "legs" })))
      .toEqual(["short PUT 7150 short PUT", "long 2× PUT 7100 long PUT"]);
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
    expect(within(insp).getByText(/watches the Δ, which is no price to draw it at, and no close is recorded/))
      .toBeTruthy();
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

/** The chart's crosshair readout (#396): the P&L at expiry at any SPX price, by pointer, finger
 *  and keyboard. jsdom lays nothing out, so the chart is drawn at its default 320px and a pointer's
 *  `clientX` is its x across the drawing. */
describe("the crosshair readout (#396)", () => {
  /** A draft's payoff as the service works it out (`payoffAtExpiry`): the corners at the strikes and
   *  the slopes beyond, each leg as many times as its quantity. Breakevens and maximums are not
   *  read by the test that uses it. */
  function draftPayoff(body: DraftPayoff): Payoff {
    const n = body.contracts ?? 1;
    const pnl = (s: number) => n * body.legs.reduce((sum, l) => {
      const worth = (l.option_type === "CALL" ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s)) * (l.qty ?? 1);
      return sum + (l.side === "long" ? worth : -worth);
    }, body.entry);
    const ks = [...new Set(body.legs.map((l) => l.strike))].sort((a, b) => a - b);
    return {
      at_strikes: ks.map((k) => ({ spx: k, pnl: pnl(k) })),
      slope_below: pnl(ks[0]!) - pnl(ks[0]! - 1), slope_above: pnl(ks.at(-1)! + 1) - pnl(ks.at(-1)!),
      breakevens: [], max_profit: null, max_loss: null,
    };
  }

  const chart = (payoff: HTMLElement) => within(payoff).getByRole("group", { name: /payoff at expiry by SPX/ });
  const svg = (payoff: HTMLElement) => payoff.querySelector<SVGSVGElement>(".nx-payoff-chart svg")!;
  /** What is announced: the line beneath the chart, a polite live region. */
  const said = (payoff: HTMLElement) => {
    const line = payoff.querySelector("[data-said]")!;
    expect(line.getAttribute("aria-live")).toBe("polite");
    return line.textContent;
  };
  const HINT = "point at a price, or use the arrow keys, for the P&L at expiry there";
  const tip = (payoff: HTMLElement) => payoff.querySelector("[data-tip]")?.textContent ?? null;
  /** The x of the curve's zero crossing nearest `near`, from the path drawn: where the curve itself
   *  meets the zero line, whatever the labels say. */
  function zeroCrossings(payoff: HTMLElement): number[] {
    const d = payoff.querySelector("[data-curve]")!.getAttribute("d")!;
    const pts = [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const zero = Number(payoff.querySelector("[data-zero]")!.getAttribute("y1"));
    const out: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const [[x0, y0], [x1, y1]] = [pts[i - 1]!, pts[i]!];
      if ((y0 - zero) * (y1 - zero) < 0) out.push(x0 + ((x1 - x0) * (zero - y0)) / (y1 - y0));
    }
    return out;
  }

  it("reads out the P&L at a breakeven a mouse points at: nothing made, nothing lost", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const be = payoff.querySelector<SVGCircleElement>("[data-breakeven='6295'] circle")!;
    fireEvent.pointerMove(svg(payoff), { clientX: Number(be.getAttribute("cx")), clientY: 60, pointerType: "mouse" });
    expect(tip(payoff)).toBe("SPX 6295605.50 below SPX now0.00 pts per contract · $0");
    // a mouse passing over is shown, never announced: the live line speaks for a choice only
    expect(said(payoff)).toBe(HINT);
    expect(payoff.querySelector("[data-crosshair]")).toBeTruthy();
    fireEvent.pointerLeave(svg(payoff), { pointerType: "mouse" });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
    expect(tip(payoff)).toBeNull();
  });

  it("reads out the price between the strikes in points per contract and money across the count", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const k = payoff.querySelector<SVGLineElement>("[data-strike='7400']")!;
    fireEvent.pointerMove(svg(payoff), { clientX: Number(k.getAttribute("x1")), clientY: 60, pointerType: "mouse" });
    expect(tip(payoff)).toBe("SPX 7400499.50 above SPX now+5.00 pts per contract · +$1,000");
    expect(said(payoff)).toBe(HINT);
    // a key chooses, and then it is announced; a mouse passing again goes back to the hint
    fireEvent.keyDown(chart(payoff), { key: "ArrowRight" });
    expect(said(payoff)).toMatch(/^at expiry with SPX at 7405, /);
    fireEvent.pointerMove(svg(payoff), { clientX: Number(k.getAttribute("x1")), clientY: 60, pointerType: "mouse" });
    expect(said(payoff)).toBe(HINT);
  });

  it("steps along SPX with the keys, from SPX's own price, and lets go on Escape", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const keys = chart(payoff);
    expect(keys.tabIndex).toBe(0);
    fireEvent.keyDown(keys, { key: "ArrowRight" });
    expect(said(payoff)).toBe("at expiry with SPX at 6900.50, at SPX now: +5.00 pts per contract · +$1,000");
    fireEvent.keyDown(keys, { key: "End" });
    // past the call wing every point SPX rises costs nothing more: the maximum loss
    expect(said(payoff)).toMatch(/: -45\.00 pts per contract · -\$9,000$/);
    fireEvent.keyDown(keys, { key: "Home" });
    expect(said(payoff)).toMatch(/below SPX now: -45\.00 pts per contract · -\$9,000$/);
    // the arrows stop on a breakeven on the way, so it can be landed on exactly
    let seen = "";
    for (let i = 0; i < 200 && !seen.includes("SPX at 6295,"); i++) {
      fireEvent.keyDown(keys, { key: "ArrowRight" });
      seen = said(payoff) ?? "";
    }
    expect(seen).toContain(": 0.00 pts per contract · $0");
    fireEvent.keyDown(keys, { key: "Escape" });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
  });

  it("hides the $ under privacy and keeps the points, per contract", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC", { privacy: true }));
    fireEvent.keyDown(chart(payoff), { key: "ArrowRight" });
    expect(said(payoff)).toBe("at expiry with SPX at 6900.50, at SPX now: +5.00 pts per contract · $•••");
    expect(tip(payoff)).toContain("+5.00 pts per contract");
    expect(payoff.textContent).not.toMatch(/\$\d/);
    expect(within(payoff).getByText("max profit").nextElementSibling?.textContent).toBe("+5.00 pts per contract · $•••");
  });

  it("chooses a price by a tap, and lets go of it on a second", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const k = Number(payoff.querySelector("[data-strike='6300']")!.getAttribute("x1"));
    fireEvent.pointerDown(svg(payoff), { clientX: k, clientY: 60, pointerType: "touch" });
    // touching down alone chooses nothing: it may be the start of a scroll
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
    fireEvent.click(svg(payoff), { clientX: k, clientY: 60 });
    expect(said(payoff)).toMatch(/^at expiry with SPX at 6300,/);
    fireEvent.pointerDown(svg(payoff), { clientX: k, clientY: 60, pointerType: "touch" });
    fireEvent.click(svg(payoff), { clientX: k, clientY: 60 });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
  });

  it("leaves an Escape with nothing chosen to the page, which closes the inspector", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const keys = chart(payoff);
    fireEvent.keyDown(keys, { key: "ArrowRight" });
    // the first Escape lets go of the price, and is the chart's
    fireEvent.keyDown(keys, { key: "Escape" });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
    expect(screen.getByRole("complementary", { name: "inspector: 1231_IC" })).toBeTruthy();
    // the next one, with nothing chosen, goes on to the page
    fireEvent.keyDown(keys, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull());
  });

  it("scrubs with a finger dragged sideways, and chooses nothing with one dragged up or down", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const xOf = (k: string) => Number(payoff.querySelector(`[data-strike='${k}']`)!.getAttribute("x1"));
    const [k0, k1] = [xOf("6300"), xOf("7400")];
    // a vertical drag is the page's scroll: nothing chosen
    fireEvent.pointerDown(svg(payoff), { clientX: k0, clientY: 40, pointerType: "touch" });
    fireEvent.pointerMove(svg(payoff), { clientX: k0 + 4, clientY: 120, pointerType: "touch" });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
    fireEvent.pointerCancel(svg(payoff), { pointerType: "touch" });
    // a sideways one scrubs: the crosshair follows the finger, and says where it is
    fireEvent.pointerDown(svg(payoff), { clientX: k0, clientY: 60, pointerType: "touch" });
    fireEvent.pointerMove(svg(payoff), { clientX: k0 + 4, clientY: 60, pointerType: "touch" });
    expect(payoff.querySelector("[data-crosshair]")).toBeNull();
    fireEvent.pointerMove(svg(payoff), { clientX: (k0 + k1) / 2, clientY: 62, pointerType: "touch" });
    expect(said(payoff)).toMatch(/^at expiry with SPX at \d+, .*: \+5\.00 pts per contract · \+\$1,000$/);
    fireEvent.pointerMove(svg(payoff), { clientX: k1, clientY: 62, pointerType: "touch" });
    expect(said(payoff)).toMatch(/^at expiry with SPX at 7400, /);
    // lifting the finger keeps the price it reached
    fireEvent.pointerUp(svg(payoff), { pointerType: "touch" });
    fireEvent.click(svg(payoff), { clientX: k1, clientY: 62 });
    expect(said(payoff)).toMatch(/^at expiry with SPX at 7400, /);
  });

  it("labels each breakeven with the domain's figure, drawn where the curve crosses zero", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const marks = [...payoff.querySelectorAll<SVGGElement>("[data-breakeven]")];
    expect(marks.map((m) => Number(m.dataset.breakeven))).toEqual([6295, 7405]);
    expect([...payoff.querySelectorAll("[data-breakeven-label]")].map((t) => t.textContent)).toEqual(["BE 6295", "BE 7405"]);
    const crossings = zeroCrossings(payoff);
    expect(crossings).toHaveLength(2);
    marks.forEach((m, i) => {
      expect(Number(m.querySelector("circle")!.getAttribute("cx"))).toBeCloseTo(crossings[i]!, 0);
    });
  });

  it("states the maximum profit and loss on the chart where they are finite", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    expect(payoff.querySelector("[data-max='profit']")?.textContent).toBe("max profit +$1,000");
    expect(payoff.querySelector("[data-max='loss']")?.textContent).toBe("max loss -$9,000");
  });

  it("names each strike's legs, coloured by type", async () => {
    const payoff = await payoffOf(await inspect("h-ic", "1231_IC"));
    const names = [...payoff.querySelectorAll("[data-strikes]")].map((t) => t.textContent);
    expect(names.join(" ")).toBe("+P6250 −P6300 −C7400 +C7450");
    expect([...payoff.querySelectorAll("[data-strikes] .nx-leg-t")].map((t) => (t as HTMLElement).dataset.type))
      .toEqual(["PUT", "PUT", "CALL", "CALL"]);
  });

  it("reads each leg's quantity, as the service drew it (#351)", async () => {
    // the service's payoff worked from the legs asked for, each as many times as its quantity
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "null")) as DraftPayoff | null;
      asked.push(`${init?.method ?? "GET"} ${String(url).replace(/^.*\/api/, "")}`);
      return Promise.resolve(body
        ? { ok: true, status: 200, json: () => Promise.resolve(draftPayoff(body)) }
        : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
    }));
    // three of the long leg: below both strikes the P&L moves two points for each point SPX does,
    // where a readout that took each leg once would move it none
    const ratio = QUOTES.map((q) => (q.id === "w-dec18"
      ? { ...q, legs: q.legs!.map((l, i) => (i === 1 ? { ...l, qty: 3 } : l)) } : q) as Entry);
    const payoff = await payoffOf(await inspect("w-dec18", "1218_P7150", { quotes: ratio }));
    fireEvent.keyDown(chart(payoff), { key: "Home" });
    const price = Number(/SPX at ([\d.]+)/.exec(said(payoff) ?? "")![1]);
    expect(price).toBeLessThan(7100);
    // short one 7150 put, long THREE 7100 puts, sold for 2.40
    const pnl = 2.4 - (7150 - price) + 3 * (7100 - price);
    expect(said(payoff)).toBe(`at expiry with SPX at ${price}, ${(6900.5 - price).toFixed(2)} below SPX now: +${pnl.toFixed(2)} pts`);
    expect([...payoff.querySelectorAll("[data-strikes]")].map((t) => t.textContent).join(" ")).toBe("+3P7100 −P7150");
  });
});
