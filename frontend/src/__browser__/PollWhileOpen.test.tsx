import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { afterEach, describe, expect, it } from "vitest";

import { App, beingOperated } from "../App";

/** Where focus actually goes when a sheet opens — which decides whether the page keeps polling.
 *
 *  jsdom leaves focus on <body> when a sheet opens, so the unit suite cannot answer this at all:
 *  the guard reads document.activeElement, and a real focus trap moves it. Hence a real browser.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
const row = {
  id: "m1", code: "US.SPXW261130C8100000", field: "option_delta", threshold: 0.12,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-30",
  option_type: "CALL", dte: 42, fill: 40, scope: "leg", positions: [], cost_to_close: null,
  entry: null, pnl: null, schedule: null,
  quote: { name: "SPXW 261130 8100.00C", option_delta: 0.11, mid_price: 12.5 },
};

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [row]
          : String(url).endsWith("/monitors") ? []
            : String(url).includes("/positions") ? []
              : health),
    })) as unknown as typeof fetch;
}

afterEach(() => { cleanup(); });
const settle = () => new Promise((r) => setTimeout(r, 250));

describe("what an open sheet does to the poll", () => {
  it("does not hold the poll just by being open", async () => {
    mockApi();
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settle();
    await screen.findByRole("dialog");

    const el = document.activeElement;
    expect(
      beingOperated(el),
      `focus landed on ${el?.tagName}${(el as HTMLElement)?.getAttribute?.("aria-label")
        ? ` [${(el as HTMLElement).getAttribute("aria-label")}]` : ""}, which holds the poll`,
    ).toBe(false);
  });

  it("does not hold the poll with the detail sheet open either", async () => {
    // this sheet re-reads its row from the live list so its figures stay current; a guard that
    // stops the poll while it is open defeats that outright
    mockApi();
    render(<App />);
    await settle();
    fireEvent.click(screen.getByText("261130 8100C"));
    await settle();
    await screen.findByRole("dialog");

    const el = document.activeElement;
    expect(beingOperated(el), `focus landed on ${el?.tagName}`).toBe(false);
  });

  it("holds it for the two surfaces that say they need it, and nothing else", async () => {
    // a focused box is not one of them any more (see PollGuard.test.tsx and Wipe.test.tsx); the
    // column picker is, because the list of offered columns comes from the measured fit
    mockApi();
    render(<App />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settle();
    const sheet = await screen.findByRole("dialog");
    (within(sheet).getByLabelText("flag above") as HTMLElement).focus();
    expect(beingOperated(document.activeElement), "a focused box no longer holds it").toBe(false);

    fireEvent.click(within(sheet).getByRole("button", { name: /close/i }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Single-leg columns" }));
    await settle();
    expect(beingOperated(document.activeElement), "the picker still does").toBe(true);
  });
});
