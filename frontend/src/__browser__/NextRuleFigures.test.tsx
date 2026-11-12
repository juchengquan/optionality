/** A rule's every figure in the desk's inspector (#332), MEASURED: from a 900px desk to a 2560px
 *  one, the list fits the inspector — no figure cut short in its own cell, none drawn past the
 *  inspector's edge, the inspector scrolling nothing sideways — with every figure served and with
 *  every one a dash and its reason. The behaviour is `__tests__/NextRuleFigures.test.tsx`'s.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry } from "../api";
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

/** The book with w-lone priced in full, or with nothing, and w-dec18 with or without its greeks. */
const book = (served: boolean) => QUOTES.map((q) => q.id === "w-lone"
  ? { ...q, quote: served ? FULL : null } as Entry
  : q.id === "w-dec18" && served
    ? { ...q, combo_greeks: { option_delta: -0.0512, option_gamma: -0.00031, option_theta: 10.731, option_vega: -11.284 } } as Entry
    : q);

const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

/** Any figure cut short by its own cell, or drawn past the inspector's box. */
function misfits(insp: HTMLElement): string[] {
  const box = insp.getBoundingClientRect();
  const out: string[] = [];
  for (const f of insp.querySelectorAll<HTMLElement>("[data-figure]")) {
    for (const el of [f, ...f.querySelectorAll<HTMLElement>("dt, dd, .nx-figure-why")]) {
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${f.dataset.figure} ${el.tagName} past the edge`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${f.dataset.figure} ${el.tagName} cut: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    // nothing of one figure drawn over its neighbour's
    const r = f.getBoundingClientRect();
    for (const g of insp.querySelectorAll<HTMLElement>("[data-figure]")) {
      if (g === f) continue;
      const s = g.getBoundingClientRect();
      if (r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5) {
        out.push(`${f.dataset.figure} overlaps ${g.dataset.figure}`);
      }
    }
  }
  return out;
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("a rule's figures fit the inspector, from a 900px desk to a 2560px one", () => {
  for (const width of [900, 1280, 2560]) {
    for (const [id, what] of [["w-lone", "a single contract"], ["w-dec18", "a watched spread"]] as const) {
      for (const served of [true, false]) {
        it(`${what}'s at ${width}px, ${served ? "every figure served" : "every figure a dash and its reason"}`, async () => {
          await page.viewport(width, 900);
          serve(book(served));
          render(<Next />);
          await settle();
          fireEvent.click(screen.getByRole("button", { name: "Live" }));
          await settle();
          expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
          fireEvent.click(within(rowOf(id)).getAllByRole("button")[0]!);
          await settle();
          const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
          const figures = within(insp).getByRole("group", { name: "figures" });
          // worth nothing unless the list is the long one, and each dash carries its words
          expect(figures.querySelectorAll("[data-figure]").length).toBe(id === "w-lone" ? 10 : 5);
          expect(figures.querySelectorAll(".nx-figure-why").length).toBe(served ? 0 : id === "w-lone" ? 10 : 4);
          expect(misfits(insp)).toEqual([]);
          expect(insp.scrollWidth).toBeLessThanOrEqual(insp.clientWidth);
          expect(insp.getBoundingClientRect().right).toBeLessThanOrEqual(document.documentElement.clientWidth);
          expect(overflowsSideways()).toBe(false);
        });
      }
    }
  }
});
