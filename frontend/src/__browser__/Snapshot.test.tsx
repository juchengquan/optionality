import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { SnapshotView } from "../SnapshotView";
import { COMBO_COLUMNS } from "../columns";
import type { Entry, Health, Holding } from "../api";

/** The image, measured end to end.
 *
 *  The one thing the feature promises that the screen cannot give you is EVERY ticked column:
 *  `useTableFit` drops columns against the viewport (ADR 0008), so at 390px the table on screen
 *  is a subset and a screenshot of it would be a subset too. These run AT 390px deliberately —
 *  the picture has to come out 1000px wide from a phone, or the feature is pointless.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "21:30:05" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const combo = (over: Record<string, unknown>) => ({
  field: "mid_price", threshold: 2.49, direction: "above", compare: "abs", triggered: false,
  strike_date: "2026-11-30", option_type: "CMB", dte: 41, fill: 61, scope: null, positions: [],
  cost_to_close: null, entry: null, pnl: null, schedule: null, quote: null,
  combo_value: -3.05, combo_greeks: { option_delta: -0.0123, option_vega: -0.18 },
  legs: [{ sign: -1, option_type: "CALL", strike: 8150 }, { sign: 1, option_type: "CALL", strike: 8200 }],
  ...over,
});
const rows = [
  combo({ id: "c1", code: "1130_8150" }),
  combo({ id: "c2", code: "1120_IC_7100_8200", triggered: true, fill: 100 }),
];

const held = [{
  id: "p1", name: "1120_IC_7100_8200", entry: 2.72, cost_to_close: 1.02, pnl: 1.7, dte: 41,
  opened_at: "2026-10-15", schedule: null,
  legs: [{ side: "short", option_type: "CALL", strike: 8150 }],
}];

function mockApi() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? rows
          : String(url).endsWith("/positions/values") ? held
            : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

/** Take the share sheet's place, so the File the device would have received is the File asserted
 *  on. Nothing else can see the image: it never touches the DOM and is never saved. */
function catchShare(): { file: () => File | null } {
  let caught: File | null = null;
  Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  Object.defineProperty(navigator, "share", {
    value: (data: { files: File[] }) => { caught = data.files[0]!; return Promise.resolve(); },
    configurable: true,
  });
  return { file: () => caught };
}

