/** The price map panel (#298) and the history's "where SPX was against my strikes" on the desk, MEASURED
 *  in a real layout engine at 900, 1280 and 2560px:
 *  - opening the panel leaves the table's measured fit exactly as it was (ADR 0008, `useDeskFit`):
 *    the same columns, inspector shut and open, and nothing pushed sideways;
 *  - every label on the map is inside it and clear of every other, and SPX's line is on it;
 *  - picking a spread on the map picks its row, in a real browser too;
 *  - the SPX-by-day chart in the inspector's history keeps its labels inside and apart.
 *  The page is served the owner-shaped book, every route it calls answered explicitly. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { DeskBook } from "../next/desk/DeskBook";
import { SpxPath, spxGutter } from "../next/SpxPath";
import type { Entry } from "../shared/api";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, SAMPLES, samplesAnswer, volAnswer, served } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** Requests the page made that this suite does not answer: each one is a failure. */
let unanswered: string[] = [];

/** Watched put spreads crowding the 18 Dec lane: one on the held put spread's very strikes, one
 *  25 points inside it and one beside the watched 7150, so the lane must slot them into rows. */
const crowd = (id: string, short: number, long: number, delta: number): Entry => ({
  ...QUOTES.find((q) => q.id === "w-dec18")!, id, code: `1218_P${short}${id}`,
  legs: [{ sign: -1, option_type: "PUT", strike: short }, { sign: 1, option_type: "PUT", strike: long }],
  short_strikes: [served("2026-12-18", "PUT", short, delta, 38)],
} as Entry);
const CROWDED = [...QUOTES, crowd("c1", 6400, 6350, -0.21), crowd("c2", 6425, 6375, -0.23),
  crowd("c3", 7160, 7110, -0.18)];
let quotes: Entry[] = QUOTES;

function serve(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    // the payoff (POST for a draft, GET for a holding) and REVIEW's samples: reads, answered
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return ok(read);
    if (method === "GET") {
      if (path === "/quotes") return ok(quotes);
      if (path === "/monitors") return ok(MONITORS);
      if (path === "/health") return ok(health);
      if (path === "/positions/values") return ok(HOLDINGS);
      // every holding on record, which the closed trades' fold reads (#296, #373): none is closed
      if (path === "/positions") return ok(HOLDINGS);
      if (path === "/references") return ok([]);
    }
    unanswered.push(`${method} ${path}`);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ detail: "not answered" }) });
  }) as unknown as typeof fetch;
}

async function show(width: number, mode: "Live" | "Review" = "Live") {
  await page.viewport(width, 1000);
  serve();
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: mode }));
  await settle();
}

beforeEach(() => {
  unanswered = [];
  quotes = QUOTES;
  document.cookie = "ui_price_map=;path=/";
});

afterEach(async () => {
  cleanup();
  document.cookie = "ui_price_map=;path=/";
  await page.viewport(1280, 900);
  expect(unanswered).toEqual([]);
});

const shown = () => [...document.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col!);
const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const toggle = () => screen.getByRole("button", { name: "price map" });
const panel = () => screen.queryByRole("region", { name: "price map" });

const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
  && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const overlap = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** Every text in an SVG inside it, and none over another. */
function labelFaults(svg: SVGSVGElement, what: string): string[] {
  const box = svg.getBoundingClientRect();
  const texts = [...svg.querySelectorAll<SVGTextElement>("text")].filter((t) => t.textContent);
  const out: string[] = [];
  if (texts.length === 0) out.push(`${what}: no labels at all`);
  for (const t of texts) {
    if (!inside(t.getBoundingClientRect(), box)) out.push(`${what}: "${t.textContent}" outside`);
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (overlap(texts[i]!.getBoundingClientRect(), texts[j]!.getBoundingClientRect())) {
        out.push(`${what}: "${texts[i]!.textContent}" over "${texts[j]!.textContent}"`);
      }
    }
  }
  return out;
}

