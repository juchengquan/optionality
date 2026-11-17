/** A watched row's history (#402) and a holding's days before entry, measured in a real layout
 *  engine at the desk's widths (272px inspector, 400px): the two plot areas aligned to the pixel,
 *  the threshold and the "entered" rule inside the plot with their labels, nothing overflowing, and
 *  the keys in either panel crossing the same day in both. The phone's 390 is
 *  `NextWatchHistory.iphone.test.tsx`'s; what each readout SAYS is the jsdom suite's
 *  (`NextWatchHistory.test.tsx`). */
import { cleanup, render } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import "../next.css";
import type { Holding, Samples } from "../shared/api";
import { HoldingHistory, WatchedHistory } from "../History";
import { HOLDINGS, QUOTES, SAMPLES, watchedFirst, watchSamplesAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

function serve(samples: Samples | null = null) {
  window.fetch = ((url: string) => {
    const path = String(url).replace(/^.*\/api/, "");
    const body = watchSamplesAnswer(path) ?? (/\/positions\/[^/]+\/samples$/.test(path) ? samples : null);
    return Promise.resolve({ ok: body !== null, status: body !== null ? 200 : 404,
      json: () => Promise.resolve(body ?? { detail: "no" }) });
  }) as unknown as typeof fetch;
}

async function panelsOf(): Promise<HTMLElement[]> {
  await settle();
  const panels = [".nx-bd", ".nx-iv"].map((sel) => document.querySelector<HTMLElement>(sel)!);
  expect(panels.every(Boolean), "both panels drawn").toBe(true);
  return panels;
}

const plotOf = (panel: HTMLElement) => panel.querySelector("[data-plot]")!.getBoundingClientRect();
const within = (r: DOMRect, box: DOMRect) =>
  r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;

function aligned(panels: HTMLElement[]) {
  const [b, ...rest] = panels.map(plotOf);
  for (const r of rest) {
    expect(Math.abs(r.left - b!.left)).toBeLessThan(0.5);
    expect(Math.abs(r.right - b!.right)).toBeLessThan(0.5);
  }
}

describe("a watched spread's history at the desk's widths", () => {
  for (const width of [272, 400]) {
    it(`at ${width}px: aligned, the threshold inside the plot, nothing overflowing`, async () => {
      await page.viewport(width + 40, 1400);
      serve();
      const entry = QUOTES.find((q) => q.id === "w-dec18")!;
      render(<div className="nx" style={{ width, padding: 0 }}><WatchedHistory entry={entry} privacy={false} /></div>);
      const panels = await panelsOf();
      aligned(panels);
      const bd = panels[0]!;
      const threshold = bd.querySelector("[data-level='threshold']")!;
      expect(within(threshold.querySelector("line")!.getBoundingClientRect(), plotOf(bd))).toBe(true);
      expect(within(threshold.querySelector("text")!.getBoundingClientRect(), bd.getBoundingClientRect())).toBe(true);
      expect(overflowsSideways()).toBe(false);
      // the keys in the value panel cross the same day in both
      bd.focus();
      await userEvent.keyboard("{End}");
      expect(panels.map((p) => p.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")))
        .toEqual(["2026-11-09", "2026-11-09"]);
    });
  }
});

describe("a holding's days before entry at the desk's widths", () => {
  for (const width of [272, 400]) {
    it(`at ${width}px: drawn faint before the "entered" rule, its label inside the chart`, async () => {
      await page.viewport(width + 40, 1400);
      serve(watchedFirst(SAMPLES["h-calls"]!));
      const holding = HOLDINGS.find((h) => h.id === "h-calls")! as Holding;
      render(<div className="nx" style={{ width, padding: 0 }}><HoldingHistory holding={holding} privacy={false} /></div>);
      const panels = await panelsOf();
      aligned(panels);
      const bd = panels[0]!;
      const faint = [...bd.querySelectorAll("[data-before-entry] circle")];
      expect(faint).toHaveLength(4);
      expect(Number(getComputedStyle(faint[0]!).opacity)).toBeLessThan(0.5);
      const entered = bd.querySelector("[data-entered]")!;
      const rule = entered.querySelector("line")!.getBoundingClientRect();
      // every faint day is to the left of where it was entered
      for (const c of faint) expect(c.getBoundingClientRect().left).toBeLessThan(rule.left);
      expect(within(entered.querySelector("text")!.getBoundingClientRect(), bd.getBoundingClientRect())).toBe(true);
      expect(overflowsSideways()).toBe(false);
    });
  }
});
