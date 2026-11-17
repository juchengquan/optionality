/** One number format across the page (ADR 0023, the owner's standard of 2026-11-16): no figure is
 *  written with a hyphen-minus for its sign — not a point, a greek, a dollar amount, a percentage
 *  or a short leg — wherever it is drawn: the desk's table and every inspector, the phone's cards
 *  and every sheet, and the saved view's text. The book has a negative in every kind of figure.
 *
 *  A hyphen inside a word or a date (`2026-12-31`, a holding named `1218-6800`) is not a sign and
 *  is left alone: the guard is a hyphen-minus with no letter or digit before it, before a digit, a
 *  `$`, a point or a leg (`-C8050`).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Holding } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { Still } from "../snapshot/Still";
import { hyphenSigns, saidBy } from "../testing/hyphens";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer, watchSamplesAnswer } from "../testing/ownerBook";
import { heldOrNot } from "../testing/held";
import { bareName } from "../testing/held";

/** The owner's book with a negative in every figure a holding has: its greeks, its pace gap (ahead,
 *  so negative) and a gamma too small for its places. */
const BOOK: Holding[] = HOLDINGS.map((h) => ({
  ...h,
  greeks: { option_delta: -0.0204, option_gamma: -0.00004, option_theta: -0.11, option_vega: -0.79 },
  // a share captured below nothing: a loss bigger than the credit's decay
  captured: -0.12,
  schedule: { dte_at_open: 45, on_pace: 4.48, pace_gap: -1.53, target: 2.36, stop: 9.44, target_dte: 11,
    manage_by_dte: 21, reached: null, manage_by_due: false },
}));
/** and a single contract with every figure, two of them negative */
const QUOTED = QUOTES.map((q) => q.id === "w-dec18-delta" ? {
  ...q, quote: { name: "SPXW 261218 7150.00P", option_delta: -0.17, option_gamma: 0.0002, option_theta: -1.35,
    option_vega: 3.38, option_implied_volatility: 27.17, bid_price: 23.1, ask_price: 23.6, mid_price: 23.35,
    last_price: 25.3, update_time: "2026-11-16 13:22:02" },
} : q);

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTED, monitors: MONITORS, holdings: BOOK, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

let inner: typeof fetch;
beforeEach(() => {
  inner = window.fetch;
  window.fetch = ((url: string) => {
    const path = String(url).replace(/^.*\/api/, "").replace(/\?.*$/, "");
    const body = payoffAnswer(path) ?? volAnswer(path) ?? samplesAnswer(path) ?? watchSamplesAnswer(path) ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); window.fetch = inner; });

/** Turns the event loop until the payoff and the history have answered and drawn. */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5)); });

describe("no figure signed with a hyphen-minus (the owner, 2026-11-16)", () => {
  it("finds one where there is one — the guard is not blind", () => {
    expect(hyphenSigns("max loss -$4,528 · -45.28 · -C8050 · 1218-6800 · 2026-12-31 · −2.95")).toEqual([
      "max loss -$4,528 · -4", "max loss -$4,528 · -45.28 · -C8", "loss -$4,528 · -45.28 · -C8050 · 121",
    ]);
    // a stored name the add form derived is data, written as stored (add.ts \`derivedName\`)
    expect(hyphenSigns("1231_-C8050+C8100 · Δ-0.020 · (-0.5)")).toEqual(["1231_-C8050+C8100 · Δ-0.020 · (-0", "8050+C8100 · Δ-0.020 · (-0.5)"]);
  });

  it.each([true, false])("on the desk: the table and every inspector, in session %s (its history open outside it)", async (session) => {
    render(<DeskBook {...props({ session })} />);
    const said: string[] = hyphenSigns(saidBy(document.body));
    const names = [...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].map(bareName);
    let charts = 0;
    for (const name of names) {
      fireEvent.click(screen.getAllByRole("button", { name: heldOrNot(name) }).find((b) => b.classList.contains("nxd-name"))!);
      await settle();
      const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
      charts += insp.querySelectorAll(".nx-hist-chart, .nx-payoff svg").length;
      said.push(...hyphenSigns(saidBy(insp)).map((s) => `${name}: ${s}`));
    }
    expect(names.length).toBeGreaterThan(8);
    // worth nothing unless the payoffs, and outside the session the histories, were drawn and read
    expect(charts).toBeGreaterThan(session ? 3 : 6);
    expect(said).toEqual([]);
  });

  it.each([true, false])("on the phone: the cards and every sheet, in session %s", async (session) => {
    render(<div className="nx"><PhoneBook {...props({ session })} /></div>);
    const said: string[] = hyphenSigns(saidBy(document.body));
    const opens = [...document.querySelectorAll<HTMLButtonElement>(".nxp-open")].map((b) => b.getAttribute("aria-label")!);
    for (const label of opens) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await settle();
      const sheet = screen.getByRole("dialog");
      said.push(...hyphenSigns(saidBy(sheet)).map((s) => `${label}: ${s}`));
      fireEvent.click(within(sheet).getAllByRole("button").find((b) => /close/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))!);
      await settle();
    }
    expect(opens.length).toBeGreaterThan(5);
    expect(said).toEqual([]);
  });

  // NOT Copy as text: it writes a figure's minus as the hyphen on purpose, so a spreadsheet reads
  // the cell as a number (the owner, 2026-11-16; MARKDOWN_FIGURE_MINUS and NextPlainView's test)
  it("in the saved picture", () => {
    render(<Still {...props()} needs={[]} health={null} polledAt={null} error={null} references={[]}
                  hidden={new Set()} takenAt={new Date("2026-11-16T15:00:00Z")} />);
    const text = document.querySelector(".nx-still")!.textContent!;
    expect(text).toMatch(/\u2212/);
    expect(hyphenSigns(text)).toEqual([]);
  });
});
