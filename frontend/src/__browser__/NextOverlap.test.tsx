/** A combo that only partly overlaps a holding, on the desk (#346): drawn in the Watchlist with a
 *  note of what it shares, in a real layout engine — the note sits under its own row, inside the
 *  table, and widens nothing from a 900px desk up. The behaviour is the jsdom suites'
 *  (`NextDesk.test.tsx`, `NextBookModel.test.ts`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
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

/** The overlap book served, every write refused: a layout suite never changes it. */
function serveOverlap(quotes: object[] = OVERLAP_QUOTES, holdings: object[] = OVERLAP_HOLDINGS): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET" && !/\/payoff$/.test(String(url))) {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    // REVIEW's samples (#295), a read: none recorded yet, rather than a list that is not one
    if (/\/samples$/.test(path)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLES) });
    }
    const body = path === "/quotes" ? quotes : path === "/monitors" ? OVERLAP_MONITORS
      : path === "/health" ? health : path === "/positions/values" ? holdings : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const noteOf = (id: string) => rowOf(id).closest("li")!.querySelector<HTMLElement>("[data-overlap]")!;

/** Whether `inner` is drawn wholly inside `outer`, to half a pixel. */
function inside(inner: Element, outer: Element): boolean {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
}

afterEach(cleanup);

describe.each([900, 1280, 2560])("on a %ipx desk", (width) => {
  it("draws the partly overlapping combos in the Watchlist, each note under its row and inside the table", async () => {
    await page.viewport(width, 900);
    serveOverlap();
    render(<Next />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
    const watchlist = screen.getByRole("region", { name: "Watchlist" });
    const table = document.querySelector<HTMLElement>(".nxd-table")!;
    for (const [id, words] of [["r-8100", "shares C8100 with 1231_8050"], ["w-7700", "contains 1231_7700's C7700"]]) {
      expect(watchlist.contains(rowOf(id!))).toBe(true);
      const note = noteOf(id!);
      expect(note.textContent).toBe(words);
      // seen, under its own row, and whole: no ellipsis, nothing cut
      expect(note.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(rowOf(id!).getBoundingClientRect().bottom - 0.5);
      expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 0.5);
      expect(inside(note, table)).toBe(true);
    }
    expect(overflowsSideways()).toBe(false);
  });
});

it("says the note in the inspector, which stays inside the page", async () => {
  await page.viewport(1280, 900);
  serveOverlap();
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Live" }));
  await settle();
  fireEvent.click(within(rowOf("r-8100")).getByRole("button", { name: "1231_8100" }));
  await settle();
  const insp = screen.getByRole("complementary", { name: "inspector: 1231_8100" });
  const note = insp.querySelector<HTMLElement>("[data-overlap]")!;
  expect(note.textContent).toBe("shares C8100 with 1231_8050");
  expect(inside(note, insp)).toBe(true);
  expect(overflowsSideways()).toBe(false);
});

it("wraps a note too long for the table rather than widening it or cutting it, inspector open", async () => {
  // a holding named longer than the table is wide once the inspector takes its share of 900px
  const LONG = "1231_C8050_rolled_from_1218_after_the_CPI_print_then_again_on_the_FOMC_day_and_once_more";
  const rename = (p: { id: string; name: string }) => (p.id === "h-8050" ? { ...p, name: LONG } : p);
  const quotes = OVERLAP_QUOTES.map((q) => ({ ...q, positions: q.positions.map(rename) }));
  const holdings = OVERLAP_HOLDINGS.map((h) => (h.id === "h-8050" ? { ...h, name: LONG } : h));
  await page.viewport(900, 900);
  serveOverlap(quotes, holdings);
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Live" }));
  await settle();
  fireEvent.click(within(rowOf("w-7700")).getByRole("button", { name: "1231_C7700" }));
  await settle();
  const note = noteOf("r-8100");
  expect(note.textContent).toBe(`shares C8100 with ${LONG}`);
  expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 0.5);
  expect(note.getBoundingClientRect().height).toBeGreaterThan(30);
  expect(inside(note, document.querySelector(".nxd-table")!)).toBe(true);
  expect(overflowsSideways()).toBe(false);
});