async function decode(file: File): Promise<{ w: number; h: number; at: (x: number, y: number) => string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((done, fail) => {
    img.onload = done;
    img.onerror = () => fail(new Error("the PNG did not decode"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return {
    w: img.naturalWidth,
    h: img.naturalHeight,
    at: (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]},${d[3]}`;
    },
  };
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

describe("saving the page as an image", () => {
  it("comes out at least 1000px wide from a 390px phone, at 2×", async () => {
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi();
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();

    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const png = await decode(shared.file()!);
    // Anything near 390 would mean the live page was captured and the figures cropped to
    // whatever that width could hold.
    // 1000 CSS px at pixelRatio 2, as a FLOOR: the stage grows where the figures need it (the
    // 13-column combo table measures 1012px with this data) and never shrinks to the device.
    expect(png.w, `image ${png.w}×${png.h}`).toBeGreaterThanOrEqual(2000);
    expect(png.h, "an image with no height is a blank file").toBeGreaterThan(100);
  });

  it("is not blank where the page has colour", async () => {
    // the html2canvas failure mode, asserted on the delivered file rather than on the node:
    // oklch backgrounds and the fill gradient either arrive or the picture is a white grid
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi();
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const png = await decode(shared.file()!);

    // every pixel of a 2000-wide image, sampled on a grid: a blank capture is uniform, and a
    // painted one is not. Counting distinct colours says so without naming any of them.
    const seen = new Set<string>();
    for (let y = 4; y < png.h; y += 17) {
      for (let x = 4; x < png.w; x += 29) seen.add(png.at(x, y));
    }
    expect(seen.size, `only ${seen.size} distinct colours — the picture is blank`)
      .toBeGreaterThan(3);
  });

  it("is still 1000px wide when the watchlist is short", async () => {
    // The floor, which the full-width case cannot test: with one row and most columns unticked
    // the content is far narrower than 1000px, and without a floor the image would shrink to it
    // — so two days' pictures would not be the same size, which is half of what makes a daily
    // record readable.
    await page.viewport(390, 900);
    const shared = catchShare();
    window.fetch = ((url: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          String(url).endsWith("/quotes") ? [rows[0]]
            // this case is about the image's WIDTH, so it holds nothing: the point is the floor
            : String(url).endsWith("/positions/values") ? []
              : String(url).endsWith("/monitors") ? [] : health),
      })) as unknown as typeof fetch;
    document.cookie = `ui_cols_combo=${COMBO_COLUMNS.slice(3).map((c) => c.key).join(".")};path=/`;
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const png = await decode(shared.file()!);

    expect(png.w, `a three-column table came out ${png.w}px wide`).toBe(2000);
    document.cookie = "ui_cols_combo=;path=/";
  });

  it("carries the holdings although the panel was never opened", async () => {
    // The feature's shape before #176: the picture cloned the holdings PANEL, so it carried the
    // entry, the cost to close and the P&L only if you had opened it first. Pressing the button on
    // a page you have not touched — which is how a daily record gets taken — gave you the picture
    // without the money in it.
    //
    // Asserted on the delivered FILE's dimensions rather than on the DOM: the section has to be
    // laid out before the capture, and a tree that is mounted but not laid out paints as nothing.
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi();
    render(<App />);
    await screen.findByText("1130_8150");
    expect(screen.queryByTestId("holdings"), "the panel is open before the press").toBeNull();

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();

    // the stage is still mounted at this point only in the failing case; assert on what the
    // picture is instead — with the section in, it is taller than without
    const png = await decode(shared.file()!);
    expect(png.h, `image ${png.w}x${png.h}`).toBeGreaterThan(600);
    expect(shared.file()!.size, "the file is implausibly small for a page with holdings")
      .toBeGreaterThan(10_000);
  });

  it("draws the held figures into the stage, panel shut", async () => {
    // the same claim, read off the stage itself, so a failure says WHICH figure is missing rather
    // than only that the image got shorter
    await page.viewport(390, 900);
    const stage = document.createElement("div");
    stage.className = "snapshot-stage";
    document.body.append(stage);
    render(
      <SnapshotView
        singles={[]} combos={rows as unknown as Entry[]} health={health as unknown as Health}
        fetchedAt="21:30:05" polledAt="21:30:07" grouping="none" reading="distance" band={80}
        hiddenSingle={new Set()} hiddenCombo={new Set()}
        holdings={held as unknown as Holding[]} holdingsError={null}
      />,
      { container: stage },
    );
    await new Promise((r) => setTimeout(r, 160));

    const figures = [...stage.querySelectorAll("dd")].map((d) => d.textContent);
    expect(figures, "the entry is not in the picture").toContain("2.72");
    expect(figures, "the P&L is not in the picture").toContain("1.70");
    // and it must not push the picture sideways, which is what a scroll box would hide
    for (const box of stage.querySelectorAll<HTMLElement>(".table-scroll")) {
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    }
    stage.remove();
  });

  it("draws every ticked column, with nothing left to scroll to", async () => {
    // A scroll box in a still image shows its first screenful and hides the rest silently, which
    // is this feature's whole reason for existing — so the stage must have nothing to scroll.
    await page.viewport(390, 900);
    const stage = document.createElement("div");
    stage.className = "snapshot-stage";
    document.body.append(stage);
    render(
      <SnapshotView
        singles={[]} combos={rows as unknown as Entry[]} health={health as unknown as Health}
        fetchedAt="21:30:05" polledAt="21:30:07" grouping="none" reading="distance" band={80}
        hiddenSingle={new Set()} hiddenCombo={new Set()}
        holdings={null} holdingsError={null}
      />,
      { container: stage },
    );
    await new Promise((r) => setTimeout(r, 160));

    const headers = [...stage.querySelectorAll("th")].map((h) => h.textContent);
    for (const c of COMBO_COLUMNS) {
      expect(headers, `"${c.label}" is not in the picture`).toContain(c.label);
    }
    for (const box of stage.querySelectorAll<HTMLElement>(".table-scroll")) {
      expect(box.scrollWidth, "the table is clipped inside a scroll box")
        .toBeLessThanOrEqual(box.clientWidth + 1);
    }
    stage.remove();
  });
});
