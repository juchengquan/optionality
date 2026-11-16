/** One failed valuation is a stale figure, never a lost form: a poll whose `/positions/values` fails
 *  takes the holdings out of the book (their figures are nobody's to vouch for), but the holding the
 *  owner has open — in the desk's inspector or the phone's sheet — stays open on its last valued
 *  figures, said as such, with whatever was half typed into its Edit, Close or Delete. Only a
 *  SUCCESSFUL answer without it closes it: a close here, or one made elsewhere. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import type { Holding } from "../shared/api";
import { holdingService, type HoldingService } from "../testing/holdingService";
import { HOLDINGS } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

/** 12:00 New York on a Thursday: in session, so the poll asks for the valuation */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); await drain(); };

async function openHolding(arrangement: "desk" | "phone", holdings?: Holding[]): Promise<{ s: HoldingService; open: () => HTMLElement }> {
  const s = holdingService(holdings ? { holdings } : {});
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: IN_SESSION });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  vi.stubGlobal("fetch", s.fetch);
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
  await drain();
  if (arrangement === "desk") {
    fireEvent.click(document.querySelector<HTMLElement>('.nxd-row[data-ref="h-ic"] .nxd-name')!);
    return { s, open: () => screen.getByRole("complementary", { name: /^inspector:/ }) };
  }
  fireEvent.click(within(document.querySelector<HTMLElement>('article[data-ref="h-ic"]')!).getAllByRole("button")[0]!);
  await screen.findByRole("dialog");
  return { s, open: () => screen.getByRole("dialog") };
}

const exitBox = () => screen.getByRole("form", { name: "close 1231_IC" }).querySelector<HTMLInputElement>(
  'input[aria-label="exit, per contract"]')!;

describe.each(["desk", "phone"] as const)("%s: a failed valuation", (arrangement) => {
  it("keeps the open holding and its half-typed Close form, on its last valued figures", async () => {
    const { s, open } = await openHolding(arrangement);
    fireEvent.click(within(open()).getByRole("button", { name: "close…" }));
    fireEvent.change(exitBox(), { target: { value: "0.85" } });
    // the owner reads something else: the focus leaves the form, so the poll is not held
    (document.activeElement as HTMLElement | null)?.blur();
    const asked = s.sent.filter((x) => x.path === "/positions/values").length;

    s.refuse.set("GET /positions/values", { status: 502, detail: "moomoo call failed" });
    await tick();
    expect(s.sent.filter((x) => x.path === "/positions/values").length).toBe(asked + 1);
    // out of the book, said so — and still open, its figures said to be the last valued ones
    expect(screen.getAllByText(/the holdings could not be valued/).length).toBeGreaterThan(0);
    expect(open().dataset.stale).toBe("");
    expect(exitBox().value).toBe("0.85");

    s.refuse.delete("GET /positions/values");
    await tick();
    expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull();
    expect(open().dataset.stale).toBeUndefined();
    expect(exitBox().value).toBe("0.85");
  });

  it("says so at the top, before its figures, and its Level as the valuation it is from", async () => {
    // valued at 11:59 New York, at its target
    const level = HOLDINGS.map((h) => (h.id !== "h-ic" ? h : {
      ...h, fetched_at: "2026-11-13 00:59:00+08:00",
      schedule: { on_pace: 1.5, pace_gap: 0.3, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21,
        reached: "target", manage_by_due: false, dte_at_open: 45 },
    } as Holding));
    const { s, open } = await openHolding(arrangement, level);
    (document.activeElement as HTMLElement | null)?.blur();
    // live, in session: no word of staleness, and the Level bare
    expect(open().textContent).not.toMatch(/could not be valued since/);
    expect(open().textContent).not.toMatch(/as valued at/);
    s.refuse.set("GET /positions/values", { status: 502, detail: "moomoo call failed" });
    await tick();
    const stale = within(open()).getByText("as last valued — the holdings could not be valued since");
    // before the figures, not after them
    const figures = open().querySelector(".nxd-kv, .nxp-hero")!;
    expect(stale.compareDocumentPosition(figures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(open().textContent).toMatch(/as valued at/);
    // nor does it go on saying it updates with every poll
    expect(open().textContent).not.toMatch(/live: updates with every poll/);
  });

  it("never keeps a holding closed here, when the valuation after the close fails", async () => {
    const { s, open } = await openHolding(arrangement);
    fireEvent.click(within(open()).getByRole("button", { name: "close…" }));
    fireEvent.change(exitBox(), { target: { value: "0.85" } });
    s.refuse.set("GET /positions/values", { status: 502, detail: "moomoo call failed" });
    fireEvent.click(within(screen.getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "close it" }));
    await screen.findByRole("region", { name: "closed 1231_IC" });
    await drain();
    expect(screen.queryByRole("form", { name: "close 1231_IC" })).toBeNull();
    if (arrangement === "desk") expect(screen.queryByRole("complementary", { name: /^inspector:/ })).toBeNull();
    else await waitFor(() => expect(screen.queryByRole("dialog", { name: "1231_IC" })).toBeNull());
  });

  it("still closes on a successful answer without it: closed elsewhere, it is gone", async () => {
    const { s, open } = await openHolding(arrangement);
    expect(open()).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    s.refuse.set("GET /positions/values", { status: 502, detail: "moomoo call failed" });
    await tick();
    expect(open()).toBeTruthy();
    // another device closed it meanwhile: the next answer, a success, has it no longer
    s.refuse.delete("GET /positions/values");
    s.stored.get("h-ic")!.closed_on = "2026-11-12";
    await tick();
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).toBeNull());
    if (arrangement === "desk") expect(screen.queryByRole("complementary", { name: /^inspector:/ })).toBeNull();
    else await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
