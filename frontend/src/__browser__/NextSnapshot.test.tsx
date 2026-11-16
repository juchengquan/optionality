/** Saving the page as an image, from the desk (#300, #394; ADR 0023).
 *
 *  Since #394 the picture is ONE plain table, from the desk and the phone alike, for reading later:
 *  a SECOND tree, off screen, as wide as its widest row — every ticked column whatever the room on
 *  screen, under short headers (#400), without a control in it, privacy honoured — rasterized by
 *  html-to-image. What is measured here is what a plain table promises and no jsdom can see: one
 *  light ground and one ink in either colour scheme, no chip, bar, bracket or coloured leg, a
 *  legible face, nothing clipped, and the same tree from the desk and from a phone-width window.
 *
 *  Every measurement of the tree is taken while the share sheet is still "open" (`catchShare`):
 *  the stage stays up exactly that long, so the tree read is the tree painted.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { readPicture } from "../testing/plainRead";
import { settle } from "./nextBook";
import { catchShare, CONTROLS, decode, forgetShare, still } from "./picture";
import { bookTable, inkIn, measurePlain, PLAIN_GROUND } from "../testing/plainPicture";

/** Every node handed to the rasterizer, with its text as it stood at that moment: the picture's
 *  text cannot be read off its pixels, so it is read off the node the pixels were made from. */
const captured = vi.hoisted(() => [] as { node: HTMLElement; text: string; html: string }[]);
vi.mock("html-to-image", async (orig) => {
  const real = await orig<typeof import("html-to-image")>();
  return {
    ...real,
    toBlob: (node: HTMLElement, options?: object) => {
      captured.push({ node, text: node.textContent ?? "", html: node.outerHTML });
      return real.toBlob(node, options);
    },
  };
});

