import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { marketDay } from "../format";

/** The trading-day offer, measured. It names a full ISO date — "trading day: 2026-10-19", 23
 *  characters — inside a field 44 units wide in the sheet, and it went into four forms at once.
 *  jsdom reports every box as zero wide, so a control that spills out of its field or past the
 *  phone's gutter is exactly what a green unit suite says nothing about (and the record form is
 *  reached on a phone, in the morning, which is when the date matters).
 */
const health = {
  db: true, opend: true,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
const combo = {
  id: "c1", code: "1130_8100", field: "mid_price", threshold: 2.49, direction: "above",
  compare: "abs", triggered: false, strike_date: "2026-11-30", option_type: "CMB",
  dte: 41, fill: 94, scope: null, positions: [], cost_to_close: null, schedule: null,
  entry: null, pnl: null, quote: null, combo_value: -4.6, combo_greeks: {},
  legs: [{ sign: -1, option_type: "CALL", strike: 8100 }, { sign: 1, option_type: "CALL", strike: 8150 }],
};

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [combo]
          : String(url).endsWith("/monitors") ? [{ ...combo, strike: 0, enabled: true }]
            : String(url).includes("/positions") ? [] : health),
    })) as unknown as typeof fetch;
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("the trading-day offer, measured", () => {
  it("fits its own field in the record sheet on a phone", async () => {
    await page.viewport(390, 900);
    mockApi();
    render(<App />);
    await new Promise((r) => setTimeout(r, 160));
    await userEvent.click(screen.getByText("1130_8100"));
    const sheet = await screen.findByRole("dialog");
    await new Promise((r) => setTimeout(r, 160));

    const offer = [...sheet.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("trading day"))!;
    expect(offer, "the offer is not in the sheet at all").toBeTruthy();
    const r = offer.getBoundingClientRect();
    expect(r.width, "the offer has no width").toBeGreaterThan(0);
    // the date is the whole point of the control: a clipped one reads as a different day
    expect(Math.round(r.right), `${Math.round(r.right)} past the 390px screen`)
      .toBeLessThanOrEqual(390);
    const box = sheet.querySelector<HTMLElement>('input[type="date"]')!;
    expect(Math.round(r.left)).toBeGreaterThanOrEqual(Math.round(box.getBoundingClientRect().left) - 1);
  });

  it("fills the date box it sits under", async () => {
    // the click, for real: the whole control exists so one tap cannot pick the wrong calendar
    await page.viewport(390, 900);
    mockApi();
    render(<App />);
    await new Promise((r) => setTimeout(r, 160));
    await userEvent.click(screen.getByText("1130_8100"));
    const sheet = await screen.findByRole("dialog");
    await new Promise((r) => setTimeout(r, 160));

    const offer = [...sheet.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("trading day"))!;
    await userEvent.click(offer);

    const box = sheet.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(box.value).toBe(marketDay());
  });
});
