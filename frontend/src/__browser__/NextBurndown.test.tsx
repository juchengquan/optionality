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
    return Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(ok ? samples : { detail: "no" }) });
  }) as unknown as typeof fetch;
}

async function draw(id: string, width: number, { samples, privacy = false }: { samples?: Samples; privacy?: boolean } = {}) {
  // room for the widest box, so the page's own width is never what pushes it sideways
  await page.viewport(Math.max(width, 400) + 40, 900);
  serve(id, samples);
  render(<div className="nx" style={{ width, padding: 0 }}><HoldingHistory holding={holdingOf(id) as Holding} privacy={privacy} /></div>);
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
    if (r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1) out.push(`${a} / ${b}`);
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
    if (chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair") !== on) out.push(`${on}: crossed another day`);
    const t = tip.getBoundingClientRect();
    if (!inside(t, chart.getBoundingClientRect())) out.push(`${on}: tooltip outside the chart`);
    const p = chart.querySelector(".nx-bd-cross-day")!.getBoundingClientRect();
    if (t.left < p.right && p.left < t.right && t.top < p.bottom && p.top < t.bottom) out.push(`${on}: tooltip on its point`);
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
      for (const s of document.querySelectorAll<SVGSVGElement>(".nx-hist svg")) expect(labelFaults(s).join("; ")).toBe("");
      expect((await tipFaults(chart, svg)).join("; ")).toBe("");
      expect(overflowsSideways()).toBe(false);
    });
  }
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
