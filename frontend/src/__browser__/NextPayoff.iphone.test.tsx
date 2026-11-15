/** The payoff at expiry on visx (#396), MEASURED under Playwright's iPhone profile — touch,
 *  `isMobile`, a 390px screen: in a card's detail sheet and in the Add sheet's preview, six legs
 *  included. Every label inside the drawing and none on top of another, the readout by a tap, and
 *  its tooltip inside the chart and the screen. Runs in the suite's `iphone` instance only; the
 *  desk is `NextPayoff.test.tsx`.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { overflowsSideways, serveAdding, settle } from "./nextBook";
import { chartFaults, payoffIn, shown, tipFaults } from "./payoffMeasure";

afterEach(cleanup);

/* The owner-shaped book, served from this file: a non-test module may not import test support
   (`make check-test-support`). Every write is refused. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

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

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

/** A tap on the drawing at the x of `mark`, which cannot be aimed at itself (a rule has no width). */
async function tapAt(payoff: HTMLElement, mark: Element): Promise<void> {
  const svg = payoff.querySelector<SVGSVGElement>(".nx-payoff-chart svg")!;
  svg.scrollIntoView({ block: "center" });
  const [m, s] = [mark.getBoundingClientRect(), svg.getBoundingClientRect()];
  await userEvent.click(svg, { position: { x: m.left + m.width / 2 - s.left, y: s.height / 2 } } as never);
}

/** The screen's own box, which a sheet's tooltip must stay inside as well as the chart's. */
const screenBox = () => document.documentElement;

describe("in the detail sheet", () => {
  for (const [ref, what, be] of [["h-ic", "a held condor", "6295"], ["w-dec18", "a watched spread", "7147.6"]] as const) {
    it(`draws ${what}'s on visx across the sheet, every label clear, and reads out a tapped breakeven`, async () => {
      serveOwnerBook();
      render(<Next />);
      await settle();
      const card = [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref)!;
      await userEvent.click(within(card).getByRole("button", { name: /details of/ }));
      const sheet = await screen.findByRole("dialog");
      await animationsDone();
      const payoff = await payoffIn(sheet);
      expect(payoff.querySelector("svg")!.getBoundingClientRect().width).toBeGreaterThan(300);
      expect(chartFaults(payoff).join(" | ")).toBe("");
      await tapAt(payoff, payoff.querySelector(`[data-breakeven='${be}'] circle`)!);
      expect(shown(payoff)).toMatch(new RegExp(`^SPX ${be.replace(".", "\\.")}0? \\| .* \\| 0\\.00 pts`));
      expect(tipFaults(payoff, sheet)).toEqual([]);
      expect(tipFaults(payoff, screenBox())).toEqual([]);
      for (const k of [...payoff.querySelectorAll<SVGLineElement>("[data-strike]")]) {
        await tapAt(payoff, k);
        expect(shown(payoff), `at the strike ${k.dataset.strike}`).toMatch(new RegExp(`^SPX ${k.dataset.strike} \\|`));
        expect(tipFaults(payoff, sheet), `at the strike ${k.dataset.strike}`).toEqual([]);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }
});

describe("in the Add sheet's preview", () => {
  it("draws a six-leg combo's on visx, every leg named and every label clear, redrawn as a strike is typed", async () => {
    serveAdding({ status: 201, body: {} });
    render(<Next />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a spread or contract" });
    await animationsDone();
    await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
    for (let i = 2; i < 6; i++) await userEvent.click(within(sheet).getByRole("button", { name: "spread 1: add a leg" }));
    for (const [i, k] of ["7150", "7100", "7050", "7000", "6950", "7700"].entries()) {
      await userEvent.fill(screen.getByLabelText(`spread 1, leg ${i + 1} strike`), k);
    }
    await userEvent.fill(screen.getByLabelText("spread 1 entry"), "3");
    const spread = sheet.querySelector<HTMLElement>('[data-spread="1"]')!;
    const payoff = await payoffIn(spread);
    const strikes = () => [...payoff.querySelectorAll("[data-strikes]")].map((t) => t.textContent).join(" ");
    await expect.poll(strikes).toBe("+P6950 +P7000 +P7050 +P7100 −P7150 +P7700");
    expect(payoff.querySelector("svg")!.getBoundingClientRect().width).toBeGreaterThan(300);
    expect(chartFaults(payoff).join(" | ")).toBe("");
    await tapAt(payoff, payoff.querySelector("[data-strike='7150']")!);
    expect(shown(payoff)).toMatch(/^SPX 7150 \| /);
    expect(tipFaults(payoff, spread)).toEqual([]);
    await userEvent.fill(screen.getByLabelText("spread 1, leg 6 strike"), "7750");
    await expect.poll(strikes).toBe("+P6950 +P7000 +P7050 +P7100 −P7150 +P7750");
    expect(chartFaults(payoff).join(" | ")).toBe("");
    expect(overflowsSideways()).toBe(false);
  });
});
