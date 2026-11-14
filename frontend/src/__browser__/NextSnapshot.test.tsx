/** Saving the page as an image, from the desk (#300, ADR 0023).
 *
 *  The old page's picture, carried over: a SECOND tree, off screen, at a width of its own — A's table with
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
import { commands, page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { COLUMNS } from "../desk/columns";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { settle } from "./nextBook";
import { catchShare, CONTROLS, decode, forgetShare, placeIn, still } from "./picture";

/** Every node handed to the rasterizer, with its text as it stood at that moment: the picture's
 *  text cannot be read off its pixels, so it is read off the node the pixels were made from. */
const captured = vi.hoisted(() => [] as { node: HTMLElement; text: string }[]);
vi.mock("html-to-image", async (orig) => {
  const real = await orig<typeof import("html-to-image")>();
  return {
    ...real,
    toBlob: (node: HTMLElement, options?: object) => {
      captured.push({ node, text: node.textContent ?? "" });
      return real.toBlob(node, options);
    },
  };
});

/** One Reference, so the strip has something to say, with the service's stamp on its read (#371). */
const references = [
  { id: "ref1", code: "US..SPX", label: "S&P 500", source: "moomoo", figure: 7612.25, change: 0.0042,
    field: "mid_price", name: "S&P 500", error: null, last_known: false, fetched_at: "2026-11-16 00:59:05+08:00" },
];

/** A holding closed on 6 Nov, as `/positions` keeps it (ADR 0022). */
const CLOSED = {
  ...HOLDINGS[0]!, id: "c-old", name: "1120_P6000", strike_date: "2026-11-20", opened_at: "2026-11-01",
  closed_on: "2026-11-06", entry: 2, exit: 0.5, realized_points: 1.5, cost_to_close: null, pnl: null,
  captured: null,
};

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
function serve(quotes: () => unknown = () => QUOTES): string[] {
  const asked: string[] = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    const routes: Record<string, unknown> = {
      "/quotes": quotes(), "/monitors": MONITORS, "/health": health, "/positions/values": HOLDINGS,
      // the closed trades (#296, #373), which the picture leaves out: a journal is not the book
      "/positions": [CLOSED],
      "/references": references,
    };
    const known = method === "GET" && path in routes;
    return Promise.resolve({
      ok: known, status: known ? 200 : 404,
      json: () => Promise.resolve(known ? routes[path] : { detail: `${method} ${path} is not served here` }),
    });
  }) as unknown as typeof fetch;
  return asked;
}

/** The page at a width, on the suite's pinned clock (in session) unless the test set another. */
async function show(width = 1280, quotes?: () => unknown): Promise<string[]> {
  await page.viewport(width, 900);
  const asked = serve(quotes);
  render(<Next />);
  await settle();
  return asked;
}
/** A Sunday, 12:00 New York: outside the session. */
const SUNDAY = new Date("2026-11-15T17:00:00Z");

const press = () => fireEvent.click(screen.getByRole("button", { name: "save as image" }));
const rowIn = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

