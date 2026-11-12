/** Saving the redesigned page as an image, from the desk (#300, ADR 0023).
 *
 *  `/opt`'s picture carried over: a SECOND tree, off screen, at a width of its own — A's table with
 *  every ticked column whatever the room on screen, without a control in it, privacy honoured —
 *  rasterized by html-to-image, which paints oklch and `color-mix` because the real engine does
 *  the painting (`snapshot.ts` says why html2canvas cannot). `Rasterize.test.tsx` is the proof for
 *  `/opt`; this is the same proof for this page, on the delivered FILE: the fills and the
 *  attention chips are found in the tree, and their pixels in the PNG must be painted.
 *
 *  Every measurement of the tree is taken while the share sheet is still "open" (`catchShare`):
 *  the stage stays up exactly that long, so the tree read is the tree painted.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { COLUMNS } from "../next/desk/columns";
import { captureBox } from "../snapshot";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { settle } from "./nextBook";
import { catchShare, CONTROLS, decode, forgetShare, placeIn, still } from "./picture";

/** A sweep slower than any test, so no poll lands between the press and the file: every request
 *  the page makes in that window is then one the press made. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 600, expired_retention_days: 7, manage_by_dte: 21 },
};

/** Every route the page calls, answered by name, and every request kept. Anything else is a 404
 *  in the error shape, so a route nobody expected is a failure rather than an empty list. */
function serve(): string[] {
  const asked: string[] = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    const routes: Record<string, unknown> = {
      "/quotes": QUOTES, "/monitors": MONITORS, "/health": health, "/positions/values": HOLDINGS,
      "/references": [],
    };
    const known = method === "GET" && path in routes;
    return Promise.resolve({
      ok: known, status: known ? 200 : 404,
      json: () => Promise.resolve(known ? routes[path] : { detail: `${method} ${path} is not served here` }),
    });
  }) as unknown as typeof fetch;
  return asked;
}

async function show(mode: "live" | "review" = "live", width = 1280): Promise<string[]> {
  await page.viewport(width, 900);
  const asked = serve();
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: mode === "live" ? "Live" : "Review" }));
  await settle();
  return asked;
}

const press = () => fireEvent.click(screen.getByRole("button", { name: "save as image" }));
const rowIn = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

