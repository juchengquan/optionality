/** A holding's forms stand on the holding as they OPENED on it, as the closed trade's correction
 *  does (`ClosedResult.tsx`'s ground), whatever a poll serves while they are open:
 *
 *  - the Close form's hint says when the Cost to close it STARTED at was valued — the Exit is
 *    prefilled once, so a hint that followed the poll named a time the box does not hold;
 *  - the Edit form sends what the owner changed from what it opened with, never the difference from
 *    the holding as served now: another device's edit made meanwhile was otherwise undone by a save
 *    that never touched that field.
 *
 *  And the page as a whole: a render error says so, where a blank page said nothing. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HoldingActions } from "../HoldingActions";
import { PageBoundary } from "../PageBoundary";
import type { Holding } from "../shared/api";
import { fetchedWords } from "../shared/format";
import { holdingService } from "../testing/holdingService";
import { HOLDINGS } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const IC = { ...HOLDINGS.find((h) => h.id === "h-ic")!, cost_to_close: 1.2, fetched_at: "2026-11-12 23:14:05+08:00" };
const writes = { edited: () => {}, closed: () => {}, deleted: () => {} };
const draw = (holding: Holding) =>
  <HoldingActions holding={holding} monitors={[]} rules={[]} privacy={false} writes={writes} />;

describe("the Close form", () => {
  it("says the valuation its Exit started at, not the one a later poll served", () => {
    const { rerender } = render(draw(IC));
    fireEvent.click(screen.getByRole("button", { name: "close…" }));
    const exit = screen.getByLabelText<HTMLInputElement>("exit, per contract");
    const hint = () => document.getElementById(exit.getAttribute("aria-describedby") ?? "")!.textContent;
    expect(exit.value).toBe("1.2");
    expect(hint()).toContain(`as last valued, at ${fetchedWords(IC.fetched_at)}`);
    // a poll: valued again, at another figure and another time
    rerender(draw({ ...IC, cost_to_close: 1.5, fetched_at: "2026-11-12 23:30:00+08:00" }));
    expect(exit.value).toBe("1.2");
    expect(hint()).toContain(`as last valued, at ${fetchedWords(IC.fetched_at)}`);
    // nor, served none since, does it say there was none to start from
    rerender(draw({ ...IC, cost_to_close: null, fetched_at: null }));
    expect(hint()).toContain(`as last valued, at ${fetchedWords(IC.fetched_at)}`);
  });
});

describe("the Edit form", () => {
  it("sends only what was changed in it, never undoing another device's edit made while it was open", async () => {
    const s = holdingService();
    vi.stubGlobal("fetch", s.fetch);
    const { rerender } = render(draw(IC));
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    // another device records the Entry as 5.5 meanwhile, and a poll serves it
    rerender(draw({ ...IC, entry: 5.5 }));
    fireEvent.change(screen.getByLabelText("contracts"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(s.writes().length).toBe(1));
    expect(s.writes()[0]).toEqual({ method: "PATCH", path: "/positions/h-ic", body: { contracts: 3 } });
  });
});

describe("the page", () => {
  it("says it hit an error, rather than going blank", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => { throw new Error("a figure that cannot be drawn"); };
    render(<PageBoundary><Broken /></PageBoundary>);
    const alert = screen.getByRole("alert");
    expect(alert.querySelector("p")!.textContent).toMatch(/^The page hit an error — reload to continue\./);
    expect(alert.querySelector("details code")!.textContent).toBe("a figure that cannot be drawn");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("draws the page itself when nothing throws", async () => {
    render(<PageBoundary><p>the book</p></PageBoundary>);
    await act(async () => {});
    expect(screen.getByText("the book")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
