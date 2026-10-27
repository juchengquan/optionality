import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { OpenedField } from "../OpenedField";
import { marketDay } from "../format";

/** Opened is a TRADING day, and nothing on screen said so.
 *
 *  `position_samples.observed_on` is keyed to the New York calendar (`marketDate`,
 *  backend/src/domain/expiry.ts) and `volAttribution` returns null unless the FIRST sample's
 *  market day equals the holding's `opened_at` — "the baseline is the vol you SOLD". Singapore
 *  runs 12 hours ahead, so through the whole SGT morning, which is exactly when a trade gets
 *  recorded after the 04:00 close, the local date is a day ahead of the trading day.
 *
 *  On 2026-10-20 that cost the 1130 spread its vol figure: recorded with opened_at 2026-10-20
 *  while its first sample was 2026-10-19, so /vol answered null where the comparable holding
 *  answered -0.41. Four separate date inputs set this field and every one of them offered the
 *  local calendar with nothing to say which one it meant.
 */
describe("the trading day", () => {
  it("is New York's date, not the local one, through the Singapore morning", () => {
    // 09:20 in Singapore on the 20th: 21:20 on the 19th in New York, and no session has
    // happened on the 20th at all — which is what made that date impossible as a fill date
    expect(marketDay(new Date("2026-10-20T01:20:00Z"))).toBe("2026-10-19");
  });

  it("rolls when New York's does, not when Singapore's does", () => {
    // 21:00 SGT on the 20th is 09:00 in New York, half an hour before the open
    expect(marketDay(new Date("2026-10-20T13:00:00Z"))).toBe("2026-10-20");
  });
});

describe("the Opened field", () => {
  it("starts blank, because a date nobody chose is the guess ADR 0011 refuses", () => {
    render(<OpenedField id="t-opened" value="" onChange={() => {}} now={new Date("2026-10-20T01:20:00Z")} />);

    expect((screen.getByLabelText("opened") as HTMLInputElement).value).toBe("");
  });

  it("offers the trading day by name, so the one tap cannot pick the wrong calendar", async () => {
    const onChange = vi.fn();
    render(<OpenedField id="t-opened" value="" onChange={onChange} now={new Date("2026-10-20T01:20:00Z")} />);

    await userEvent.click(screen.getByRole("button", { name: /2026-10-19/ }));

    expect(onChange).toHaveBeenCalledWith("2026-10-19");
  });

  it("still lets any other day be typed — a trade recorded late was opened earlier", async () => {
    const onChange = vi.fn();
    render(<OpenedField id="t-opened" value="" onChange={onChange} now={new Date("2026-10-20T01:20:00Z")} />);

    await userEvent.type(screen.getByLabelText("opened"), "2026-10-14");

    expect(onChange).toHaveBeenLastCalledWith("2026-10-14");
  });
});

const health = {
  db: true, provider: { name: "moomoo", ok: true },
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
const rule = {
  ...combo, strike: 0, enabled: true, disabled_reason: null, last_value: -4.6,
  last_checked_at: "x", created_at: "x",
};

let sent: { method: string; body: Record<string, unknown> }[] = [];
function mockApi() {
  sent = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({ method, body: JSON.parse((init?.body as string) ?? "{}") });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "p1" }) } as Response);
    }
    const body = url.endsWith("/quotes") ? [combo]
      : url.endsWith("/monitors") ? [rule] : url.includes("/positions") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

describe("recording a holding on the trading day", () => {
  it("sends the day the button named, through the form that records it", async () => {
    // end to end, because the field is one of four and the record form is the one that
    // brought a holding into being with the wrong date
    mockApi();
    render(<App />);
    await waitFor(() => expect(screen.getByText("1130_8100")).toBeTruthy());
    await userEvent.click(screen.getByText("1130_8100"));
    const sheet = await screen.findByRole("dialog");

    const offered = within(sheet).getByRole("button", { name: new RegExp(marketDay()) });
    await userEvent.click(offered);
    await userEvent.click(within(sheet).getByRole("button", { name: "record" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body.opened_at).toBe(marketDay());
  });
});

/** Every form that sets Opened, not just the one that was caught. Four date inputs set this
 *  field — the record sheet above, a holding's own row, and both add forms — and the wrong
 *  calendar is available from any of them. The two creation paths are checked here because they
 *  are where a holding comes into being with the date it will keep. */
describe("every form that sets Opened", () => {
  for (const which of ["monitor", "combo"] as const) {
    it(`offers the trading day in the add-${which} form`, async () => {
      mockApi();
      render(<App />);
      const trigger = `add ${which}`;
      await waitFor(() => expect(screen.getByRole("button", { name: trigger })).toBeTruthy());
      await userEvent.click(screen.getByRole("button", { name: trigger }));
      const form = await screen.findByRole("dialog");

      expect(within(form).getByRole("button", { name: new RegExp(marketDay()) })).toBeTruthy();
    });
  }
});
