/** The desk's terminal measured in a real layout engine (ADR 0008, ADR 0023, #289): nothing pushed
 *  sideways from a 900px desk to a 2560px one, in either mode, with the inspector open or shut;
 *  columns dropped by measuring the room and the text rather than by any breakpoint; and the
 *  entry-style setting recolouring the fired entry row and nothing else. The behaviour is the
 *  jsdom suite's (`__tests__/NextDesk.test.tsx`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

/* The owner-shaped book the desk's acceptance criteria name, served to the page. Here and not in a
   helper module beside `nextBook.ts`: only a test may import test support (check-test-support). */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** Every holding with an exit schedule, so REVIEW's pace columns have something to say. */
const scheduled = HOLDINGS.map((h) => ({
  ...h, schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4,
    target_dte: 11, manage_by_dte: 21, reached: null, manage_by_due: false },
}));

/** Every write refused: a layout suite never changes the book. */
function serveOwnerBook(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? scheduled : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const table = () => document.querySelector<HTMLElement>(".nxd-table")!;
const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const shown = () => [...document.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col!);

/** The page in the mode asked for: the clock picks one, and the switch overrides it. */
async function show(mode: "live" | "review", width: number) {
  await page.viewport(width, 900);
  serveOwnerBook();
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: mode === "live" ? "Live" : "Review" }));
  await settle();
  expect(document.querySelector<HTMLElement>(".nx")!.dataset.mode).toBe(mode);
}

async function inspect(id: string) {
  fireEvent.click(within(rowOf(id)).getByRole("button", { name: /./ }));
  await settle();
  expect(document.querySelector(".nxd-inspector")).toBeTruthy();
}

/** Any cell drawn past the table's right edge, or any figure cut short by its own cell: either one
 *  is a column that was kept without the room to draw it. The flexible column (the rule's sentence,
 *  or the name once that has dropped) gives up what it must, with an ellipsis, by design. */
function misfits(): string[] {
  const right = table().getBoundingClientRect().right;
  const flexible = shown().includes("alarm") ? "alarm" : "name";
  const out: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>(".nxd-row, .nxd-head")) {
    for (const cell of row.querySelectorAll<HTMLElement>(":scope > [data-col]")) {
      const key = cell.dataset.col!;
      if (cell.getBoundingClientRect().right > right + 0.5) out.push(`${row.dataset.ref} ${key} past the edge`);
      if (key !== flexible && cell.scrollWidth > cell.clientWidth + 1) {
        out.push(`${row.dataset.ref} ${key} cut: ${cell.scrollWidth} > ${cell.clientWidth}`);
      }
      // nothing drawn over a cell: the header's picker once sat on top of its last label
      const r = cell.getBoundingClientRect();
      const top = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
      if (cell.textContent && r.width > 6 && r.height > 0 && top && !cell.contains(top)) out.push(`${row.dataset.ref ?? "header"} ${key} covered`);
    }
  }
  return out;
}

afterEach(async () => {
  cleanup();
  document.documentElement.style.fontSize = "";
  for (const n of ["ui_entry", "ui_cols_combo"]) document.cookie = `${n}=;path=/;max-age=0`;
  await page.viewport(1280, 900);
});

describe("nothing is pushed sideways, from a 900px desk to a 2560px one", () => {
  for (const mode of ["live", "review"] as const) {
    for (const width of [900, 1280, 2560]) {
      it(`at ${width}px in ${mode}, with the inspector shut and open`, async () => {
        await show(mode, width);
        expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
        expect(overflowsSideways()).toBe(false);
        expect(table().scrollWidth).toBeLessThanOrEqual(table().clientWidth);
        expect(misfits()).toEqual([]);

        await inspect("h-calls");
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!.getBoundingClientRect();
        // beside the table, not over it
        expect(insp.left).toBeGreaterThanOrEqual(table().getBoundingClientRect().right);
        expect(insp.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
        expect(overflowsSideways()).toBe(false);
        expect(table().scrollWidth).toBeLessThanOrEqual(table().clientWidth);
        expect(misfits()).toEqual([]);
      });
    }
  }
});

describe("columns are dropped as measured (ADR 0008)", () => {
  it("draws every column on a wide desk and fewer on a narrow one", async () => {
    await show("live", 2560);
    expect(shown()).toEqual(["name", "legs", "value", "pnl", "captured", "delta", "dte", "manage", "alarm"]);
    cleanup();
    await show("live", 900);
    await inspect("h-calls");
    expect(shown().length).toBeLessThan(9);
    expect(shown()[0]).toBe("name");
  });

  it("only ever gains columns as the window widens, never trades one for another", async () => {
    await show("live", 900);
    await inspect("w-dec18");
    let before = shown();
    for (let width = 940; width <= 1700; width += 40) {
      await page.viewport(width, 900);
      await settle();
      const now = shown();
      expect(before.filter((k) => !now.includes(k)), `lost at ${width}px`).toEqual([]);
      expect(misfits(), `at ${width}px`).toEqual([]);
      before = now;
    }
  });

  it("drops columns when the text grows, at the same width — which no breakpoint can see", async () => {
    await show("live", 1280);
    await inspect("h-ic");
    const at16 = shown();
    document.documentElement.style.fontSize = "22px";
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(shown().length).toBeLessThan(at16.length);
    expect(overflowsSideways()).toBe(false);
    expect(misfits()).toEqual([]);
  });

  it("moves the fill bar into the name cell when the rule's column has dropped", async () => {
    document.cookie = "ui_cols_combo=alarm;path=/";
    await show("live", 1280);
    expect(shown()).not.toContain("alarm");
    expect(rowOf("w-dec18").querySelector('[data-col="name"] [data-fill]')).toBeTruthy();
  });
});

describe("the bracket and the attention colours, as drawn", () => {
  it("joins the condor's two rows and no others", async () => {
    await show("live", 1280);
    const bracket = document.querySelector<HTMLElement>(".nxd-bracket")!.getBoundingClientRect();
    const mid = (id: string) => { const r = rowOf(id).getBoundingClientRect(); return r.top + r.height / 2; };
    expect(Math.abs(bracket.top - mid("h-calls"))).toBeLessThan(2);
    expect(Math.abs(bracket.bottom - mid("h-puts"))).toBeLessThan(2);
    expect(bracket.height).toBeGreaterThan(0);
  });

  it("recolours only the fired entry row when entries are set to look like risk", async () => {
    const paint = () => Object.fromEntries(["w-dec04", "r-calls", "q-unknown", "w-dec18"].map((id) => {
      const row = rowOf(id);
      const chip = row.querySelector(".nx-chip");
      return [id, `${getComputedStyle(row).backgroundColor} ${chip ? getComputedStyle(chip).backgroundColor : "-"}`];
    }));
    await show("live", 1280);
    const opportunity = paint();
    cleanup();
    document.cookie = "ui_entry=risk;path=/";
    await show("live", 1280);
    const risk = paint();
    expect(risk["w-dec04"]).not.toBe(opportunity["w-dec04"]);
    // and it now looks exactly like the fired risk rule
    expect(risk["w-dec04"]).toBe(risk["r-calls"]);
    for (const id of ["r-calls", "q-unknown", "w-dec18"]) expect(risk[id]).toBe(opportunity[id]);
  });
});