describe("the price map panel", () => {
  for (const width of [900, 1280, 2560]) {
    it(`at ${width}px, opening it leaves the table's fit as it was, inspector shut and open`, async () => {
      await show(width);
      const shut = shown();
      fireEvent.click(toggle());
      await settle();
      expect(panel()).not.toBeNull();
      expect(shown()).toEqual(shut);
      expect(overflowsSideways()).toBe(false);

      fireEvent.click(within(rowOf("h-ic")).getByRole("button", { name: /./ }));
      await settle();
      const inspecting = shown();
      fireEvent.click(toggle());
      await settle();
      expect(panel()).toBeNull();
      expect(shown()).toEqual(inspecting);
      fireEvent.click(toggle());
      await settle();
      expect(shown()).toEqual(inspecting);
      expect(overflowsSideways()).toBe(false);
    });

    it(`at ${width}px, every label is inside the map and clear of every other, SPX's line on it`, async () => {
      await show(width);
      fireEvent.click(toggle());
      await settle();
      const svg = panel()!.querySelector("svg")!;
      expect(labelFaults(svg, `map at ${width}px`)).toEqual([]);
      expect(inside(svg.getBoundingClientRect(), panel()!.getBoundingClientRect())).toBe(true);
      const line = svg.querySelector("[data-spx-line] line")!.getBoundingClientRect();
      expect(inside(line, svg.getBoundingClientRect())).toBe(true);
      // each band inside the map too
      for (const b of svg.querySelectorAll("[data-band]")) {
        expect(inside(b.getBoundingClientRect(), svg.getBoundingClientRect())).toBe(true);
      }
    });
  }

  for (const width of [900, 1280, 2560]) {
    it(`at ${width}px, a crowded lane slots its spreads into rows, every label still apart`, async () => {
      quotes = CROWDED;
      await show(width);
      fireEvent.click(toggle());
      await settle();
      const svg = panel()!.querySelector("svg")!;
      expect(svg.querySelectorAll('[data-lane="2026-12-18"] [data-spread]')).toHaveLength(6);
      expect(labelFaults(svg, `crowded map at ${width}px`)).toEqual([]);
      // and no two bars drawn over each other
      const bars = [...svg.querySelectorAll<SVGRectElement>('[data-lane="2026-12-18"] .nxm-bar')]
        .map((b) => b.getBoundingClientRect());
      const touching = bars.flatMap((a, i) => bars.slice(i + 1).filter((b) => overlap(a, b)));
      expect(touching).toEqual([]);
      // nor a spread's label over another spread's bar
      const spreads = [...svg.querySelectorAll<SVGGElement>("[data-spread]")];
      const crossed = spreads.flatMap((one) => [...one.querySelectorAll(".nxm-label")].flatMap((label) =>
        spreads.filter((other) => other !== one && overlap(label.getBoundingClientRect(),
          other.querySelector(".nxm-bar")!.getBoundingClientRect()))
          .map((other) => `${label.textContent} over ${other.dataset.spread}'s bar`)));
      expect(crossed).toEqual([]);
    });
  }

  /** The map's drawing as wide as its box: measured, not a first guess kept. */
  const fits = () => {
    const box = panel()!.querySelector<HTMLElement>(".nxm-box")!;
    const svg = box.querySelector("svg")!;
    return [Math.round(svg.getBoundingClientRect().width), box.clientWidth];
  };

  it("opened from the cookie on an empty page, is drawn at its box's width once the book arrives", async () => {
    document.cookie = "ui_price_map=open;path=/";
    await show(2560);
    expect(panel()).not.toBeNull();
    const [svg, box] = fits();
    expect(box).toBeGreaterThan(2000);
    expect(svg).toBe(box);
  });

  it("is drawn at its box's width after its lanes go to none and come back", async () => {
    await page.viewport(2560, 1000);
    document.cookie = "ui_price_map=open;path=/";
    const book = { quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
      mode: "live" as const, session: true, privacy: false, entryStyle: "opportunity" as const };
    const view = render(<DeskBook {...book} quotes={[]} holdings={[]} />);
    await settle();
    view.rerender(<DeskBook {...book} />);
    await settle();
    expect(fits()[0]).toBe(fits()[1]);
    view.rerender(<DeskBook {...book} quotes={[]} holdings={[]} />);
    await settle();
    await page.viewport(1400, 1000);
    await settle();
    view.rerender(<DeskBook {...book} />);
    await settle();
    const [svg, box] = fits();
    expect(box).toBeLessThanOrEqual(1400);
    expect(box).toBeGreaterThan(1000);
    expect(svg).toBe(box);
  });

  it("picks a row from the map, and the map marks the row picked in the table", async () => {
    await show(1280);
    fireEvent.click(toggle());
    await settle();
    const spread = (id: string) => panel()!.querySelector<SVGGElement>(`[data-spread="${id}"]`)!;
    await page.elementLocator(spread("w-dec18").querySelector(".nxm-hit")!).click();
    await settle();
    expect(rowOf("w-dec18").hasAttribute("data-selected")).toBe(true);
    expect(screen.getByRole("complementary", { name: /^inspector: / })).toBeTruthy();
    fireEvent.click(within(rowOf("h-puts")).getByRole("button", { name: /./ }));
    await settle();
    expect(spread("h-puts").getAttribute("aria-pressed")).toBe("true");
    expect(spread("w-dec18").getAttribute("aria-pressed")).toBe("false");
  });
});

