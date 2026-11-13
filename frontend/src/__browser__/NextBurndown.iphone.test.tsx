/** The burndown on visx (#360) on the phone, under Playwright's iPhone profile — touch, `isMobile`,
 *  a 390px screen: on the phone's REVIEW page, where it is a holding's main chart, inside the screen
 *  with its tooltip inside the chart for every day; and touched with a real finger (Chrome's own
 *  touch events, through CDP), where a horizontal drag scrubs the days and a vertical swipe still
 *  scrolls the page. The desk's widths are `NextBurndown.test.tsx`'s. */
import { cdp, userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, settle } from "./nextBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";

afterEach(cleanup);

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** The owner-shaped book, every write refused (as `NextPhone.iphone.test.tsx` serves it). */
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

/** The phone's REVIEW page for the first holding, scrolled so its burndown is on the screen. */
async function review() {
  serveOwnerBook();
  render(<Next />);
  await settle();
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Review" }));
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

/** A finger: down at the first point, through the rest, and up. */
async function drag(points: { x: number; y: number }[]) {
  const send = (type: string, at?: { x: number; y: number }) => cdp().send("Input.dispatchTouchEvent", {
    type, touchPoints: at ? [{ x: Math.round(at.x), y: Math.round(at.y) }] : [],
  });
  await send("touchStart", points[0]);
  for (const p of points.slice(1)) await send("touchMove", p);
  await send("touchEnd");
  await settle();
}

describe("the burndown on the phone's REVIEW page", () => {
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
      if (t.left < q.right && q.left < t.right && t.top < q.bottom && q.top < t.bottom) faults.push(`${day.dataset.sample}: on its point`);
    }
    expect(faults.join("; ")).toBe("");
    expect(overflowsSideways()).toBe(false);
  });

  it("scrubs the days under a finger dragged sideways, and keeps the last when it lifts", async () => {
    const { chart, page1 } = await review();
    const days = [...page1.querySelectorAll<SVGGElement>("[data-sample]")];
    const [first, last] = [centreOf(days[0]!.querySelector("circle")!), centreOf(days.at(-1)!.querySelector("circle")!)];
    const y = chart.getBoundingClientRect().top + 60;
    const before = window.scrollY;
    await drag([{ x: first.x, y }, { x: (first.x + last.x) / 2, y }, { x: last.x, y }]);
    expect(chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")).toBe(days.at(-1)!.dataset.sample);
    expect(page1.querySelector(".nx-hist-said")!.textContent).toMatch(/^9 Nov · 39 DTE/);
    // a sideways drag is the chart's: the page did not move under it
    expect(window.scrollY).toBe(before);
    expect(overflowsSideways()).toBe(false);
  });

  it("lets a finger swiped up the chart scroll the page", async () => {
    const { chart } = await review();
    const r = chart.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const before = window.scrollY;
    await drag([{ x, y: r.bottom - 10 }, { x, y: r.bottom - 60 }, { x, y: r.bottom - 110 }, { x, y: r.bottom - 160 }]);
    await settle();
    expect(window.scrollY).toBeGreaterThan(before);
  });
});
