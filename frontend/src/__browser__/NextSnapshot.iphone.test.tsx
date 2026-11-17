/** Saving the page as an image, from the phone (#300, #394; ADR 0023), under Playwright's
 *  iPhone profile. Since #394 the picture is the desk's: ONE plain table, drawn off screen as wide
 *  as its widest row whatever the phone, so it is measured here as `NextSnapshot.test.tsx`
 *  measures it on the desk — one light ground and one ink, no chip, bar or coloured leg, a legible
 *  face, nothing clipped — and its table must be the very table the desk's suite holds it to.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { settle } from "./nextBook";
import { readPicture } from "../testing/plainRead";
import { catchShare, CONTROLS, decode, forgetShare, still } from "./picture";
import { bookTable, inkIn, measurePlain, PLAIN_GROUND } from "../testing/plainPicture";
import { hitBox } from "./targets";

/** Every node handed to the rasterizer, with its text as it stood then (NextSnapshot.test.tsx). */
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

/** A holding closed on 20261106, as `/positions` keeps it (ADR 0022). */
const CLOSED = {
  ...HOLDINGS[0]!, id: "c-old", name: "1120_P6000", strike_date: "2026-11-20", opened_at: "2026-11-01",
  closed_on: "2026-11-06", entry: 2, exit: 0.5, realized_points: 1.5, cost_to_close: null, pnl: null,
  captured: null,
};

/** A sweep slower than any test, so no poll lands between the press and the file. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 600, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
};

/** Every route the page calls in and out of the session, answered by name, every request kept. A
 *  holding's history reads its samples, so those are answered too — with nothing recorded. */
function serve(): string[] {
  const asked: string[] = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    const routes: Record<string, unknown> = {
      "/quotes": QUOTES, "/monitors": MONITORS, "/health": health, "/positions/values": HOLDINGS,
      // the closed trades (#296, #373), which the picture leaves out: a journal is not the book
      "/positions": [CLOSED],
      "/references": [],
    };
    const samples = method === "GET" && /^\/positions\/[^/]+\/samples$/.test(path);
    const known = samples || (method === "GET" && path in routes);
    const body = samples ? { levels: null, plan: [], samples: [] } : routes[path];
    return Promise.resolve({
      ok: known, status: known ? 200 : 404,
      json: () => Promise.resolve(known ? body : { detail: `${method} ${path} is not served here` }),
    });
  }) as unknown as typeof fetch;
  return asked;
}

/** The Book tab, in session or on a Sunday outside it (#374: the same cards either way). */
async function show(session = true): Promise<string[]> {
  if (!session) vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));
  const asked = serve();
  render(<Next />);
  await settle();
  return asked;
}

const save = () => screen.getByRole("button", { name: "save as image" });

afterEach(() => {
  cleanup();
  captured.length = 0;
  forgetShare();
  document.cookie = "ui_privacy=;path=/;max-age=0";
});

describe("saving the phone's book as an image", () => {
  it("is a target a finger can hit, and so is copying it as text", async () => {
    await show();
    for (const button of [save(), screen.getByRole("button", { name: "copy as text" })]) {
      const r = hitBox(button);
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
  });

  it("is the desk's plain table, dark on a light ground, with no card, chip or bar and no control", async () => {
    await show();
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    expect(captured[0]!.node, "the file was made from something other than the picture's tree").toBe(root);
    expect(root.querySelector(".nxp-card, .nxp-condor")).toBeNull();
    expect(measurePlain(root)).toEqual({ grounds: [], inks: [], drawn: [], hidden: [], small: [], clipped: [] });
    // the table the desk's suite holds its picture to, row for row and cell for cell
    expect(readPicture(root).sections).toEqual(bookTable());
    // wider than the phone, since it is as wide as its rows, and never cut to the screen
    expect(root.getBoundingClientRect().width).toBeGreaterThan(window.innerWidth);
    expect([...root.querySelectorAll<HTMLElement>(CONTROLS)].map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    const png = await decode(shared.file()!);
    expect(png.at(2, 2)).toBe(PLAIN_GROUND);
    // and words are painted on it: a holding's name, a rule's sentence, the header block
    const cells = [...root.querySelectorAll("td")];
    const name = cells.find((td) => td.textContent === "1218_P6400")!;
    const ringing = cells.find((td) => td.textContent!.startsWith("|value| ≥ 6.00 — now 6.20"))!;
    for (const el of [name, ringing, root.querySelector(".nx-still-lines dd")!]) {
      expect(inkIn(png, root, el), `no words painted where "${el.textContent}" is`).toBe(true);
    }
    shared.release();
  });

  for (const session of [true, false]) {
    it(`hides every $ amount and every contract count under privacy, ${session ? "in" : "out of"} session`, async () => {
      document.cookie = "ui_privacy=on;path=/";
      await show(session);
      const shared = catchShare();
      await userEvent.click(save());
      await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
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

  it("leaves the closed trades out of the picture, their fold open: a journal is not the book", async () => {
    await show(false);
    await userEvent.click(screen.getByRole("button", { name: "Closed trades" }));
    await expect.poll(() => document.querySelector(".nx-main")!.textContent, { timeout: 4000 })
      .toContain("1120_P6000");
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    expect(captured[0]!.text).toContain("1218_C7300");
    expect(captured[0]!.text).not.toContain("1120_P6000");
    shared.release();
  });

  it("asks the service for nothing, and takes the tree down when it is done", async () => {
    const asked = await show(false);
    await settle();
    const before = asked.length;
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    shared.release();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 4000 }).toBeNull();
    await settle();
    // a sheet's charts read samples: the picture draws none, so it asks for none
    expect(asked.slice(before), "the press asked the service for something").toEqual([]);
  });
});