/** A Sunday, 12:00 New York: outside the session, where the inspector's history starts open
 *  whichever mode is on screen (#372). In session it starts shut. */
const OUTSIDE_THE_SESSION = new Date("2026-11-15T17:00:00Z");

describe("where SPX was against the strikes, in the inspector outside the session", () => {
  beforeEach(() => { vi.setSystemTime(OUTSIDE_THE_SESSION); });
  for (const width of [900, 1280, 2560]) {
    it(`at ${width}px, keeps its labels inside it and apart, for a spread and a 4-leg condor`, async () => {
      await show(width, "Review");
      for (const id of ["h-puts", "h-ic"]) {
        fireEvent.click(within(rowOf(id)).getByRole("button", { name: /./ }));
        await settle();
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
        const chart = within(insp).getByRole("group", { name: "SPX against the strikes" });
        const svg = chart.querySelector("svg")!;
        // the inspector scrolls, and since #372 the history's toggle sits above the chart: it is
        // measured where a reader scrolls it to
        svg.scrollIntoView({ block: "nearest" });
        expect(labelFaults(svg, `${id} at ${width}px`)).toEqual([]);
        expect(inside(svg.getBoundingClientRect(), insp.getBoundingClientRect())).toBe(true);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }
});

describe("the history's three charts share their plot", () => {
  beforeEach(() => { vi.setSystemTime(OUTSIDE_THE_SESSION); });
  for (const width of [1280, 2560]) for (const privacy of [false, true]) {
    it(`at ${width}px${privacy ? ", privacy on" : ""}, put a day at the same x in each`, async () => {
      if (privacy) document.cookie = "ui_privacy=on;path=/";
      try {
        await show(width, "Review");
        fireEvent.click(within(rowOf("h-puts")).getByRole("button", { name: /./ }));
        await settle();
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
        const centre = (el: Element | null) => {
          const r = el!.getBoundingClientRect();
          return r.left + r.width / 2;
        };
        // 4 Nov, 44 DTE: a day each of the three charts draws
        const burndown = centre(insp.querySelector('[data-sample="2026-11-04"] circle'));
        const iv = [...insp.querySelectorAll('[aria-label="IV by leg"] circle[data-dte="44"]')].map(centre);
        const spx = centre(insp.querySelector('circle[data-spx-day="2026-11-04"]'));
        expect(iv.length).toBeGreaterThan(0);
        for (const x of [...iv, spx]) expect(Math.abs(x - burndown)).toBeLessThan(0.75);
      } finally {
        document.cookie = "ui_privacy=;path=/";
      }
    });
  }
});

describe("where SPX was, for an iron fly", () => {
  it("prints the short put and the short call that share a strike apart, inside the chart", async () => {
    const fly = { ...HOLDINGS[0]!, id: "h-fly", name: "1218_IF7000", legs: [
      { side: "short", option_type: "PUT", strike: 7000 }, { side: "short", option_type: "CALL", strike: 7000 },
      { side: "long", option_type: "PUT", strike: 6950 }, { side: "long", option_type: "CALL", strike: 7050 },
    ] } as typeof HOLDINGS[number];
    render(<div style={{ width: 360 }}>
      <SpxPath served={SAMPLES["h-puts"]!} holding={fly} span={45} gutters={{ L: spxGutter(fly), R: 10 }} />
    </div>);
    await settle();
    const svg = screen.getByRole("group", { name: "SPX against the strikes" }).querySelector("svg")!;
    expect(labelFaults(svg, "iron fly")).toEqual([]);
  });
});
