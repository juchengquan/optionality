/** The holding's two history panels — the burndown and the IV chart — on ONE crosshair (#395),
 *  measured in a real layout engine at the desk's widths (272px inspector, 400px, a 900px journal
 *  trade): the two plot areas aligned to the pixel, a mouse or the keys in either panel crossing the
 *  same x in both with each readout inside its own panel and off its point, and the IV panel's
 *  colours the tokens', light and dark. The phone's 390 is
 *  `NextHistoryCross.iphone.test.tsx`'s; what each readout SAYS is the jsdom suite's
 *  (`NextHistory.test.tsx`). */
import { cleanup, render, waitFor } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import "../next.css";
import type { Holding, Samples } from "../shared/api";
import { HoldingHistory } from "../History";
import { HOLDINGS, SAMPLES } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(async () => {
  cleanup();
  await commands.colorScheme("light");
});

const holdingOf = (id: string) => HOLDINGS.find((h) => h.id === id)! as Holding;

function serve(id: string, samples: Samples = SAMPLES[id]!) {
  window.fetch = ((url: string) => {
    const ok = String(url).endsWith(`/positions/${id}/samples`);
    return Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(ok ? samples : { detail: "no" }) });
  }) as unknown as typeof fetch;
}

/** The two panels, in order: the burndown, the IV chart. */
async function draw(id: string, width: number, privacy = false) {
  // tall enough that no panel is ever scrolled to: a hover that scrolls the page moves the panels
  // under a mouse already placed, and Chrome's catch-up boundary events then let go of the day
  await page.viewport(Math.max(width, 400) + 40, 1400);
  serve(id);
  render(<div className="nx" style={{ width, padding: 0 }}><HoldingHistory holding={holdingOf(id)} privacy={privacy} /></div>);
  await settle();
  const panels = [".nx-bd", ".nx-iv"].map((sel) => document.querySelector<HTMLElement>(sel)!);
  expect(panels.every(Boolean), "both panels drawn").toBe(true);
  expect(document.querySelector(".nx-spxp"), "no SPX panel").toBeNull();
  return panels;
}

const plotOf = (panel: HTMLElement) => panel.querySelector("[data-plot]")!.getBoundingClientRect();
const ruleX = (panel: HTMLElement) => {
  const r = panel.querySelector("[data-crosshair] line")!.getBoundingClientRect();
  return r.left + r.width / 2;
};
const inside = (r: DOMRect, box: DOMRect) =>
  r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;

