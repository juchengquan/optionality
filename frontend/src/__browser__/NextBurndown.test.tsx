/** The burndown on visx (#360) measured in a real layout engine, at the widths it is drawn at: the
 *  272px inspector, 400px, and 900px across a journal's closed trade — the phone's 390 is
 *  `NextBurndown.iphone.test.tsx`'s. Nothing cut by its SVG, no label on another, nothing pushed
 *  sideways, the crosshair's tooltip inside the chart and off the point it describes for EVERY day,
 *  the three charts still putting a day at one x, and the colours the tokens', light and dark.
 *  What the chart says and when is the jsdom suite's (`NextHistory.test.tsx`). */
import { cleanup, render } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import "../next/next.css";
import type { Holding, Samples } from "../shared/api";
import { HoldingHistory } from "../next/History";
import { HOLDINGS, SAMPLES } from "../testing/ownerBook";
import { overflowsSideways, settle, token } from "./nextBook";

afterEach(async () => {
  cleanup();
  await commands.colorScheme("light");
});

const holdingOf = (id: string) => HOLDINGS.find((h) => h.id === id)!;

/** The call spread's week with 5 Nov missing — the service down that whole day — so a missed day's
 *  hatched column is drawn too. */
const MISSED: Samples = {
  ...SAMPLES["h-calls"]!, samples: SAMPLES["h-calls"]!.samples.filter((s) => s.observed_on !== "2026-11-05"),
};

