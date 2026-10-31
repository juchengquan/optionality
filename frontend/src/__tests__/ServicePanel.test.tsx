/** The Service panel's holdings come from the page, not from a fetch of its own.
 *
 *  It had its own `fetchHoldings`, its own state and its own catch — a second copy of rows the
 *  page already owns, which is the thing `App.loadHoldings` exists to prevent: the picture and
 *  the panel used to disagree for exactly this reason, and "needs you" is the surface where
 *  disagreeing matters most, because it is the only one that names a holding no rule watches.
 *
 *  Its catch was the other half: it fell back to NO holdings and said nothing, so the list that
 *  claims to say where things stand "in full" could be short with no sign that it was.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** a holding no rule watches, at its target: the one need only the holdings can state */
const orphan = {
  id: "p9", name: "1120_BS_7100", entry: 3.1, cost_to_close: 0.9, pnl: 2.2, dte: 30,
  opened_at: "2026-10-01",
  legs: [{ side: "short", option_type: "PUT", strike: 7100 }],
  schedule: {
    dte_at_open: 44, position_id: "p9", on_pace: 1.2, pace_gap: 0.1, target: 1.55, stop: 12.4,
    target_dte: 11, manage_by_dte: 21, reached: "target", manage_by_due: false,
  },
};

let calls: string[] = [];
let holdingsFail = false;

function mockApi(holdings: unknown[]) {
  calls = [];
  holdingsFail = false;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    calls.push(url);
    if (url.includes("/positions/values")) {
      if (holdingsFail) {
        return Promise.resolve(
          { ok: false, status: 502, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(holdings) } as Response);
    }
    const body = url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

const openPanel = async () => {
  await userEvent.click(screen.getByRole("button", { name: "settings" }));
  return await screen.findByRole("dialog", { name: /service/i });
};

beforeEach(() => {
  for (const c of ["ui_cols_single", "ui_cols_combo", "ui_signal", "ui_band", "ui_group"]) {
    document.cookie = `${c}=;path=/;max-age=0`;
  }
});

describe("what needs you, including what no rule watches", () => {
  it("names a holding at its target, which only the holdings can say", async () => {
    mockApi([orphan]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "settings" })).toBeTruthy());

    const panel = await openPanel();
    await waitFor(() =>
      expect(within(panel).getByTestId("needs").textContent).toMatch(/1120_BS_7100 at target/));
  });

  it("shares the rows it asked for with the rest of the page", async () => {
    // one copy. The holdings panel below is drawn from the same state, so the fetch this panel
    // makes on opening must reach it — with a second copy in here, the panel keeps showing the
    // rows from its own earlier fetch and the two surfaces disagree about the same account.
    let rows: unknown[] = [orphan];
    mockApi([]);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      calls.push(url);
      const body = url.includes("/positions/values") ? rows
        : url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "settings" })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /holdings/i }));
    const list = await screen.findByTestId("holdings");
    await waitFor(() => expect(within(list).getByText("1120_BS_7100")).toBeTruthy());

    // a second holding appears in the account, and the Service panel is what asks next
    rows = [orphan, { ...orphan, id: "p8", name: "1211_BS_6800", schedule: null }];
    const panel = await openPanel();
    await waitFor(() =>
      expect(within(panel).getByTestId("needs").textContent).toMatch(/1120_BS_7100/));

    await waitFor(() => expect(within(list).getByText("1211_BS_6800"),
      "the panel that was already open did not see the fetch this one made").toBeTruthy());
  });

  it("says the list may be short when the holdings could not be read", async () => {
    // it fell back to no holdings and said nothing, so a panel that promises "in full" could
    // quietly omit the one need no rule can state — the orphan above
    mockApi([orphan]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "settings" })).toBeTruthy());
    holdingsFail = true;

    const panel = await openPanel();
    await waitFor(() =>
      expect(within(panel).getByTestId("needs").textContent).toMatch(/502/));
    expect(within(panel).getByTestId("needs").textContent)
      .not.toMatch(/nothing needs you/i);
  });
});
