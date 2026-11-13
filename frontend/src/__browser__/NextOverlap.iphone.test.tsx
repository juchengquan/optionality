/** A combo that only partly overlaps a holding, on a phone (#346), under Playwright's iPhone
 *  profile: its card is in the Watchlist with a note of what it shares, and the note fits the card
 *  at 390px — wrapped if it must, never pushing the page sideways. In the detail sheet too.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";
import { overflowsSideways, settle } from "./nextBook";

const SAMPLES = {
  levels: { dte_at_open: 58, target: 1, stop: 4, target_dte: 15, manage_by_dte: 21 }, plan: [], samples: [],
};

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** A holding named longer than a card is wide, in one unbroken word, so the note can only fit
 *  at 390px by wrapping — a note that widened its card instead, or was cut, fails below. */
const LONG = "1231_C8050_rolled_from_1218_after_the_CPI_print_then_again_on_the_FOMC_day";
const holdings = OVERLAP_HOLDINGS.map((h) => (h.id === "h-8050" ? { ...h, name: LONG } : h));
const rename = (p: { id: string; name: string }) => (p.id === "h-8050" ? { ...p, name: LONG } : p);
const quotes = OVERLAP_QUOTES.map((q) => ({ ...q, positions: q.positions.map(rename) }));
const monitors = OVERLAP_MONITORS.map((m) => ({ ...m, positions: m.positions.map(rename) }));

function serveOverlap(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET" && !/\/payoff$/.test(String(url))) {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    // REVIEW's samples (#295), a read: none recorded yet, rather than a list that is not one
    if (/\/samples$/.test(path)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLES) });
    }
    const body = path === "/quotes" ? quotes : path === "/monitors" ? monitors
      : path === "/health" ? health : path === "/positions/values" ? holdings : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>("article[data-ref]")].find((el) => el.dataset.ref === ref)!;

function inside(inner: Element, outer: Element): boolean {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
}

afterEach(cleanup);

describe("under the iPhone profile", () => {
  it("draws the partly overlapping combos as Watchlist cards, each note inside its card", async () => {
    serveOverlap();
    render(<Next />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    expect(document.documentElement.clientWidth).toBe(390);
    const watchlist = screen.getByRole("region", { name: "Watchlist" });
    for (const [ref, words] of [["r-8100", `shares C8100 with ${LONG}`], ["w-7700", "contains 1231_7700's C7700"]]) {
      expect(watchlist.contains(card(ref!))).toBe(true);
      const note = card(ref!).querySelector<HTMLElement>("[data-overlap]")!;
      expect(note.textContent).toBe(words);
      expect(note.getBoundingClientRect().height).toBeGreaterThan(0);
      // the long one is said whole, on more than one line
      if (ref === "r-8100") expect(note.getBoundingClientRect().height).toBeGreaterThan(30);
      expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 0.5);
      expect(inside(note, card(ref!))).toBe(true);
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("says it in the detail sheet, inside the sheet", async () => {
    serveOverlap();
    render(<Next />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await settle();
    fireEvent.click(within(card("r-8100")).getByRole("button", { name: /details of 1231_8100/ }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    const note = sheet.querySelector<HTMLElement>("[data-overlap]")!;
    expect(note.textContent).toBe(`shares C8100 with ${LONG}`);
    expect(inside(note, sheet)).toBe(true);
    expect(overflowsSideways()).toBe(false);
  });
});