/** The samples served for `id`, or `samples` in their place. */
function serve(id: string, samples: Samples = SAMPLES[id]!) {
  window.fetch = ((url: string) => {
    const ok = String(url).endsWith(`/positions/${id}/samples`);
    const body = ok ? samples : { detail: "no" };
    return Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

async function draw(id: string, width: number,
  { samples, privacy = false }: { samples?: Samples; privacy?: boolean } = {}) {
  // room for the widest box, so the page's own width is never what pushes it sideways
  await page.viewport(Math.max(width, 400) + 40, 900);
  serve(id, samples);
  render(
    <div className="nx" style={{ width, padding: 0 }}>
      <HoldingHistory holding={holdingOf(id) as Holding} privacy={privacy} />
    </div>,
  );
  await settle();
  const chart = document.querySelector<HTMLElement>(".nx-bd")!;
  expect(chart, "the burndown is drawn").toBeTruthy();
  return { chart, svg: chart.querySelector("svg")! };
}

/** Every label cut by its own SVG, and every pair drawn over each other. */
function labelFaults(svg: SVGSVGElement): string[] {
  const box = svg.getBoundingClientRect();
  const labels = [...svg.querySelectorAll("text")].filter((t) => t.textContent)
    .map((t) => [t.textContent!, t.getBoundingClientRect()] as const);
  const out: string[] = [];
  for (const [what, r] of labels) {
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
      out.push(`${what} cut`);
    }
  }
  labels.forEach(([a, r], i) => labels.slice(i + 1).forEach(([b, q]) => {
    const over = r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1;
    if (over) out.push(`${a} / ${b}`);
  }));
  return out;
}

const inside = (r: DOMRect, box: DOMRect) =>
  r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;

/** Points the mouse at each day in turn, and says every day whose tooltip left the chart, or sat
 *  on the point it describes. */
async function tipFaults(chart: HTMLElement, svg: SVGSVGElement): Promise<string[]> {
  const out: string[] = [];
  const box = svg.getBoundingClientRect();
  const days = [...svg.querySelectorAll<SVGGElement>("[data-sample]")];
  for (const day of days) {
    const r = day.querySelector("circle")!.getBoundingClientRect();
    await userEvent.hover(svg, { position: { x: r.left + r.width / 2 - box.left, y: box.height / 2 } });
    const tip = chart.querySelector<HTMLElement>("[data-tip]");
    const on = day.dataset.sample!;
    if (!tip) { out.push(`${on}: no tooltip`); continue; }
    const crossed = chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair");
    if (crossed !== on) out.push(`${on}: crossed another day`);
    const t = tip.getBoundingClientRect();
    if (!inside(t, chart.getBoundingClientRect())) out.push(`${on}: tooltip outside the chart`);
    const p = chart.querySelector(".nx-bd-cross-day")!.getBoundingClientRect();
    const covers = t.left < p.right && p.left < t.right && t.top < p.bottom && p.top < t.bottom;
    if (covers) out.push(`${on}: tooltip on its point`);
  }
  return out;
}

describe("the burndown fits, and its tooltip stays inside it", () => {
  const cases = [["h-calls", undefined], ["h-puts", undefined], ["h-ic", undefined], ["h-calls", MISSED]] as const;
  for (const width of [272, 400, 900]) for (const [id, samples] of cases) for (const privacy of [false, true]) {
    const what = `${id}${samples ? " with a missed day" : ""}${privacy ? ", privacy on" : ""}`;
    it(`at ${width}px: ${what}`, async () => {
      const { chart, svg } = await draw(id, width, { samples, privacy });
      expect(svg.getBoundingClientRect().width).toBe(width);
      for (const s of document.querySelectorAll<SVGSVGElement>(".nx-hist svg")) {
        expect(labelFaults(s).join("; ")).toBe("");
      }
      expect((await tipFaults(chart, svg)).join("; ")).toBe("");
      expect(overflowsSideways()).toBe(false);
    });
  }
});

describe("the tooltip's measured height", () => {
  /** Twenty days whose costs sweep the plot from top to bottom and back, every other one recorded
   *  that evening — so at 272px every other tooltip carries a reason wrapped over two lines, and
   *  some day sits wherever a guessed height would put it on top of its own point. */
  const SWEEP: Samples = {
    ...SAMPLES["h-calls"]!,
    samples: Array.from({ length: 20 }, (_, i) => {
      const on = new Date(Date.UTC(2026, 10, 3 + i)).toISOString().slice(0, 10);
      return {
        ...SAMPLES["h-calls"]!.samples[1]!, observed_on: on, dte: 45 - i,
        cost_to_close: 2 + 1.9 * Math.sin(i * 0.7), timing: i % 2 ? "close" : "after-close",
        observed_at: `${on} ${i % 2 ? "21:00:00" : "23:30:00"}+00:00`,
      };
    }),
  };

  it("keeps a two-line tooltip inside the 272px chart and off its point, wherever the day is", async () => {
    const { chart, svg } = await draw("h-calls", 272, { samples: SWEEP });
    // the reason does wrap there: taller than one line of 11px text
    const evening = svg.querySelector("[data-sample][data-timing='after-close'] circle")!.getBoundingClientRect();
    const box = svg.getBoundingClientRect();
    await userEvent.hover(svg, { position: { x: evening.left + evening.width / 2 - box.left, y: 10 } });
    expect(chart.querySelector(".nx-bd-tip-why")!.getBoundingClientRect().height).toBeGreaterThan(24);
    expect((await tipFaults(chart, svg)).join("; ")).toBe("");
  });
});

describe("the three charts put a day at one x (#327)", () => {
  for (const width of [272, 400, 900]) for (const privacy of [false, true]) {
    it(`at ${width}px${privacy ? ", privacy on" : ""}`, async () => {
      await draw("h-puts", width, { privacy });
      const centre = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      for (const [on, dte] of [["2026-11-03", 45], ["2026-11-06", 42], ["2026-11-09", 39]] as const) {
        const burndown = centre(document.querySelector(`[data-sample="${on}"] circle`));
        const iv = [...document.querySelectorAll(`[aria-label="IV by leg"] circle[data-dte="${dte}"]`)].map(centre);
        const spx = centre(document.querySelector(`circle[data-spx-day="${on}"]`));
        expect(iv.length).toBeGreaterThan(0);
        for (const x of [...iv, spx]) expect(Math.abs(x - burndown)).toBeLessThan(0.75);
      }
    });
  }
});

describe("a Stop beyond the scale", () => {
  it("is marked at the plot's top edge, inside the chart, rather than stretching the axis", async () => {
    const { svg } = await draw("h-puts", 272);
    const stop = svg.querySelector("[data-level='stop'][data-off='above']")!;
    expect(stop.textContent).toMatch(/^▲ stop \$/);
    const line = stop.querySelector("line")!.getBoundingClientRect();
    const plot = svg.querySelector("[data-grid]")!.getBoundingClientRect();
    expect(line.top).toBeCloseTo(plot.top, 0);
    // the plan, from the Entry at the open to nothing at expiry, uses the plot's height rather than
    // its bottom half, where a scale reaching up to the Stop at twice the Entry put it
    expect(svg.querySelector("[data-plan]")!.getBoundingClientRect().height).toBeGreaterThan(plot.height * 0.7);
  });
});

describe("its colours are the tokens', light and dark", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      const { chart, svg } = await draw("h-calls", 400);
      const nx = document.querySelector(".nx")!;
      const resolved = (name: string) => {
        // a token as the browser paints it: through a probe, since oklch() strings compare loosely
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        nx.appendChild(probe);
        const out = getComputedStyle(probe).color;
        probe.remove();
        return out;
      };
      const fill = (sel: string) => getComputedStyle(svg.querySelector(sel)!).fill;
      const stroke = (sel: string) => getComputedStyle(svg.querySelector(sel)!).stroke;
      // behind pace is shaded in the loss colour and ahead in the gain colour
      expect(fill(".nx-bd-behind")).toBe(resolved("--loss"));
      expect(fill(".nx-bd-ahead")).toBe(resolved("--gain"));
      expect(fill("[data-level='stop'] text")).toBe(resolved("--alarm"));
      expect(stroke("[data-level='stop'] line")).toBe(resolved("--alarm"));
      expect(fill("[data-level='target'] text")).toBe(resolved("--entry"));
      expect(stroke("[data-costs]")).toBe(resolved("--foreground"));
      expect(fill("[data-mark='off-close']")).toBe(resolved("--background"));
      // the gridlines are the border's, and quieter than the zero line
      expect(stroke(".nx-bd-grid")).toBe(resolved("--border"));
      // the tooltip, on the popover's surface, with its gap in the outcome colour
      const r = svg.querySelector("[data-sample='2026-11-09'] circle")!.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      await userEvent.hover(svg, { position: { x: r.left + r.width / 2 - box.left, y: 20 } });
      const tip = chart.querySelector<HTMLElement>("[data-tip]")!;
      expect(getComputedStyle(tip).backgroundColor).toBe(resolved("--popover"));
      expect(getComputedStyle(tip.querySelector("[data-outcome]")!).color).toBe(resolved("--loss"));
      expect(token(nx, "--loss")).not.toBe("");
    });
  }
});

