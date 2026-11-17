/** The holding's three history panels on ONE crosshair (#395) on the phone, under Playwright's iPhone
 *  profile — touch, `isMobile`, a 390px screen — in a holding's sheet, whose history is open from
 *  the start outside the session: the three plot areas aligned to the pixel, and a real finger
 *  (Chrome's own touch events, through CDP) tapping or scrubbing any panel crossing the day in all
 *  three, with each readout inside its own panel. The desk's widths are `NextHistoryCross.test.tsx`'s. */
/// <reference types="@vitest/browser/providers/playwright" />
import { cdp, userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";

afterEach(cleanup);

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
};

/** The owner-shaped book, every write refused. */
function serveOwnerBook(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** The call spread's sheet outside the session, its three panels drawn. */
async function review() {
  vi.setSystemTime(new Date("2026-11-15T17:00:00Z")); // a Sunday: outside the session
  serveOwnerBook();
  render(<Next />);
  await settle();
  await userEvent.click(screen.getByRole("button", { name: "details of 1218_C7300 held" }));
  const sheet = await screen.findByRole("dialog");
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  const panels = await waitFor(() => {
    const found = [".nx-bd", ".nx-iv", ".nx-spxp"].map((sel) => sheet.querySelector<HTMLElement>(sel));
    if (!found.every((p) => p?.querySelector("circle"))) throw new Error("not drawn yet");
    return found as HTMLElement[];
  });
  return { sheet, panels };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const touch = (type: string, at?: { x: number; y: number }) => cdp().send("Input.dispatchTouchEvent", {
  type, touchPoints: at ? [{ x: Math.round(at.x), y: Math.round(at.y) }] : [],
});
async function tap(at: { x: number; y: number }) {
  await touch("touchStart", at);
  await pause(50);
  await touch("touchEnd");
  await settle();
}
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await touch("touchStart", from);
  for (let i = 1; i <= steps; i++) {
    await pause(16);
    await touch("touchMove", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  }
  await pause(16);
  await touch("touchEnd");
  await settle();
}

const crossed = (panels: HTMLElement[]) =>
  panels.map((p) => p.querySelector("[data-crosshair]")?.getAttribute("data-crosshair"));
const dayX = (panels: HTMLElement[], on: string) => {
  const r = panels[0]!.querySelector(`[data-sample='${on}'] circle`)!.getBoundingClientRect();
  return r.left + r.width / 2;
};

describe("the history's three panels on the phone", () => {
  it("line their plot areas up to the pixel, inside the screen", async () => {
    const { panels } = await review();
    const [b, ...rest] = panels.map((p) => p.querySelector("[data-plot]")!.getBoundingClientRect());
    for (const r of rest) {
      expect(Math.abs(r.left - b!.left)).toBeLessThan(0.5);
      expect(Math.abs(r.right - b!.right)).toBeLessThan(0.5);
    }
    for (const p of panels) expect(p.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(overflowsSideways()).toBe(false);
  });

  it("cross the day a finger taps in any panel in all three, each readout inside its panel", async () => {
    const { sheet, panels } = await review();
    for (const [i, on] of [[1, "2026-11-05"], [2, "2026-11-08"], [0, "2026-11-04"]] as const) {
      const panel = panels[i]!;
      panel.scrollIntoView({ block: "center" });
      await settle();
      await tap({ x: dayX(panels, on), y: panel.getBoundingClientRect().top + 20 });
      expect(crossed(panels)).toEqual([on, on, on]);
      for (const p of panels) {
        const t = p.querySelector("[data-tip]")!.getBoundingClientRect(), c = p.getBoundingClientRect();
        expect(t.left >= c.left - 0.5 && t.right <= c.right + 0.5 && t.top >= c.top - 0.5 && t.bottom <= c.bottom + 0.5)
          .toBe(true);
      }
    }
    // a tap outside every panel lets go in all three
    const heading = sheet.querySelector(".nx-hist-h")!;
    heading.scrollIntoView({ block: "center" });
    await settle();
    const h = heading.getBoundingClientRect();
    await tap({ x: h.left + 10, y: h.top + h.height / 2 });
    expect(crossed(panels)).toEqual([undefined, undefined, undefined]);
  });

  it("scrub the days under a finger dragged sideways on SPX's path, in all three", async () => {
    const { panels } = await review();
    const spx = panels[2]!;
    spx.scrollIntoView({ block: "center" });
    await settle();
    const y = spx.getBoundingClientRect().top + 40;
    await drag({ x: dayX(panels, "2026-11-03"), y }, { x: dayX(panels, "2026-11-09"), y });
    expect(crossed(panels)).toEqual(["2026-11-09", "2026-11-09", "2026-11-09"]);
    expect(overflowsSideways()).toBe(false);
  });
});
