import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** Phase 1 of the shadcn rebuild (ADR 0007): the two add-forms had NO tests, and they hold
 *  nine of the native selects phase 4 replaces. These assert what reaches the server, never
 *  how the form was operated — so when the controls become Base UI popups, only the three
 *  helpers below change and every expectation stands untouched.
 *
 *  If you are here in phase 4 rewriting more than those helpers, the tests were wrong. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};

let posted: { url: string; body: Record<string, unknown> }[] = [];

function mockApi() {
  posted = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    const body = url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

// ── the three interaction helpers phase 4 rewrites ──────────────────────────────
// Everything below the line asserts payloads and should survive the swap untouched.

function type(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

function choose(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

/** A leg row is one <label> wrapping three controls, so it has no usable accessible name
 *  of its own — find it by its leading text and reach inside. */
function setLeg(scope: HTMLElement, n: number, sign: string, type_: string, strike: string) {
  const row = [...scope.querySelectorAll("label")].find(
    (l) => l.textContent?.startsWith(`leg ${n}`),
  )!;
  const selects = row.querySelectorAll("select");
  fireEvent.change(selects[0]!, { target: { value: sign } });
  fireEvent.change(selects[1]!, { target: { value: type_ } });
  fireEvent.change(row.querySelector("input")!, { target: { value: strike } });
}
// ────────────────────────────────────────────────────────────────────────────────

async function forms() {
  mockApi();
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add monitor")).toBeTruthy());
  return {
    monitor: screen.getByRole("group", { name: "Add monitor" }),
    combo: screen.getByRole("group", { name: "Add combo" }),
  };
}

describe("adding a single-leg monitor", () => {
  beforeEach(() => { document.cookie = "ui_cols_single=;path=/"; });

  it("posts the contract, the rule, and numbers as numbers", async () => {
    const { monitor } = await forms();

    type(monitor, "expiry", "2026-10-16");
    choose(monitor, "type", "PUT");
    type(monitor, "strike", "7100");
    choose(monitor, "field", "option_delta");
    type(monitor, "threshold", "-0.25");
    choose(monitor, "direction", "below");
    choose(monitor, "compare", "signed");
    fireEvent.submit(within(monitor).getByRole("button", { name: "watch" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/monitors$/);
    expect(posted[0]!.body).toEqual({
      strike_date: "2026-10-16",
      option_type: "PUT",
      strike: 7100,
      field: "option_delta",
      threshold: -0.25,
      direction: "below",
      compare: "signed",
    });
    // strings here would be accepted by JSON and rejected by the service
    expect(typeof posted[0]!.body.strike).toBe("number");
    expect(typeof posted[0]!.body.threshold).toBe("number");
  });

  it("offers implied volatility, which a single contract does have", async () => {
    const { monitor } = await forms();
    const field = within(monitor).getByLabelText("field", { exact: false });
    expect([...field.querySelectorAll("option")].map((o) => o.textContent))
      .toContain("option_implied_volatility");
  });
});

describe("adding a combo", () => {
  beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

  it("posts legs with the signs the user chose", async () => {
    const { combo } = await forms();

    type(combo, "name", "1016_IC");
    type(combo, "expiry", "2026-10-16");
    setLeg(combo, 1, "-", "CALL", "8050");
    setLeg(combo, 2, "+", "CALL", "8075");
    setLeg(combo, 3, "-", "PUT", "7100");
    setLeg(combo, 4, "+", "PUT", "7075");
    choose(combo, "field", "mid_price");
    type(combo, "threshold", "3.21");
    fireEvent.submit(within(combo).getByRole("button", { name: "watch combo" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({
      name: "1016_IC",
      strike_date: "2026-10-16",
      field: "mid_price",
      threshold: 3.21,
      direction: "above",
      compare: "abs",
      // short the body, long the wings — an iron condor, and the signs are the whole
      // meaning of the combo: reverse them and the value flips
      legs: [
        { sign: -1, option_type: "CALL", strike: 8050 },
        { sign: 1, option_type: "CALL", strike: 8075 },
        { sign: -1, option_type: "PUT", strike: 7100 },
        { sign: 1, option_type: "PUT", strike: 7075 },
      ],
    });
  });

  it("drops the leg rows left blank", async () => {
    const { combo } = await forms();

    type(combo, "name", "1016_bs_8050");
    type(combo, "expiry", "2026-10-16");
    setLeg(combo, 1, "-", "CALL", "8050");
    setLeg(combo, 2, "+", "CALL", "8075");
    // rows 3-6 stay empty; the form always draws six
    type(combo, "threshold", "2.76");
    fireEvent.submit(within(combo).getByRole("button", { name: "watch combo" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body.legs).toHaveLength(2);
  });

  it("never offers implied volatility, which cannot be summed", async () => {
    const { combo } = await forms();
    const field = within(combo).getByLabelText("field", { exact: false });
    const offered = [...field.querySelectorAll("option")].map((o) => o.textContent);
    // CLAUDE.md, combos: "IV is never summed" — two 20% legs are not a 40% combo
    expect(offered).not.toContain("option_implied_volatility");
    expect(offered).toContain("mid_price");
  });
});
