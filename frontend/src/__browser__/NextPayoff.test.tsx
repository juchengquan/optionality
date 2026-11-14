/** The payoff at expiry on visx (#396), MEASURED on the desk in a real layout engine: in the
 *  inspector from the narrowest desk to a wide one, and in the add form's preview. Every label
 *  inside the drawing and none on top of another, the crosshair's readout by a real mouse and by
 *  the keys, and its tooltip inside the chart wherever the pointer is. The phone's half is
 *  `NextPayoff.iphone.test.tsx`; the behaviour is the jsdom suite's (`__tests__/NextPayoff.test.tsx`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import type { Payoff } from "../shared/api";
import { holding, HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, side, volAnswer } from "../testing/ownerBook";
import { serveAdding, settle } from "./nextBook";
import { chartFaults, payoffIn, pointAt, said, tipFaults } from "./payoffMeasure";

afterEach(() => {
  cleanup();
  document.cookie = "ui_privacy=;path=/;max-age=0";
});

/* The owner-shaped book, served to the page. Here and not in a helper module beside `nextBook.ts`:
   only a test may import test support (check-test-support). Every write refused. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** A six-leg holding, its legs 50 points apart: more names than a 272px inspector has room for on
 *  one line. Its payoff worked out as the service would, the corners and the slopes beyond. */
const SIX = holding("h-six", { name: "1231_SIX", strike_date: "2026-12-31", entry: 3,
  legs: [side("long", "PUT", 6950), side("long", "PUT", 7000), side("long", "PUT", 7050),
         side("long", "PUT", 7100), side("short", "PUT", 7150), side("short", "CALL", 7700)] });
function sixPayoff(): Payoff {
  const pnl = (s: number) => SIX.legs.reduce((sum, l) => {
    const worth = l.option_type === "CALL" ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
    return sum + (l.side === "long" ? worth : -worth);
  }, 3);
  const ks = SIX.legs.map((l) => l.strike).sort((a, b) => a - b);
  return { at_strikes: ks.map((k) => ({ spx: k, pnl: pnl(k) })), slope_below: -3, slope_above: -1,
    breakevens: [], max_profit: null, max_loss: null };
}

function serveOwnerBook(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const read = (path === "/positions/h-six/payoff" ? sixPayoff() : null)
      ?? payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? [...HOLDINGS, SIX] : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

async function inspector(width: number, id: string): Promise<HTMLElement> {
  await page.viewport(width, 900);
  serveOwnerBook();
  render(<Next />);
  await settle();
  fireEvent.click(within(rowOf(id)).getByRole("button", { name: /./ }));
  await settle();
  return document.querySelector<HTMLElement>(".nxd-inspector")!;
}

describe("in the desk's inspector", () => {
  for (const width of [900, 1280, 2560]) {
    for (const [id, what, be] of [["h-ic", "a held condor", "6295"], ["w-dec18", "a watched spread", "7147.6"]] as const) {
      it(`${what}'s, at ${width}px: on visx, every label clear, the readout by mouse inside the chart`, async () => {
        const insp = await inspector(width, id);
        const payoff = await payoffIn(insp);
        const svg = payoff.querySelector<SVGSVGElement>("svg")!;
        expect(svg.getBoundingClientRect().width).toBeGreaterThan(200);
        expect(chartFaults(payoff)).toEqual([]);
        // a real mouse over the breakeven's dot lands on the breakeven: nothing made, nothing lost
        await pointAt(payoff, payoff.querySelector(`[data-breakeven='${be}'] circle`)!);
        expect(said(payoff)).toMatch(new RegExp(`^at expiry with SPX at ${be.replace(".", "\\.")}0?, .*: 0\\.00 pts`));
        expect(tipFaults(payoff, insp)).toEqual([]);
        // at either end of the drawing the tooltip still stays inside it
        for (const k of [...payoff.querySelectorAll<SVGLineElement>("[data-strike]")]) {
          await pointAt(payoff, k);
          expect(tipFaults(payoff, insp), `at the strike ${k.dataset.strike}`).toEqual([]);
        }
        await userEvent.unhover(svg);
      });
    }
  }

  it("names six legs 50 points apart on two lines in the narrowest inspector, every one clear", async () => {
    const insp = await inspector(900, "h-six");
    const payoff = await payoffIn(insp);
    const names = [...payoff.querySelectorAll<SVGTextElement>("[data-strikes]")];
    expect(names.map((t) => t.textContent).join(" ").split(" ").sort())
      .toEqual(["+P6950", "+P7000", "+P7050", "+P7100", "−C7700", "−P7150"]);
    expect(new Set(names.map((t) => t.getAttribute("y"))).size).toBeGreaterThan(1);
    expect(chartFaults(payoff)).toEqual([]);
  });

  it("steps along SPX with the keys, from SPX's price", async () => {
    const insp = await inspector(1280, "h-ic");
    const payoff = await payoffIn(insp);
    const chart = within(payoff).getByRole("group", { name: /payoff at expiry by SPX price/ });
    chart.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(said(payoff)).toBe("at expiry with SPX at 6900.50, at SPX now: +5.00 pts per contract · +$1,000");
    await userEvent.keyboard("{End}");
    expect(said(payoff)).toMatch(/: -45\.00 pts per contract · -\$9,000$/);
    expect(tipFaults(payoff, insp)).toEqual([]);
  });

  it("hides the $ under privacy and keeps the points", async () => {
    document.cookie = "ui_privacy=on;path=/";
    const insp = await inspector(900, "h-ic");
    const payoff = await payoffIn(insp);
    await pointAt(payoff, payoff.querySelector("[data-strike='7400']")!);
    expect(said(payoff)).toBe("at expiry with SPX at 7400, 499.50 above SPX now: +5.00 pts per contract · $•••");
    expect(payoff.textContent).not.toMatch(/\$\d/);
    expect(chartFaults(payoff)).toEqual([]);
  });
});

describe("in the add form's preview", () => {
  for (const width of [900, 1440]) {
    it(`is drawn on visx at ${width}px, every label clear, and redrawn as a strike is typed`, async () => {
      await page.viewport(width, 900);
      serveAdding({ status: 201, body: {} });
      render(<Next />);
      await settle();
      await userEvent.click(screen.getByRole("button", { name: "add" }));
      await userEvent.fill(screen.getByLabelText("spread 1, leg 1 strike"), "7150");
      await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7100");
      await userEvent.fill(screen.getByLabelText("spread 1 entry"), "1.50");
      const spread = document.querySelector<HTMLElement>('[data-spread="1"]')!;
      const payoff = await payoffIn(spread);
      const strikes = () => [...payoff.querySelectorAll("[data-strikes]")].map((t) => t.textContent).join(" ");
      await expect.poll(strikes).toBe("+P7100 −P7150");
      expect(chartFaults(payoff)).toEqual([]);
      await pointAt(payoff, payoff.querySelector("[data-strike='7100']")!);
      expect(said(payoff)).toBe("at expiry with SPX at 7100: -48.50 pts");
      expect(tipFaults(payoff, spread)).toEqual([]);
      await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7050");
      await expect.poll(strikes).toBe("+P7050 −P7150");
      expect(chartFaults(payoff)).toEqual([]);
    });
  }
});