/** One Reference, so the header has something to say, with the service's stamp on its read (#371). */
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
  settings: { sweep_seconds: 600, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
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
const rowOnScreen = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
/** A row of the picture, by the name in its second cell. */
const rowNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((tr) => tr.children[0]?.textContent === name)!;

/** Take one picture and hold the sheet open: the tree it was taken of, and the file. */
async function take(): Promise<{ root: HTMLElement; file: File; release: () => void }> {
  const shared = catchShare();
  press();
  await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
  const root = still()!;
  expect(root, "the picture's tree is not up while the sheet is open").toBeTruthy();
  expect(captured.at(-1)!.node, "the file was made from something other than the picture's tree").toBe(root);
  return { root, file: shared.file()!, release: shared.release };
}

afterEach(async () => {
  cleanup();
  captured.length = 0;
  await commands.colorScheme("light");
  forgetShare();
  document.cookie = "ui_privacy=;path=/;max-age=0";
  document.cookie = "ui_cols_combo=;path=/;max-age=0";
  document.cookie = "ui_arrangement=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

describe("saving the desk as an image", () => {
  for (const scheme of ["light", "dark"] as const) it(`is one plain table, dark on a light ground, in the ${scheme} scheme`, async () => {
    // the page's tokens are redefined for the dark scheme; the picture is the same picture in both
    await commands.colorScheme(scheme);
    await show();
    const { root, file, release } = await take();
    expect(measurePlain(root)).toEqual({ grounds: [], inks: [], drawn: [], hidden: [], small: [], clipped: [] });
    expect(readPicture(root).sections).toEqual(bookTable());
    // and the file is painted on that ground: its corner is white, and a cell's words are not
    const png = await decode(file);
    expect(png.at(2, 2)).toBe(PLAIN_GROUND);
    // and words are painted on it: a holding's name, a rule's sentence, the header block
    const ringing = [...root.querySelectorAll("td")].find((td) => td.textContent!.startsWith("|value| ≥ 6.00 — now 6.20"))!;
    for (const el of [rowNamed(root, "1218_P6400").children[0]!, ringing, root.querySelector(".nx-still-lines dd")!]) {
      expect(inkIn(png, root, el), `no words painted where "${el.textContent}" is`).toBe(true);
    }
    expect(png.w / root.scrollWidth).toBeGreaterThan(1);
    release();
  });

  it("is the same tree from the desk and from a phone-width window", async () => {
    await show(1280);
    expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("desk");
    const desk = await take();
    const deskWidth = desk.root.getBoundingClientRect().width;
    desk.release();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 4000 }).toBeNull();
    cleanup();
    // by the screen's width, 390px is the phone
    await show(390);
    expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("phone");
    const phone = await take();
    expect(captured).toHaveLength(2);
    // the moment differs by the time the two presses took, and nothing else may
    const untimed = (html: string) => html.replace(/<dd>[^<]*\(New York\)[^<]*<\/dd>/, "");
    expect(untimed(captured[1]!.html)).toBe(untimed(captured[0]!.html));
    expect(phone.root.getBoundingClientRect().width).toBeCloseTo(deskWidth, 0);
    phone.release();
  });

  // one set at every hour (#372): the picture draws it in session and out of it
  for (const when of ["in session", "outside the session"] as const) it(`holds every ticked column, though the inspector has taken the room for them, ${when}`, async () => {
    if (when === "outside the session") vi.setSystemTime(SUNDAY);
    await show(1000);
    fireEvent.click(within(rowOnScreen("h-calls")).getAllByRole("button")[0]!);
    await settle();
    const onScreen = [...document.querySelectorAll<HTMLElement>(".nxd .nxd-head [data-col]")].map((c) => c.dataset.col);
    expect(onScreen.length, "the screen still has room for every column — nothing to prove").toBeLessThan(11);
    const { root, release } = await take();
    const head = [...root.querySelector("thead tr")!.children].map((c) => c.textContent);
    expect(head).toEqual([
      "name", "legs", "value", "P&L", "captured", "pace gap (pts)", "Δ", "SPX→short", "DTE", "manage-by", "rule",
    ]);
    // nothing cut short: a still image cannot be widened to read the rest
    expect(measurePlain(root).clipped).toEqual([]);
    release();
  });

  it("leaves out a column the viewer unticked", async () => {
    document.cookie = "ui_cols_combo=captured;path=/";
    await show();
    const { root, release } = await take();
    const head = [...root.querySelector("thead tr")!.children].map((c) => c.textContent);
    expect(head).not.toContain("captured");
    expect(head).toContain("P&L");
    release();
  });

  it("carries no control: nothing in a picture can be pressed", async () => {
    await show();
    // the inspector open and the price map shown, so there is something to leave out
    fireEvent.click(within(rowOnScreen("h-calls")).getAllByRole("button")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "price map" }));
    await settle();
    const { root, release } = await take();
    expect([...root.querySelectorAll<HTMLElement>(CONTROLS)].map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    // the book is in it all the same: holdings, the rules under them, the watchlist, the quarantine
    for (const name of ["1218_P6400", "1218_C7300", "1231_IC", "1204_P6900", "261218 7150P", "261211 8000C"]) {
      expect(rowNamed(root, name), `${name} is not in the picture`).toBeTruthy();
    }
    release();
  });

  for (const when of ["in session", "outside the session"] as const) {
    it(`hides every $ amount and every contract count under privacy, ${when}`, async () => {
      document.cookie = "ui_privacy=on;path=/";
      if (when === "outside the session") vi.setSystemTime(SUNDAY);
      await show();
      const { release } = await take();
      expect(captured, "one capture per press").toHaveLength(1);
      const text = captured[0]!.text;
      expect(text, "no P&L is drawn at all, so privacy proves nothing").toContain("$•••");
      expect(text).not.toMatch(/\$\s*[+-]?\d/);
      expect(text).not.toMatch(/[+-]\$\d/);
      expect(text).not.toMatch(/×\s*\d/);
      release();
    });
  }

  it("says the dollar amounts with privacy off, which is what the test above hides", async () => {
    await show();
    const { release } = await take();
    expect(captured[0]!.text).toMatch(/[+-]\$\d/);
    release();
  });

  it("says the rules in full sentences, while the screen keeps them short (#388)", async () => {
    // wide enough for the rule's column, the widest, which the desk fits last (ADR 0008)
    await show(1900);
    // the screen's short form
    expect(rowOnScreen("w-dec18-delta").querySelector('[data-col="alarm"]')!.textContent).toContain("|Δ| ≥ 0.20");
    const { root, release } = await take();
    // the watchlist's own header: its table carries no holding-only column (2026-11-16)
    const row = rowNamed(root, "261218 7150P");
    const rule = [...row.closest("table")!.querySelector("thead tr")!.children].findIndex((c) => c.textContent === "rule");
    expect(row.children[rule]!.textContent).toBe("|Δ| ≥ 0.20 — now −0.170, 0.030 away");
    // the Δ column's header is the one Δ (#400): no rule is said in symbols
    expect(root.querySelector("tbody")!.textContent).not.toMatch(/[↑↓▲▼Δ]/);
    release();
  });

  it("carries the References in session, with no time, under a header that says so", async () => {
    // the one place a picture states SPX's level, from a figure the page already polls
    await show();
    const { root, release } = await take();
    const lines = readPicture(root).lines;
    expect(lines.find((l) => l.label === "References")!.items).toEqual(["S&P 500 (moomoo) 7612.25 +0.42%"]);
    expect(lines.find((l) => l.label === "session")!.text).toBe("in session");
    // when it was taken, in New York and in the service's own zone
    expect(lines.find((l) => l.label === "taken")!.text).toMatch(/ \(New York\) · .* \(Asia\/Singapore\)$/);
    release();
  });

  it("carries the References outside the session with the time each was read (#371)", async () => {
    vi.setSystemTime(SUNDAY);
    await show();
    const { root, release } = await take();
    const lines = readPicture(root).lines;
    expect(lines.find((l) => l.label === "References")!.items).toEqual(["S&P 500 (moomoo) 7612.25 +0.42% read at 00:59"]);
    // the market-closed line's words (the owner's book here carries no stamp, so no time), once
    expect(lines.find((l) => l.label === "session")!.text).toBe("market closed");
    expect(captured[0]!.text.split("market closed")).toHaveLength(2);
    release();
  });

  it("is one moment: a poll that lands mid-capture changes the page, not the picture", async () => {
    let watched = 2.4;
    await show(1280, () => QUOTES.map((q) => q.id === "w-dec31"
      ? { ...q, watched, combo_value: watched, distance: 6 - watched } : q));
    const { root, release } = await take();
    const before = root.textContent;
    expect(rowNamed(root, "1231_C7600").textContent).toContain("2.40");
    // the next answer differs, and lands while the picture's tree is still up
    watched = 5.55;
    fireEvent.click(screen.getByRole("button", { name: "refresh now" }));
    await expect.poll(() => rowOnScreen("w-dec31").textContent, { timeout: 4000 }).toContain("5.55");
    expect(still(), "the tree went before the poll landed — nothing tested").toBeTruthy();
    expect(still()!.textContent, "the picture took the poll's figures mid-capture").toBe(before);
    release();
  });

  it("asks the service for nothing, and takes the tree down when it is done", async () => {
    const asked = await show();
    const before = asked.length;
    const { release } = await take();
    release();
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

