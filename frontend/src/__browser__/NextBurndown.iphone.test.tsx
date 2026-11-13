/** The burndown on visx (#360) on the phone, under Playwright's iPhone profile — touch, `isMobile`,
 *  a 390px screen: on the phone's REVIEW page, where it is a holding's main chart, inside the screen
 *  with its tooltip inside the chart for every day; and touched with a real finger (Chrome's own
 *  touch events, through CDP), where a horizontal drag scrubs the days and a vertical swipe still
 *  scrolls the page. The desk's widths are `NextBurndown.test.tsx`'s. */
/// <reference types="@vitest/browser/providers/playwright" />
import { cdp, userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, settle } from "./nextBook";
import type { Samples } from "../shared/api";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";

afterEach(cleanup);

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** A holding's days with a leg's quantity corrected on its fourth (#359): the three before it summed
 *  under the quantities first recorded. */
function corrected(served: Samples): Samples {
  const on = served.samples[3]?.observed_on ?? served.samples.at(-1)!.observed_on;
  return {
    ...served, qty_corrected_at: `${on} 13:00:00+08:00`,
    samples: served.samples.map((s) => ({ ...s, before_correction: s.observed_on < on })),
  };
}

/** The owner-shaped book, every write refused (as `NextPhone.iphone.test.tsx` serves it); every
 *  holding's days with a quantity corrected where `correcting`. */
function serveOwnerBook(correcting = false): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const days = samplesAnswer(path);
    const read = payoffAnswer(path) ?? (days && correcting ? corrected(days) : days) ?? volAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** The phone's REVIEW page for the first holding, scrolled so its burndown is on the screen. */
async function review(correcting = false) {
  serveOwnerBook(correcting);
  render(<Next />);
  await settle();
  const views = screen.getByRole("navigation", { name: "views" });
  await userEvent.click(within(views).getByRole("button", { name: "Review" }));
  await settle();
  const page1 = document.querySelector<HTMLElement>("[data-page][data-ref]")!;
  const chart = page1.querySelector<HTMLElement>(".nx-bd")!;
  chart.scrollIntoView({ block: "center" });
  await settle();
  return { page1, chart, svg: chart.querySelector("svg")! };
}

const centreOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A finger: down at `from`, moved to `to` in `steps` even steps a frame apart — as a hand moves,
 *  not all at once, which Chrome read as an erratic fling — and up. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  const send = (type: string, at?: { x: number; y: number }) => cdp().send("Input.dispatchTouchEvent", {
    type, touchPoints: at ? [{ x: Math.round(at.x), y: Math.round(at.y) }] : [],
  });
  await send("touchStart", from);
  for (let i = 1; i <= steps; i++) {
    await pause(16);
    await send("touchMove", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  }
  await pause(16);
  await send("touchEnd");
  await settle();
}

/** A finger tapped at a point: down and up, without moving. */
async function tap(at: { x: number; y: number }) {
  const point = [{ x: Math.round(at.x), y: Math.round(at.y) }];
  await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
  await pause(50);
  await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle();
}

const crossed = (chart: HTMLElement) => chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair");

describe("the burndown on the phone's REVIEW page", () => {
  it("draws a corrected quantity's rule and its faint days inside the screen, saying so for each (#359)", async () => {
    const { chart, svg } = await review(true);
    const box = svg.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    const marker = svg.querySelector("[data-corrected-on] text")!;
    const m = marker.getBoundingClientRect();
    expect(m.left).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(m.right).toBeLessThanOrEqual(box.right + 0.5);
    const faint = svg.querySelector<SVGGElement>("[data-before-correction]")!;
    const p = centreOf(faint.querySelector("circle")!);
    await userEvent.click(svg, { position: { x: p.x - box.left, y: 12 } });
    expect(chart.querySelector("[data-tip] [data-corrected]")?.textContent).toBe("summed before a leg's quantity was corrected");
    const t = chart.querySelector("[data-tip]")!.getBoundingClientRect(), c = chart.getBoundingClientRect();
    expect(t.left >= c.left - 0.5 && t.right <= c.right + 0.5 && t.top >= c.top - 0.5 && t.bottom <= c.bottom + 0.5).toBe(true);
    expect(within(chart.parentElement!).getByRole("status").textContent).toMatch(/summed before a leg's quantity was corrected$/);
    expect(overflowsSideways()).toBe(false);
  });

  it("is inside the screen, and its tooltip inside the chart and off its point, for every day", async () => {
    const { page1, chart, svg } = await review();
    const box = svg.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    expect(box.width).toBeGreaterThan(page1.querySelector(".nxp-card")!.getBoundingClientRect().width - 40);
    const faults: string[] = [];
    for (const day of page1.querySelectorAll<SVGGElement>("[data-sample]")) {
      const p = centreOf(day.querySelector("circle")!);
      await userEvent.click(svg, { position: { x: p.x - box.left, y: 12 } });
      const tip = chart.querySelector("[data-tip]");
      if (!tip) { faults.push(`${day.dataset.sample}: no tooltip`); continue; }
      const t = tip.getBoundingClientRect(), c = chart.getBoundingClientRect();
      if (t.left < c.left - 0.5 || t.right > c.right + 0.5 || t.top < c.top - 0.5 || t.bottom > c.bottom + 0.5) {
        faults.push(`${day.dataset.sample}: outside the chart`);
      }
      const q = chart.querySelector(".nx-bd-cross-day")!.getBoundingClientRect();
      const covers = t.left < q.right && q.left < t.right && t.top < q.bottom && q.top < t.bottom;
      if (covers) faults.push(`${day.dataset.sample}: on its point`);
    }
    expect(faults.join("; ")).toBe("");
    expect(overflowsSideways()).toBe(false);
  });

  it("scrubs the days under a finger dragged sideways, and keeps the last when it lifts", async () => {
    const { chart, page1 } = await review();
    const days = [...page1.querySelectorAll<SVGGElement>("[data-sample]")];
    const first = centreOf(days[0]!.querySelector("circle")!);
    const last = centreOf(days.at(-1)!.querySelector("circle")!);
    const y = chart.getBoundingClientRect().top + 60;
    const before = window.scrollY;
    const track = document.querySelector<HTMLElement>(".nxp-track")!;
    const across = track.scrollLeft;
    await drag({ x: first.x, y }, { x: last.x, y });
    expect(crossed(chart)).toBe(days.at(-1)!.dataset.sample);
    expect(page1.querySelector(".nx-hist-said")!.textContent).toMatch(/^9 Nov · 39 DTE/);
    // a sideways drag is the chart's: neither the page nor the pager of holdings moved under it
    expect(window.scrollY).toBe(before);
    expect(track.scrollLeft).toBe(across);
    expect(overflowsSideways()).toBe(false);
  });

  it("chooses a day on a tap, and lets go of it on a tap outside the chart", async () => {
    const { chart, page1 } = await review();
    const day = page1.querySelector<SVGGElement>("[data-sample='2026-11-05']")!;
    await tap({ x: centreOf(day.querySelector("circle")!).x, y: chart.getBoundingClientRect().top + 40 });
    expect(crossed(chart)).toBe("2026-11-05");
    expect(chart.querySelector("[data-tip]")).toBeTruthy();
    await tap(centreOf(page1.querySelector(".nx-hist-h")!));
    expect(crossed(chart)).toBeUndefined();
    expect(chart.querySelector("[data-tip]")).toBeNull();
  });

  it("lets a finger swiped up the chart scroll the page", async () => {
    const { chart, page1 } = await review();
    // a day chosen first, by a tap, is let go of by the scroll rather than carried up the screen
    const day = page1.querySelector<SVGGElement>("[data-sample='2026-11-05']")!;
    await tap({ x: centreOf(day.querySelector("circle")!).x, y: chart.getBoundingClientRect().top + 40 });
    expect(crossed(chart)).toBe("2026-11-05");
    const r = chart.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const before = window.scrollY;
    await drag({ x, y: r.bottom - 10 }, { x, y: r.bottom - 160 });
    await settle();
    expect(window.scrollY).not.toBe(before);
    // and a scroll is never a choice of day: nothing is crossed, and no tooltip is left behind
    expect(crossed(chart)).toBeUndefined();
    expect(chart.querySelector("[data-tip]")).toBeNull();
  });
});