afterEach(async () => {
  cleanup();
  forgetShare();
  document.cookie = "ui_privacy=;path=/;max-age=0";
  document.cookie = "ui_cols_combo=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

describe("saving the desk as an image", () => {
  it("paints the fills and the attention chips, in their own colours", async () => {
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    expect(root, "the picture's tree is not up while the sheet is open").toBeTruthy();
    const png = await decode(shared.file()!);
    const ratio = png.w / root.scrollWidth;

    // a fired entry signal on the watchlist, a ringing risk rule under a holding, a calm spread
    const entry = rowIn(root, "w-dec04");
    const alarm = rowIn(root, "r-calls");
    const calm = rowIn(root, "w-dec31");
    const at = (el: Element, dx?: number) => png.at(...placeIn(root, el, ratio, dx));
    const fill = (row: HTMLElement) => at(row.querySelector(".nxd-fill i")!);
    const chip = (row: HTMLElement) => at(row.querySelector(".nx-chip")!, 3);
    const ground = png.at(4, 4);

    for (const [name, px] of [["entry fill", fill(entry)], ["alarm fill", fill(alarm)], ["calm fill", fill(calm)],
      ["entry chip", chip(entry)], ["alarm chip", chip(alarm)]]) {
      expect(px, `the ${name} came out transparent`).not.toMatch(/,0$/);
      expect(px, `the ${name} is the page's own ground — it was not painted`).not.toBe(ground);
    }
    // the two attention colours are two colours, and a fired fill is not a calm one: if the
    // backgrounds were dropped, each pair would collapse into one
    expect(chip(entry), "the entry chip and the alarm chip are one colour").not.toBe(chip(alarm));
    expect(fill(entry), "a fired fill is painted as a calm one").not.toBe(fill(calm));
    expect(fill(alarm), "a ringing fill is painted as a calm one").not.toBe(fill(calm));
    shared.release();
  });

  it("holds every ticked column, though the inspector has taken the room for them", async () => {
    await show("live", 1000);
    fireEvent.click(within(rowIn(document, "h-calls")).getAllByRole("button")[0]!);
    await settle();
    const onScreen = [...document.querySelectorAll<HTMLElement>(".nxd .nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(onScreen.length, "the screen still has room for every column — nothing to prove")
      .toBeLessThan(COLUMNS.live.length);

    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    const pictured = [...root.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(pictured).toEqual(COLUMNS.live.map((c) => c.key));
    // and nothing cut short inside its cell: a still image cannot be widened to read the rest
    for (const cell of root.querySelectorAll<HTMLElement>(".nxd-row > [data-col]:not([data-col=alarm])")) {
      expect(cell.scrollWidth, `"${cell.textContent}" is cut short`).toBeLessThanOrEqual(cell.clientWidth + 1);
    }
    expect(root.scrollWidth, "the picture shrank to the screen").toBeGreaterThanOrEqual(1000);
    // and each header over its own column: the columns are in `ch`, which resolves in each row's
    // own font, so a header row drawn smaller than the rows under it would sit out of line
    const head = [...root.querySelectorAll<HTMLElement>(".nxd-head > [data-col]")];
    const first = rowIn(root, "h-calls");
    for (const h of head) {
      const cell = first.querySelector<HTMLElement>(`:scope > [data-col="${h.dataset.col}"]`)!;
      expect(h.getBoundingClientRect().left, `the ${h.dataset.col} header is out of line`)
        .toBeCloseTo(cell.getBoundingClientRect().left, 0);
      expect(h.getBoundingClientRect().width).toBeCloseTo(cell.getBoundingClientRect().width, 0);
    }
    shared.release();
  });

  it("leaves out a column the viewer unticked", async () => {
    document.cookie = "ui_cols_combo=captured;path=/";
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const pictured = [...still()!.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(pictured).not.toContain("captured");
    expect(pictured).toContain("pnl");
    shared.release();
  });

  it("carries no control: nothing in a picture can be pressed", async () => {
    await show();
    // the inspector open and the price map shown, so there is something to leave out
    fireEvent.click(within(rowIn(document, "h-calls")).getAllByRole("button")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "price map" }));
    await settle();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].map((el) => el.outerHTML.slice(0, 80));
    expect(controls).toEqual([]);
    // the book is in it all the same: holdings, the rules under them, the watchlist, the quarantine
    for (const id of ["h-puts", "h-calls", "h-ic", "r-calls", "w-dec04", "w-dec18-delta", "q-unknown"]) {
      expect(rowIn(root, id), `${id} is not in the picture`).toBeTruthy();
    }
    shared.release();
  });

  for (const mode of ["live", "review"] as const) {
    it(`hides every $ amount and every contract count under privacy, in ${mode.toUpperCase()}`, async () => {
      document.cookie = "ui_privacy=on;path=/";
      await show(mode);
      const shared = catchShare();
      press();
      await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
      const root = still()!;
      // read off the tree the file was made from: no picture's pixels can be read for text
      const text = root.textContent!;
      expect(text, "no P&L is drawn at all, so privacy proves nothing").toContain("$•••");
      expect(text).not.toMatch(/\$\s*[+-]?\d/);
      expect(text).not.toMatch(/[+-]\$\d/);
      expect(text).not.toMatch(/×\s*\d/);
      // and the file IS that tree: its size is the tree's, at the resolution captureBox picks
      const box = captureBox(root.scrollWidth, root.scrollHeight);
      const png = await decode(shared.file()!);
      expect(png.w).toBe(Math.round(box.width * box.pixelRatio));
      expect(png.h).toBe(Math.round(box.height * box.pixelRatio));
      shared.release();
    });
  }

  it("says the dollar amounts with privacy off, which is what the test above hides", async () => {
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    expect(still()!.textContent).toMatch(/[+-]\$\d/);
    shared.release();
  });

  it("asks the service for nothing, and takes the tree down when it is done", async () => {
    const asked = await show();
    const before = asked.length;
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    expect(still()).toBeTruthy();
    shared.release();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 4000 }).toBeNull();
    await settle();
    expect(asked.slice(before), "the press asked the service for something").toEqual([]);
    // and the button is back for the next one
    expect(screen.getByRole("button", { name: "save as image" })).toBeEnabled();
  });

  it("takes the tree down when the share sheet is closed", async () => {
    await show();
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: () => Promise.reject(Object.assign(new Error("closed"), { name: "AbortError" })),
      configurable: true,
    });
    press();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 2000 }).toBeTruthy();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 8000 }).toBeNull();
  });
});