describe("the two plot areas line up to the pixel", () => {
  for (const width of [272, 400, 900]) for (const id of ["h-calls", "h-puts", "h-ic"]) for (const privacy of [false, true]) {
    it(`at ${width}px: ${id}${privacy ? ", privacy on" : ""}`, async () => {
      const panels = await draw(id, width, privacy);
      const [b, ...rest] = panels.map(plotOf);
      for (const r of rest) {
        expect(Math.abs(r.left - b!.left)).toBeLessThan(0.5);
        expect(Math.abs(r.right - b!.right)).toBeLessThan(0.5);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }
});

describe("a mouse in either panel crosses the day in both", () => {
  for (const width of [272, 900]) {
    it(`at ${width}px, every day from every panel, each readout inside its panel and off its point`, async () => {
      const panels = await draw("h-calls", width);
      const faults: string[] = [];
      const days = [...panels[0]!.querySelectorAll<SVGGElement>("[data-sample]")];
      for (const [p, panel] of panels.entries()) {
        const svg = panel.querySelector("svg")!;
        for (const day of days) {
          const box = svg.getBoundingClientRect();
          const c = day.querySelector("circle")!.getBoundingClientRect();
          // half way down the plot, as the burndown's own suite points: a hover 6px from the panel's
          // top was intermittently lost under the whole suite's load (cause not pinned down)
          await userEvent.hover(svg, { position: { x: c.left + c.width / 2 - box.left, y: box.height / 2 } });
          const on = day.dataset.sample!;
          // a pointermove is a continuous event, which React renders on its next frame rather than at
          // once: under the whole suite's load that frame came after the check, so wait for it
          await waitFor(() => {
            if (panels.some((o) => o.querySelector("[data-crosshair]")?.getAttribute("data-crosshair") !== on)) {
              throw new Error("not crossed yet");
            }
          }, { timeout: 1000 }).catch(() => undefined);
          for (const [q, other] of panels.entries()) {
            const crossed = other.querySelector("[data-crosshair]")?.getAttribute("data-crosshair");
            if (crossed !== on) { faults.push(`${on} from panel ${p}: panel ${q} crossed ${crossed}`); continue; }
            if (Math.abs(ruleX(other) - (c.left + c.width / 2)) > 0.75) faults.push(`${on}: panel ${q}'s rule off its x`);
            const tip = other.querySelector("[data-tip]");
            if (!tip) { faults.push(`${on}: panel ${q} has no readout`); continue; }
            const t = tip.getBoundingClientRect();
            if (!inside(t, other.getBoundingClientRect())) faults.push(`${on}: panel ${q}'s readout outside it`);
            for (const pt of other.querySelectorAll(".nx-bd-cross-day")) {
              const r = pt.getBoundingClientRect();
              if (t.left < r.right && r.left < t.right && t.top < r.bottom && r.top < t.bottom) {
                faults.push(`${on}: panel ${q}'s readout on its point`);
              }
            }
          }
        }
      }
      expect(faults.join("; ")).toBe("");
      // leaving for the page lets go in both
      await userEvent.hover(document.querySelector(".nx-hist-h")!);
      expect(panels.map((p) => p.querySelector("[data-crosshair]"))).toEqual([null, null]);
    });
  }
});

describe("the keys in either panel step the crosshair in both", () => {
  it("from each panel's one tab stop", async () => {
    const panels = await draw("h-puts", 400);
    for (const panel of panels) {
      panel.focus();
      expect(document.activeElement).toBe(panel);
      await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
      const xs = panels.map(ruleX);
      expect(panels.map((p) => p.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")))
        .toEqual(["2026-11-05", "2026-11-05"]);
      for (const x of xs) expect(Math.abs(x - xs[0]!)).toBeLessThan(0.75);
      await userEvent.keyboard("{Escape}");
    }
    // the tab order runs through the two in turn
    panels[0]!.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(panels[1]);
  });
});

describe("the IV panel's colours are the tokens', light and dark", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      const [, iv] = await draw("h-calls", 400);
      const nx = document.querySelector(".nx")!;
      const resolved = (name: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        nx.appendChild(probe);
        const out = getComputedStyle(probe).color;
        probe.remove();
        return out;
      };
      const style = (root: HTMLElement, sel: string) => getComputedStyle(root.querySelector(sel)!);
      expect(style(iv!, "[data-side='short'] [data-iv-run]").stroke).toBe(resolved("--foreground"));
      expect(style(iv!, "[data-side='long'] [data-iv-run]").stroke).toBe(resolved("--muted-foreground"));
      expect(style(iv!, ".nx-bd-grid").stroke).toBe(resolved("--border"));
      // a day that is not the close is hollow here too
      expect(style(iv!, "circle[data-mark='off-close']").fill).toBe(resolved("--background"));
      // the crosshair and the readouts, as the burndown's
      for (const panel of [iv!]) {
        const svg = panel.querySelector("svg")!;
        const box = svg.getBoundingClientRect();
        await userEvent.hover(svg, { position: { x: box.width - 30, y: 6 } });
        expect(style(panel, "[data-crosshair] line").stroke).toBe(resolved("--foreground"));
        expect(style(panel, "[data-tip]").backgroundColor).toBe(resolved("--popover"));
        expect(style(panel, "[data-tip]").color).toBe(resolved("--popover-foreground"));
        expect(style(panel, "[data-tip]").pointerEvents).toBe("none");
      }
      // a recorded day, whose readout names each leg (today's valuation has no IV to name them by)
      const svg = iv!.querySelector("svg")!, box = svg.getBoundingClientRect();
      const day = iv!.querySelector("circle[data-dte='39']")!.getBoundingClientRect();
      await userEvent.hover(svg, { position: { x: day.left + day.width / 2 - box.left, y: box.height / 2 } });
      expect(style(iv!, "[data-tip] .nx-leg-t[data-type='CALL']").color).toBe(resolved("--call"));
    });
  }
});
