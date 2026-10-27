import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { toPng } from "html-to-image";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** Can this page be rasterized at all? The question the whole feature rests on.
 *
 *  Every colour in app.css is `oklch`, the top line uses `color-mix(in oklch, ...)` and every
 *  highlighted cell is a `linear-gradient` whose stop is the row's fill. html2canvas
 *  RE-IMPLEMENTS CSS painting and can paint none of that — it would hand back white or
 *  transparent cells exactly where the urgency is, and the only place that shows up is in an
 *  image already sent to someone. html-to-image wraps the node in an SVG foreignObject, so the
 *  real engine paints it; this proves that rather than trusting it.
 *
 *  The assertion is comparative on purpose: a fired row's cell must differ from a calm row's.
 *  If the backgrounds are dropped, both collapse to the same white and the difference vanishes —
 *  which no "is it non-transparent" check would catch, since white is opaque.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const combo = (over: Record<string, unknown>) => ({
  field: "mid_price", threshold: 2.49, direction: "above", compare: "abs",
  strike_date: "2026-11-30", option_type: "CMB", dte: 41, scope: null, positions: [],
  cost_to_close: null, entry: null, pnl: null, schedule: null, quote: null,
  combo_value: -3.05, combo_greeks: { option_delta: -0.0123, option_vega: -0.18 },
  legs: [{ sign: -1, option_type: "CALL", strike: 8150 }, { sign: 1, option_type: "CALL", strike: 8200 }],
  ...over,
});

const rows = [
  combo({ id: "m1", code: "1130_FIRED", triggered: true, fill: 100 }),
  combo({ id: "m2", code: "1130_CALM", triggered: false, fill: 12 }),
];

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? rows : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

/** The PNG, decoded back into pixels. A data URL that is merely non-empty proves nothing: a
 *  blank image of the right size is the exact failure being hunted. */
async function pixelsOf(dataUrl: string): Promise<{ at: (x: number, y: number) => string; w: number; h: number }> {
  const img = new Image();
  await new Promise((done, fail) => {
    img.onload = done;
    img.onerror = () => fail(new Error("the PNG did not decode"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  const ctx = canvas.getContext("2d")!;
  return {
    w: img.naturalWidth,
    h: img.naturalHeight,
    at: (x, y) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]},${d[3]}`;
    },
  };
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("rasterizing this page", () => {
  it("paints the oklch alarm colours, not a blank grid", async () => {
    await page.viewport(1100, 900);
    mockApi();
    render(<App />);
    await screen.findByText("1130_FIRED");
    await new Promise((r) => setTimeout(r, 200));

    const table = document.querySelector("table")!;
    const fired = [...table.querySelectorAll("tr")]
      .find((r) => r.className.includes("triggered"))!;
    const calm = [...table.querySelectorAll("tbody tr")]
      .find((r) => !r.className.includes("triggered"))!;
    expect(fired, "no fired row to compare").toBeTruthy();

    const box = table.getBoundingClientRect();
    const dataUrl = await toPng(table, { pixelRatio: 2 });
    const png = await pixelsOf(dataUrl);

    // the capture is the node at twice its size, which is what makes the figures sharp
    expect(png.w, `image ${png.w}x${png.h} against a ${Math.round(box.width)}px node`)
      .toBe(Math.round(box.width * 2));

    // a point in each row's LAST cell, which carries the row background and no gradient
    const sample = (row: Element) => {
      const cells = row.querySelectorAll("td");
      const cell = cells[cells.length - 1]!.getBoundingClientRect();
      return png.at((cell.left + cell.width / 2 - box.left) * 2, (cell.top + cell.height / 2 - box.top) * 2);
    };
    const firedPx = sample(fired);
    const calmPx = sample(calm);

    expect(firedPx, "the fired row came out transparent").not.toMatch(/,0$/);
    expect(firedPx, `fired ${firedPx} is the same as calm ${calmPx} — the backgrounds were dropped`)
      .not.toBe(calmPx);
  });
});
