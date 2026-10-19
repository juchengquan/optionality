import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

/** Recording a holding against a rule.
 *
 *  2026-10-19: the owner recorded the 11-30 spread three times and no row appeared. The service's
 *  log, once it could speak, showed it had refused NOTHING — the request never left the browser.
 *  This form's submit read `if (value === null) return`, so pressing "record" with the entry box
 *  empty did nothing at all: no request, no message, no toast. Four of the five number fields that
 *  gate a submit in this app say `required`; this one did not.
 */
const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const combo = {
  id: "c1", code: "1130_BS_6950", field: "mid_price", threshold: 2.49,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-30",
  dte: 42, fill: 94, scope: null, positions: [], cost_to_close: null, schedule: null,
  entry: null, pnl: null, quote: null,
  legs: [{ sign: -1, option_type: "PUT", strike: 6950 }, { sign: 1, option_type: "PUT", strike: 6900 }],
  combo_value: -2.35, combo_greeks: {},
};

/** The same rule as a /monitors row. App resolves it by id to derive a holding's legs and sides,
 *  because a watchlist row carries no option_type or strike of its own. */
const rule = {
  id: "c1", code: "1130_BS_6950", strike_date: "2026-11-30", option_type: "CMB", strike: 0,
  field: "mid_price", threshold: 2.49, direction: "above", compare: "abs",
  legs: [{ sign: -1, option_type: "PUT", strike: 6950 }, { sign: 1, option_type: "PUT", strike: 6900 }],
  enabled: true, scope: null, positions: [], disabled_reason: null, triggered: false,
  last_value: -2.35, last_checked_at: "x", created_at: "x",
};

let sent: { method: string; body: unknown }[] = [];
function mockApi() {
  sent = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({ method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "p1" }) } as Response);
    }
    const body = url.endsWith("/quotes") ? [combo]
      : url.endsWith("/monitors") ? [rule]
        : url.includes("/positions") ? []
          : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

async function openRecordForm() {
  render(<App />);
  await waitFor(() => expect(screen.getByText("1130_BS_6950")).toBeTruthy());
  await userEvent.click(screen.getByText("1130_BS_6950"));
  return await screen.findByRole("dialog");
}

describe("recording a holding against a rule", () => {
  beforeEach(() => {
    document.cookie = "ui_cols_single=;path=/";
    document.cookie = "ui_cols_combo=;path=/";
  });

  it("sends the credit that was typed", async () => {
    mockApi();
    const sheet = await openRecordForm();
    await userEvent.type(within(sheet).getByLabelText("entry"), "2.35");
    await userEvent.click(within(sheet).getByRole("button", { name: "record" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe("POST");
    expect((sent[0]!.body as { entry: number }).entry).toBe(2.35);
  });

  it("records a holding given only the day it was opened", async () => {
    // the API takes a Position with a null entry — "P&L then reads unknown rather than inventing
    // one" — and the holdings list's own edit form already patches whatever was filled in
    mockApi();
    const sheet = await openRecordForm();
    await userEvent.type(within(sheet).getByLabelText("opened"), "2026-10-06");
    await userEvent.click(within(sheet).getByRole("button", { name: "record" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]!.body as { opened_at: string }).opened_at).toBe("2026-10-06");
  });

  it("says why, rather than doing nothing, when both boxes are empty", async () => {
    // the whole defect: a button that answers a press with silence is indistinguishable from one
    // that is broken, and three attempts went that way before the service log proved the request
    // had never been sent
    mockApi();
    const sheet = await openRecordForm();
    await userEvent.click(within(sheet).getByRole("button", { name: "record" }));

    expect(sent, "nothing is sent, which is right").toHaveLength(0);
    expect(
      within(sheet).getByText(/entry or the day/i),
      "but the form says so",
    ).toBeTruthy();
  });
});
