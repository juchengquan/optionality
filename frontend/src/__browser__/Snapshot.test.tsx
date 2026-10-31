import { cleanup, render, screen } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { SnapshotView } from "../SnapshotView";
import { COMBO_COLUMNS } from "../columns";
import type { Entry, Health, Holding } from "../api";
import { AREA_LIMIT, SIDE_LIMIT, captureBox } from "../snapshot";

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

/** A single-leg row, which the combos above cannot stand in for: the picture draws the two tables
 *  one under the other, and the overlap below was reported as the combo table landing on the
 *  single-leg one. */
const single = (over: Record<string, unknown>) => ({
  ...combo({}), option_type: "CALL", legs: null, combo_value: null, combo_greeks: null,
  quote: {
    name: "SPX 1130 C8150", mid_price: 2.2, bid_price: 2.1, ask_price: 2.3,
    option_delta: -0.0123, option_gamma: 0.0001, option_theta: -0.4, option_vega: -0.18,
    option_implied_volatility: 12.3, update_time: "2026-10-30 15:59:00",
  },
  ...over,
});
const bothKinds = [
  single({ id: "s1", code: "1130_c8150" }),
  single({ id: "s2", code: "1130_c8200", triggered: true, fill: 100 }),
  ...rows,
];

const held = [{
  id: "p1", name: "held-condor", entry: 2.72, cost_to_close: 1.02, pnl: 1.7, dte: 41,
  opened_at: "2026-10-15", schedule: null,
  legs: [{ side: "short", option_type: "CALL", strike: 8150 }],
}];

function mockApi(watchlist: unknown[] = rows) {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? watchlist
          : String(url).includes("/positions/values") ? held
            : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
}

/** The stage's measurements, taken WHILE it is up.
 *
 *  It is mounted only for the duration of the shot, so everything measured about the picture has to
 *  be read between the press and the file arriving. A first version read it afterwards and got null.
 */
async function measureStage(): Promise<{ width: number; height: number; table: number; client: number }> {
  await expect.poll(() => document.querySelector(".snapshot"), { timeout: 8000 }).toBeTruthy();
  const snap = document.querySelector<HTMLElement>(".snapshot")!;
  const table = snap.querySelector<HTMLElement>("table");
  return {
    width: snap.scrollWidth, height: snap.scrollHeight,
    table: table?.offsetWidth ?? 0, client: snap.clientWidth,
  };
}

/** Narrow the stage from OUTSIDE the app, which is the whole point: the press must survive a stage
 *  that is not as wide as its widest table, however it got that way. A stylesheet is the only way
 *  in — the app owns the node, as it does on the device. */
