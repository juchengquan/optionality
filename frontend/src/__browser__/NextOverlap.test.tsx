/** A combo that only partly overlaps a holding, on the desk (#346): drawn as a watched spread in its
 *  holding's expiry, in a real layout engine. What it shares is said in its inspector, not under its
 *  row (the owner, 2026-11-17), and there it fits whatever the holding is called. The behaviour is
 *  the jsdom suites' (`NextDesk.test.tsx`, `NextBookModel.test.ts`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";
import { payoffAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

const SAMPLES = {
  levels: { dte_at_open: 58, target: 1, stop: 4, target_dte: 15, manage_by_dte: 21 }, plan: [], samples: [],
};

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
};

/** The overlap book served, every write refused: a layout suite never changes it. */
function serveOverlap(quotes: object[] = OVERLAP_QUOTES, holdings: object[] = OVERLAP_HOLDINGS): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET" && !/\/payoff$/.test(String(url))) {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    // a holding's samples (#295), a read: none recorded yet, rather than a list that is not one
    if (/\/samples$/.test(path)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLES) });
    }
    const body = path === "/quotes" ? quotes : path === "/monitors" ? OVERLAP_MONITORS
      : path === "/health" ? health : path === "/positions/values" ? holdings
        // a moved combo's inspector draws its payoff as a watched spread's (#346)
        : payoffAnswer(path) ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

/** Whether `inner` is drawn wholly inside `outer`, to half a pixel. */
function inside(inner: Element, outer: Element): boolean {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
}

afterEach(cleanup);

describe.each([900, 1280, 2560])("on a %ipx desk", (width) => {
  it("draws the partly overlapping combos as watched spreads in their holding's expiry, with no note in the table", async () => {
    await page.viewport(width, 900);
    serveOverlap();
    render(<Next />);
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
    // the one book (2026-11-17): in the same expiry as the holdings they overlap, after them
    const expiry = rowOf("h-8050").closest<HTMLElement>(".nxd-expiry")!;
    const table = document.querySelector<HTMLElement>(".nxd-table")!;
    for (const id of ["r-8100", "w-7700"]) {
      expect(expiry.contains(rowOf(id))).toBe(true);
      expect(rowOf("h-8050").compareDocumentPosition(rowOf(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(table.querySelector("[data-overlap]")).toBeNull();
    expect(overflowsSideways()).toBe(false);
  });
});

it("says the note in the inspector, which stays inside the page", async () => {
  await page.viewport(1280, 900);
  serveOverlap();
  render(<Next />);
  await settle();
  fireEvent.click(within(rowOf("r-8100")).getByRole("button", { name: "1231_8100" }));
  await settle();
  const insp = screen.getByRole("complementary", { name: "inspector: 1231_8100" });
  const note = insp.querySelector<HTMLElement>("[data-overlap]")!;
  expect(note.textContent).toBe("shares C8100 with 1231_8050");
  expect(inside(note, insp)).toBe(true);
  expect(overflowsSideways()).toBe(false);
});

it("wraps a note too long for the inspector rather than widening it or cutting it", async () => {
  // a holding named longer than the table is wide once the inspector takes its share of 900px
  const LONG = "1231_C8050_rolled_from_1218_after_the_CPI_print_then_again_on_the_FOMC_day_and_once_more";
  const rename = (p: { id: string; name: string }) => (p.id === "h-8050" ? { ...p, name: LONG } : p);
  const quotes = OVERLAP_QUOTES.map((q) => ({ ...q, positions: q.positions.map(rename) }));
  const holdings = OVERLAP_HOLDINGS.map((h) => (h.id === "h-8050" ? { ...h, name: LONG } : h));
  await page.viewport(900, 900);
  serveOverlap(quotes, holdings);
  render(<Next />);
  await settle();
  fireEvent.click(within(rowOf("r-8100")).getByRole("button", { name: "1231_8100" }));
  await settle();
  const insp = screen.getByRole("complementary", { name: "inspector: 1231_8100" });
  const note = insp.querySelector<HTMLElement>("[data-overlap]")!;
  expect(note.textContent).toBe(`shares C8100 with ${LONG}`);
  expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 0.5);
  expect(note.getBoundingClientRect().height).toBeGreaterThan(30);
  expect(inside(note, insp)).toBe(true);
  expect(overflowsSideways()).toBe(false);
});
