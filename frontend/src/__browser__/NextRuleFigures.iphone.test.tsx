/** A rule's every figure in the phone's sheet (#332), MEASURED under Playwright's iPhone profile:
 *  at 390px the list pushes nothing sideways, no figure is cut short or drawn over another, and the
 *  sheet's targets stay 44pt — with every figure served and with every one a dash and its reason.
 *  The behaviour is `__tests__/NextRuleFigures.test.tsx`'s.
 */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry } from "../shared/api";
import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

/* Served here and not from a helper beside `nextBook.ts`: only a test may import test support
   (check-test-support). Every route the page calls is answered, and every write refused. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

function serve(quotes: Entry[]): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const read = payoffAnswer(path) ?? samplesAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? quotes : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS
        : path === "/references" ? [] : null;
    if (body === null) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ detail: `${path} not served` }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** The widest a contract's figures get: every one served, at their widest plausible values. */
const FULL = {
  name: "SPXW 261231 8000.00C", bid_price: 1234.55, ask_price: 1236.95, mid_price: 1235.75,
  last_price: 1235.1, update_time: "2026-11-11 23:58:12+08:00", option_implied_volatility: 114.237,
  option_delta: -0.9912, option_gamma: -0.000123, option_theta: -12.0567, option_vega: -10.4321,
};

const book = (served: boolean) => QUOTES.map((q) => q.id === "w-lone"
  ? { ...q, quote: served ? FULL : { name: FULL.name } } as Entry
  : q.id === "w-dec18" && served
    ? { ...q, combo_greeks: { option_delta: -0.0512, option_gamma: -0.00031, option_theta: 10.731, option_vega: -11.284 } } as Entry
    : q);

const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>(".nx [data-ref]")].find((el) => el.dataset.ref === ref)!;

async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

/** Every control a finger has to hit, on the whole document: the sheet is drawn in a portal. */
function tooSmall(): string[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(button, select, input, a)")]
    .filter((el) => el.getClientRects().length > 0 && el.getAttribute("type") !== "hidden")
    .flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
        : [];
    });
}

/** Any figure cut short, drawn past the screen's edge, or over its neighbour. */
function misfits(list: HTMLElement): string[] {
  const edge = document.documentElement.clientWidth;
  const out: string[] = [];
  const figures = [...list.querySelectorAll<HTMLElement>("[data-figure]")];
  for (const f of figures) {
    for (const el of [f, ...f.querySelectorAll<HTMLElement>("dt, dd, .nx-figure-why")]) {
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > edge + 0.5) out.push(`${f.dataset.figure} ${el.tagName} past the edge`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${f.dataset.figure} ${el.tagName} cut: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    const r = f.getBoundingClientRect();
    for (const g of figures) {
      if (g === f) continue;
      const s = g.getBoundingClientRect();
      if (r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5) {
        out.push(`${f.dataset.figure} overlaps ${g.dataset.figure}`);
      }
    }
  }
  return out;
}

afterEach(cleanup);

describe("a rule's figures in the sheet, at 390px", () => {
  for (const [id, what] of [["w-lone", "a single contract"], ["w-dec18", "a watched spread"]] as const) {
    for (const served of [true, false]) {
      it(`${what}'s, ${served ? "every figure served" : "every figure a dash and its reason"}`, async () => {
        serve(book(served));
        render(<Next />);
        await settle();
        await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Book" }));
        await settle();
        expect(document.documentElement.clientWidth).toBe(390);
        await userEvent.click(within(card(id)).getByRole("button", { name: /details of/ }));
        const sheet = await screen.findByRole("dialog");
        await animationsDone();
        const figures = within(sheet).getByRole("group", { name: "figures" });
        expect(figures.querySelectorAll("[data-figure]").length).toBe(id === "w-lone" ? 10 : 5);
        expect(figures.querySelectorAll(".nx-figure-why").length).toBe(served ? 0 : id === "w-lone" ? 10 : 4);
        expect(misfits(figures)).toEqual([]);
        expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
        expect(overflowsSideways()).toBe(false);
        expect(tooSmall()).toEqual([]);
      });
    }
  }
});