function squeezeTheStage(px: number): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `.snapshot { width: ${px}px !important; min-width: 0 !important }`;
  document.head.append(style);
  return style;
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
    // Read off the STAGE while the shot is in progress, not off the delivered file. Height and
    // byte count were the first version of this assertion and both pass with the holdings absent:
    // a 13-column table is already 600px tall and 10KB. What has to be true is that the figures
    // are in the tree being painted, laid out, at the moment it is painted.
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi();
    render(<App />);
    await screen.findByText("1130_8150");
    expect(screen.queryByTestId("holdings"), "the panel is open before the press").toBeNull();

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();

    const staged = () => document.querySelector<HTMLElement>(".snapshot-stage .snapshot");
    await expect.poll(() => staged()?.textContent ?? "", { timeout: 8000 })
      .toContain("held-condor");
    const stage = staged()!;
    const figures = [...stage.querySelectorAll("dd")].map((d) => d.textContent);
    expect(figures, "the entry is not in the picture").toContain("2.72");
    expect(figures, "the P&L is not in the picture").toContain("1.70");
    // laid out, not merely mounted: an unlaid-out tree paints as nothing, which is the one
    // failure shape that looks like success
    expect(stage.getBoundingClientRect().height).toBeGreaterThan(100);

    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const png = await decode(shared.file()!);
    expect(png.h, `image ${png.w}x${png.h}`).toBeGreaterThan(100);
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

  it("keeps every column in the image even when the stage is narrower than the table", async () => {
    // The test above asserts that the engine SIZES the stage to its widest table, which both
    // engines do: `width: max-content` carries the table's width up through the scroll box. It
    // passed throughout the bug it was meant to catch, because it checks the happy sizing rather
    // than the consequence of losing it — and the owner's pictures came back with the right-hand
    // figures gone, the cell text clipped and the bottom missing, all three at once.
    //
    // This states the consequence instead, THROUGH THE BUTTON: the stage is squeezed from outside
    // the app, which is what any sizing difference amounts to, and the picture must still contain
    // the whole table. Measured before the fix: 161px of a 13-column combo table outside the image
    // in Chromium, 204px in WebKit. Going through the press is what makes this cover the capture
    // itself — a first version called `captureBox` directly and a mutation sweep showed it proved
    // nothing about the app, which could still ask for the offset size and lose the overflow.
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi();
    const style = squeezeTheStage(900);
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    const stage = await measureStage();
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();

    expect(stage.table, "the squeeze did not actually overflow the stage")
      .toBeGreaterThan(stage.client);

    const png = await decode(shared.file()!);
    const ratio = captureBox(stage.width, stage.height).pixelRatio;
    expect(png.w / ratio, `the table is ${stage.table}px and the image ${png.w / ratio}px`)
      .toBeGreaterThanOrEqual(stage.table);
    style.remove();
  });

  it("drops resolution rather than the bottom when the watchlist is long", async () => {
    // The other half of the same cause: a flat pixelRatio of 2 put the canvas over the area a
    // device will paint, and an oversized canvas is not refused — it is answered half-painted, so
    // the picture simply ends. Also through the press, for the same reason as above.
    await page.viewport(390, 900);
    const shared = catchShare();
    const many = Array.from({ length: 140 }, (_, i) =>
      ({ ...rows[0]!, id: `m${i}`, code: `1130_IC_${8000 + i}` }));
    mockApi(many);
    render(<App />);
    await screen.findByText("1130_IC_8000");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    const stage = await measureStage();
    await expect.poll(() => shared.file(), { timeout: 15000 }).toBeTruthy();

    const png = await decode(shared.file()!);
    // the page has to be tall enough that a flat 2 would have crossed the cap, or this asserts
    // nothing about the cap at all
    expect(stage.width * 2 * stage.height * 2, "the page is not tall enough to test this")
      .toBeGreaterThan(AREA_LIMIT);
    expect(png.w * png.h, `${png.w}x${png.h}`).toBeLessThanOrEqual(AREA_LIMIT);
    expect(Math.max(png.w, png.h)).toBeLessThanOrEqual(SIDE_LIMIT);
    // and the full extent is still in it, at fewer pixels per CSS pixel
    const ratio = captureBox(stage.width, stage.height).pixelRatio;
    expect(png.h / ratio).toBeGreaterThanOrEqual(stage.height - 2);
  });

  it("leaves the frozen column in its column rather than on top of the figures", async () => {
    // What the owner saw after #179, worded as the combo section overlapping the single-leg one.
    //
    // The cause is the fix above and nothing else. `th:first-child` is `position: sticky; left: 0`
    // so the name stays put while a row is swiped (app.css), and sticky resolves against the
    // nearest SCROLLING ancestor — which was `.table-scroll` until that box stopped clipping. The
    // page then became the scrollport, the stage sits at `left: -10000px` so the whole table is
    // far to the left of it, and every first cell was shoved as far right as its row allowed:
    // measured at x=873 in a 1016px row, painted over the last four columns.
    //
    // Measured on the stage mid-shot, through the press, because the offset the bug needs only
    // exists there. Nothing in a picture can be swiped, so the claim is simply that the column is
    // where the table put it.
    await page.viewport(390, 900);
    const shared = catchShare();
    mockApi(bothKinds);
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => document.querySelector(".snapshot"), { timeout: 8000 }).toBeTruthy();
    const snap = document.querySelector<HTMLElement>(".snapshot")!;
    const tables = [...snap.querySelectorAll("table")];
    expect(tables.length, "both tables are in the picture").toBe(2);
    for (const table of tables) {
      for (const row of table.querySelectorAll("tr")) {
        const cells = [...row.querySelectorAll<HTMLElement>("th, td")];
        if (cells.length < 2) continue;  // the group heading spans the row
        const first = cells[0]!.getBoundingClientRect();
        const second = cells[1]!.getBoundingClientRect();
        expect(first.left, `the frozen cell is ${Math.round(first.left - row.getBoundingClientRect().left)}px into its row`)
          .toBeCloseTo(row.getBoundingClientRect().left, 0);
        expect(first.right, "the frozen cell is painted over the next column")
          .toBeLessThanOrEqual(second.left + 1);
      }
    }
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
  });

  it("does not let the narrow-screen rules into the picture", async () => {
    // The overlap the owner reported twice, and the one thing in this feature that neither
    // Chromium nor desktop WebKit reproduces. Driven on the real page through Playwright's iPhone
    // profile — 393px, device pixel ratio 3, isMobile — the Combos table landed on top of the last
    // single-leg rows and "holdings" on top of the last combo row.
    //
    // The cause is not the capture. `@media (max-width: 60rem)` keys off the VIEWPORT, so the
    // phone's rules reach the stage although the stage is 1161px wide: the identity column becomes
    // `white-space: normal`. In the live layout the name still fits on one line and the row
    // measures 33px — and html-to-image copies every computed style onto its clone, that 33px
    // included. Inside the SVG the cell is laid out a hair narrower, the name takes a second line,
    // and the row cannot grow: the overflow spills out of the table and onto whatever is under it.
    // One wrapped name is enough; there is no cap to cross and nothing in the file to say so.
    //
    // So the claim is the rule, not the pixels: a picture is never narrow, and nothing in it may
    // wrap for a reason that belongs to the screen it was taken on. Asserted on BOTH trees at a
    // phone viewport — the page keeps the wrap, the picture does not — because scoping is half of
    // it; the live table needs that rule (`th:first-child`, app.css) and keeps it.
    await page.viewport(390, 900);
    mockApi(bothKinds);
    render(<App />);
    await screen.findByText("1130_8150");

    const live = document.querySelector<HTMLElement>(".table-scroll td:first-child")!;
    expect(getComputedStyle(live).whiteSpace, "the live page lost its narrow-screen wrap")
      .toBe("normal");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => document.querySelector(".snapshot"), { timeout: 8000 }).toBeTruthy();
    const snap = document.querySelector<HTMLElement>(".snapshot")!;

    for (const cell of snap.querySelectorAll<HTMLElement>("td:first-child, th:first-child")) {
      expect(getComputedStyle(cell).whiteSpace, `"${cell.textContent}" may wrap in the picture`)
        .toBe("nowrap");
    }
  });

  it("gives the held figures the same four columns from any device", async () => {
    // The same cause, the harmless half, found while measuring the one above: the holdings grid is
    // `grid-cols-2 sm:grid-cols-4`, and `sm:` is a viewport query too — so the same page, pressed
    // on an iPad, put entry/cost to close/P&L/dte on one line and, pressed on a phone, on two.
    // Two pictures of one book that do not look alike are worth less than either.
    await page.viewport(390, 900);
    mockApi(bothKinds);
    render(<App />);
    await screen.findByText("1130_8150");

    (document.querySelector('[aria-label="save as image"]') as HTMLElement).click();
    await expect.poll(() => document.querySelector(".snapshot dl"), { timeout: 8000 }).toBeTruthy();
    const dl = document.querySelector<HTMLElement>(".snapshot dl")!;

    expect(getComputedStyle(dl).gridTemplateColumns.split(" ").length,
           "the picture's holdings follow the device's width").toBe(4);
  });
});