describe("the gap to the plan", () => {
  /** What is painted halfway between two days, halfway between the cost line and the plan. */
  function between(svg: SVGSVGElement, a: string, b: string): string {
    const at = (on: string) => {
      const day = svg.querySelector(`[data-sample="${on}"] circle`)!;
      const r = day.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const [p, q] = [at(a), at(b)];
    const x = (p.x + q.x) / 2, cost = (p.y + q.y) / 2;
    // the plan's y at that x: where a vertical probe meets the plan's path, read off its points
    const plan = svg.querySelector<SVGPathElement>("[data-plan]")!;
    const m = plan.getScreenCTM()!;
    let best = { dx: Infinity, y: 0 };
    for (let i = 0, n = plan.getTotalLength(); i <= n; i += 0.5) {
      const pt = plan.getPointAtLength(i);
      const sx = m.a * pt.x + m.e, sy = m.d * pt.y + m.f;
      if (Math.abs(sx - x) < best.dx) best = { dx: Math.abs(sx - x), y: sy };
    }
    const hit = document.elementFromPoint(x, (cost + best.y) / 2);
    return hit?.getAttribute("class") ?? hit?.tagName ?? "nothing";
  }

  it("is shaded behind where the cost is above the plan, and ahead where it is below", async () => {
    // the call spread's week ran behind pace; the put spread's 5th to 6th ran ahead
    const calls = await draw("h-calls", 400);
    expect(between(calls.svg, "2026-11-07", "2026-11-08")).toMatch(/nx-bd-behind/);
    cleanup();
    const puts = await draw("h-puts", 400);
    expect(between(puts.svg, "2026-11-05", "2026-11-06")).toMatch(/nx-bd-ahead/);
  });
});

describe("a pointer", () => {
  it("scrubs with a finger sideways while a vertical swipe stays the page's", async () => {
    const { svg } = await draw("h-calls", 400);
    expect(getComputedStyle(svg).touchAction).toBe("pan-y");
  });

  it("is never stopped by the tooltip it moves over", async () => {
    const { chart, svg } = await draw("h-calls", 272);
    const box = svg.getBoundingClientRect();
    await userEvent.hover(svg, { position: { x: box.width / 2, y: box.height / 2 } });
    expect(getComputedStyle(chart.querySelector("[data-tip]")!).pointerEvents).toBe("none");
  });
});
