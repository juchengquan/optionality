import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** A delta-watched leg rule: its fill lives on the delta column, which is hideable. */
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: true, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, option_gamma: 0.0007,
              option_theta: -0.9, option_vega: 7.8, option_implied_volatility: 11.3,
              mid_price: 31.5, bid_price: 31.3, ask_price: 31.7 },
};

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  // else every test here renders the skew banner, camouflaging a real one
  contract_version: CONTRACT_VERSION,
};

function mockApi() {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const body = url.endsWith("/quotes") ? [leg] : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

function clearCookies() {
  for (const name of ["ui_cols_single", "ui_cols_combo", "ui_refresh"]) {
    document.cookie = `${name}=;path=/;max-age=0`;
  }
}

/** The whole cell, since --fill and the hl class live in attributes rather than text. */
function filledCell(container: HTMLElement): HTMLElement {
  const cell = container.querySelector("td.hl");
  if (!cell) throw new Error("no filled cell");
  return cell as HTMLElement;
}

// ── the picker interaction, fenced off (phase 3 of ADR 0007) ───────────────────
// <details> keeps its children in the DOM while shut; a popover does not. Every test
// below therefore opens the picker before reaching into it, which is true of both.

async function openPicker(table = "Single-leg"): Promise<HTMLElement> {
  // idempotent on purpose: the trigger TOGGLES, so a test that unticks twice would
  // otherwise shut the picker on its second call and fail looking for a missing list
  const already = screen.queryByRole("group", { name: `${table} columns` });
  if (already) return already;
  await userEvent.click(screen.getByText(`${table} columns`));
  return await screen.findByRole("group", { name: `${table} columns` });
}

async function untick(label: string) {
  const picker = await openPicker();
  // by ROLE, not by label text: the box is a button with role=checkbox now, and the column
  // name it carries is also a table header, so text alone matches more than one thing
  await userEvent.click(within(picker).getByRole("checkbox", { name: label }));
}
// ───────────────────────────────────────────────────────────────────────────────

describe("the fill and bell fallback chain", () => {
  beforeEach(() => { clearCookies(); mockApi(); });

  it("normally sits on the column the alarm watches", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("td.hl")).toBeTruthy());
    const cell = filledCell(container);
    expect(cell.textContent).toBe("0.1685"); // delta
    expect(cell.style.getPropertyValue("--fill")).toBe("84%");
  });

  it("moves to the alarm cell when that column is hidden", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("td.hl")).toBeTruthy());
    await untick("delta");
    await waitFor(() => expect(filledCell(container).textContent).toContain("delta ≥ 0.2"));
    // urgency must survive the column that carried it being hidden
    expect(filledCell(container).style.getPropertyValue("--fill")).toBe("84%");
  });

  it("ends on the contract when the alarm is hidden too, taking the bell with it", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("td.hl")).toBeTruthy());
    await untick("delta");
    await untick("alarm");
    await waitFor(() => expect(filledCell(container).textContent).toContain("SPXW 261120"));
    // contract is protected, so the chain always terminates somewhere visible
    const cell = filledCell(container);
    expect(cell.style.getPropertyValue("--fill")).toBe("84%");
    expect(cell.textContent).toContain("🔔");
  });

  it("never offers to hide the columns that identify or operate a row", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Single-leg columns")).toBeTruthy());
    const picker = await openPicker();
    expect(within(picker).queryByRole("checkbox", { name: "contract" })).toBeNull();
    expect(within(picker).queryByRole("checkbox", { name: "actions" })).toBeNull();
  });
});

describe("column preferences", () => {
  beforeEach(() => { clearCookies(); mockApi(); });

  it("stores what is HIDDEN, so a column added later is not invisible", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Single-leg columns")).toBeTruthy());
    await untick("gamma");
    // "." separates: a comma makes the cookie value quote-escaped and it stops round-tripping
    await waitFor(() => expect(document.cookie).toContain("ui_cols_single=gamma"));
    expect(document.cookie).not.toContain("ui_cols_single=contract");
  });

  it("reads the cookie /ui writes, so both dashboards agree", async () => {
    document.cookie = "ui_cols_single=gamma.vega;path=/";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("table")).toBeTruthy());
    const headers = [...container.querySelectorAll("th")].map((h) => h.textContent);
    expect(headers).not.toContain("gamma");
    expect(headers).not.toContain("vega");
    expect(headers).toContain("delta");
  });

  it("show all puts every column back in one action", async () => {
    document.cookie = "ui_cols_single=gamma.vega.bid.ask;path=/";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("table")).toBeTruthy());
    const picker = await openPicker();
    await userEvent.click(within(picker).getByText("show all"));
    await waitFor(() =>
      expect([...container.querySelectorAll("th")].map((h) => h.textContent)).toContain("gamma"),
    );
  });
});

describe("the picker as a control", () => {
  beforeEach(() => { clearCookies(); mockApi(); });

  it("closes on Escape, which the <details> it replaced could not do", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Single-leg columns")).toBeTruthy());

    const picker = await openPicker();
    expect(picker).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Single-leg columns" })).toBeNull());
  });

  it("keeps the two tables' pickers independent", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Combos columns")).toBeTruthy());

    await openPicker("Combos");
    // opening one must not open or disturb the other; they store separate cookies
    expect(screen.queryByRole("group", { name: "Single-leg columns" })).toBeNull();
  });
});