afterEach(async () => {
  cleanup();
  captured.length = 0;
  await commands.colorScheme("light");
  forgetShare();
  document.cookie = "ui_privacy=;path=/;max-age=0";
  document.cookie = "ui_cols_combo=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

describe("saving the desk as an image", () => {
  for (const scheme of ["light", "dark"] as const) it(`paints the fills and the attention chips, in their own colours, ${scheme}`, async () => {
    // dark first (ADR 0023): the tokens are redefined for the dark scheme, and painted again
    await commands.colorScheme(scheme);
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    expect(root, "the picture's tree is not up while the sheet is open").toBeTruthy();
    expect(captured[0]!.node, "the file was made from something other than the picture's tree").toBe(root);
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
    // and each fired row's bar and chip are ONE colour, its attention colour: a row's tint differs
    // from row to row too, so the comparisons above would survive a chip or a bar left unpainted —
    // the row's ground showing through instead — and this one cannot
    expect(fill(entry), "the entry row's bar and chip differ — one of them was not painted").toBe(chip(entry));
    expect(fill(alarm), "the ringing row's bar and chip differ — one of them was not painted").toBe(chip(alarm));
    shared.release();
  });

  // one set at every hour (#372): the picture draws it in session and out of it
  for (const when of ["in session", "outside the session"] as const) it(`holds every ticked column, though the inspector has taken the room for them, ${when}`, async () => {
    if (when === "outside the session") vi.setSystemTime(SUNDAY);
    await show(1000);
    fireEvent.click(within(rowIn(document, "h-calls")).getAllByRole("button")[0]!);
    await settle();
    const onScreen = [...document.querySelectorAll<HTMLElement>(".nxd .nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(onScreen.length, "the screen still has room for every column — nothing to prove")
      .toBeLessThan(COLUMNS.length);

    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    const pictured = [...root.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(pictured).toEqual(COLUMNS.map((c) => c.key));
    expect(pictured).toEqual(["name", "legs", "value", "pnl", "captured", "pace_gap", "delta", "strip", "dte", "manage", "alarm"]);
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

  for (const when of ["in session", "outside the session"] as const) {
    it(`hides every $ amount and every contract count under privacy, ${when}`, async () => {
      document.cookie = "ui_privacy=on;path=/";
      if (when === "outside the session") vi.setSystemTime(SUNDAY);
      await show();
      const shared = catchShare();
      press();
      await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
      // the node the rasterizer was handed IS the picture's tree, and its text — as it stood when
      // it was handed over — is what is checked: no picture's pixels can be read for text
      expect(captured, "one capture per press").toHaveLength(1);
      expect(captured[0]!.node, "the file was made from something other than the picture's tree").toBe(still());
      const text = captured[0]!.text;
      expect(text, "no P&L is drawn at all, so privacy proves nothing").toContain("$•••");
      expect(text).not.toMatch(/\$\s*[+-]?\d/);
      expect(text).not.toMatch(/[+-]\$\d/);
      expect(text).not.toMatch(/×\s*\d/);
      shared.release();
    });
  }

  it("says the dollar amounts with privacy off, which is what the test above hides", async () => {
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    expect(captured[0]!.node).toBe(still());
    expect(captured[0]!.text).toMatch(/[+-]\$\d/);
    shared.release();
  });

  it("carries the References in session, with no time, under a header that says so", async () => {
    // the one place a picture states SPX's level, from a figure the page already polls
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    expect(captured[0]!.text).toContain("S&P 500");
    expect(captured[0]!.text).toContain("7,612.25");
    expect(captured[0]!.text).not.toContain("read at");
    // the session, where the header once said the mode (#375)
    expect(captured[0]!.node.querySelector(".nx-still-head")!.textContent).toBe("optionalityin session");
    shared.release();
  });

  it("carries the References outside the session with the time each was read (#371)", async () => {
    vi.setSystemTime(SUNDAY);
    await show();
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const strip = captured[0]!.node.querySelector(".references")!;
    expect(strip.textContent).toBe("S&P 500 (moomoo) 7,612.25+0.42%read at 00:59");
    // and the market-closed line, with no button: nothing in a picture can be pressed (the owner's
    // book here carries no stamp, so the line says no time rather than the device's)
    expect(captured[0]!.node.querySelector(".nx-mkt-closed")!.textContent).toBe("market closed");
    expect(captured[0]!.node.querySelector(".nx-mkt-closed button")).toBeNull();
    // the header leaves the session to the market-closed line: said once, not twice
    expect(captured[0]!.node.querySelector(".nx-still-head")!.textContent).toBe("optionality");
    expect(captured[0]!.text.split("market closed")).toHaveLength(2);
    shared.release();
  });

  it("is one moment: a poll that lands mid-capture changes the page, not the picture", async () => {
    let watched = 2.4;
    await show(1280, () => QUOTES.map((q) => q.id === "w-dec31"
      ? { ...q, watched, combo_value: watched, distance: 6 - watched } : q));
    const shared = catchShare();
    press();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const before = still()!.textContent;
    expect(rowIn(still()!, "w-dec31").textContent).toContain("2.40");
    // the next answer differs, and lands while the picture's tree is still up
    watched = 5.55;
    fireEvent.click(screen.getByRole("button", { name: "refresh now" }));
    await expect.poll(() => rowIn(document.querySelector(".nx-main")!, "w-dec31").textContent, { timeout: 4000 })
      .toContain("5.55");
    expect(still(), "the tree went before the poll landed — nothing tested").toBeTruthy();
    expect(still()!.textContent, "the picture took the poll's figures mid-capture").toBe(before);
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
