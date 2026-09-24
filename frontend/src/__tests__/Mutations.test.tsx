import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Submit the form the given control belongs to. Indexing getAllByText("set") is
 *  fragile: entry sits BEFORE actions in the combo column order. */
function submitFormOf(control: HTMLElement) {
  fireEvent.submit(control.closest("form")!);
}
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

const wing = {
  id: "m1", code: "1016_bs_8050", field: "mid_price", threshold: 2.76,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-10-16",
  dte: 22, fill: 29, scope: "all",
  positions: [{ id: "p1", name: "1016_bs_8050" }],
  cost_to_close: 0.8, entry: 2.87, pnl: 207, snapshot: null,
  legs: [{ sign: -1, option_type: "CALL", strike: 8050 }, { sign: 1, option_type: "CALL", strike: 8075 }],
  combo_value: -0.8, combo_greeks: {},
};
const spanning = {
  ...wing, id: "m2", code: "1016_IC", threshold: 3.21, entry: null, pnl: null,
  positions: [{ id: "p1", name: "1016_bs_8050" }, { id: "p2", name: "1016_IC_puts" }],
};
const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  // without this every test here renders the version-skew banner, which would
  // camouflage a real one
  contract_version: CONTRACT_VERSION,
};

let calls: { url: string; method: string; body: unknown }[] = [];

function mockApi(quotes: unknown[], failWith?: string) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (failWith) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ detail: failWith }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    const body = url.endsWith("/quotes") ? quotes : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

describe("mutations", () => {
  beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

  it("sets a threshold through the JSON API", async () => {
    mockApi([wing]);
    render(<App />);
    await waitFor(() => expect(screen.getByDisplayValue("2.76")).toBeTruthy());
    const threshold = screen.getByDisplayValue("2.76");
    fireEvent.change(threshold, { target: { value: "3.00" } });
    submitFormOf(threshold);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("/monitors/m1");
    expect(patch.body).toEqual({ threshold: 3 });
  });

  it("types an entry onto the one holding a rule watches", async () => {
    mockApi([wing]);
    render(<App />);
    await waitFor(() => expect(screen.getByDisplayValue("2.87")).toBeTruthy());
    const entry = screen.getByDisplayValue("2.87");
    fireEvent.change(entry, { target: { value: "3.00" } });
    submitFormOf(entry);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions/p1"))).toBe(true));
    expect(calls.find((c) => c.url.includes("/positions/p1"))!.body).toEqual({ entry: 3 });
  });

  it("sends a TOTAL for a rule spanning two holdings, never a per-wing entry", async () => {
    mockApi([spanning]);
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("total")).toBeTruthy());
    const total = screen.getByPlaceholderText("total");
    fireEvent.change(total, { target: { value: "3.21" } });
    submitFormOf(total);
    await waitFor(() => expect(calls.some((c) => c.url.includes("total-entry"))).toBe(true));
    const call = calls.find((c) => c.url.includes("total-entry"))!;
    expect(call.url).toContain("/monitors/m2/");
    expect(call.body).toEqual({ entry: 3.21 });
    // a summed credit must never be written onto a wing directly
    expect(calls.some((c) => c.url.includes("/positions/"))).toBe(false);
  });

  it("shows the service's own words when it refuses", async () => {
    mockApi([spanning], "cannot split a total across 2 wings that have no rule of their own");
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("total")).toBeTruthy());
    const totalBox = screen.getByPlaceholderText("total");
    fireEvent.change(totalBox, { target: { value: "3.21" } });
    submitFormOf(totalBox);
    await waitFor(() => expect(screen.getByText(/cannot split a total/)).toBeTruthy());
  });

  it("mutes without asking — it is reversible", async () => {
    mockApi([wing]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("mute")).toBeTruthy());
    fireEvent.click(screen.getByText("mute"));
    await waitFor(() => expect(calls.some((c) => c.body && "enabled" in (c.body as object))).toBe(true));
  });

  it("says a refusal once, in a toast, not in the standing banner", async () => {
    mockApi([spanning], "cannot split a total across two unpriced wings");
    render(<App />);
    await waitFor(() => expect(screen.getAllByPlaceholderText("total")[0]).toBeTruthy());
    const box = screen.getAllByPlaceholderText("total")[0]!;
    fireEvent.change(box, { target: { value: "3.21" } });
    submitFormOf(box);

    // the service's own words, because it explains itself better than a status code
    await waitFor(() => expect(screen.getByText(/cannot split a total/)).toBeTruthy());
    // but NOT in the banner: a refusal is an event, and the banner is for conditions.
    // Left there it outlives its moment and is still on screen a minute later.
    expect(document.querySelector(".banner")).toBeNull();
  });

  it("keeps an unreachable service in the banner, because that one is a condition", async () => {
    // the poll failing is not an event you caused — it means every figure on screen is
    // stale, which stays true until it stops being true. That belongs in the banner.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("service unreachable"))));
    render(<App />);

    await waitFor(() => expect(document.querySelector(".banner")?.textContent)
      .toMatch(/unreachable/));
    // and the dashboard still renders around it rather than showing nothing
    expect(screen.getByText("optionality watchlist")).toBeTruthy();
  });

  it("asks before deleting, and does nothing if you decline", async () => {
    mockApi([wing]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("delete")).toBeTruthy());

    await userEvent.click(screen.getByText("delete"));
    const dialog = await screen.findByRole("alertdialog");
    // it names what is about to go, so the question can be answered without guessing
    expect(within(dialog).getByText(/1016_bs_8050/)).toBeTruthy();
    // and nothing has reached the server — the click opened a question, not a deletion
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes once confirmed", async () => {
    mockApi([wing]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("delete")).toBeTruthy());

    await userEvent.click(screen.getByText("delete"));
    // scoped to the dialog on purpose: finding "delete" anywhere on the page would match
    // the row's own button and pass without a confirmation existing at all
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(within(dialog).getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
