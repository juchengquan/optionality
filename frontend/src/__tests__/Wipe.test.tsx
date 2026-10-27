import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../App";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
const row = (threshold: number) => ({
  id: "m1", code: "US.SPXW261130C8100000", field: "option_delta", threshold,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-30",
  option_type: "CALL", dte: 42, fill: 40, scope: "leg", positions: [], cost_to_close: null,
  entry: null, pnl: null, schedule: null,
  quote: { name: "SPXW 261130 8100.00C", option_delta: 0.11, mid_price: 12.5 },
});
let threshold = 0.12;
function mockApi() {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/quotes") ? [row(threshold)]
          : url.endsWith("/monitors") ? [] : url.includes("/positions") ? [] : health),
    } as Response)));
}

describe("does a reload wipe a half-typed box?", () => {
  it("keeps what is typed when the rows are replaced underneath", async () => {
    threshold = 0.12;
    mockApi();
    render(<App />);
    await waitFor(() => expect(screen.getByText("261130 8100C")).toBeTruthy());
    fireEvent.click(screen.getByText("261130 8100C"));
    const sheet = await screen.findByRole("dialog");
    const box = within(sheet).getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(box, { target: { value: "0.9" } });
    expect(box.value).toBe("0.9");

    // the manual refresh consults no guard by design ("a click is not something done to you"),
    // so this is the reload landing mid-edit — and the service answers with a changed threshold
    threshold = 0.5;
    // queried from the DOM, not the a11y tree: with a sheet open the page behind it is
    // aria-hidden, so the button exists but getByRole cannot see it — which is itself why the
    // manual refresh is no way out of a suppressed poll
    fireEvent.click(document.querySelector('[aria-label="refresh now"]')!);
    await waitFor(() => expect(screen.getAllByText(/0\.5/).length).toBeGreaterThan(0));

    expect(box.value, "the typed value survived").toBe("0.9");
  });
});
