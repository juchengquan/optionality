/** "Where SPX was against my strikes" (#298, ADR 0023): for a holding, SPX's price on each
 *  Daily sample against its strikes, from the samples route's `spx` — in the desk's inspector and in
 *  the phone's holding sheet. Behaviour only: what is drawn from what was served, and above all
 *  that a day stored without SPX's price is a GAP and never a point at zero. That the chart fits is
 *  measured by the browser suites. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Samples } from "../shared/api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { spxRange, spxRuns } from "../next/spxdays";
import { SpxPath, spxGutter } from "../next/SpxPath";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, SAMPLES, samplesAnswer, volAnswer } from "../testing/ownerBook";

let asked: string[] = [];
let samples: (path: string) => Samples | null = samplesAnswer;

beforeEach(() => {
  asked = [];
  samples = samplesAnswer;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    // the inspector asks for exactly three things: the holding's samples, its payoff and its split
    const body = /\/samples$/.test(path) ? samples(path) : payoffAnswer(path) ?? volAnswer(path);
    return Promise.resolve(body
      ? { ok: true, status: 200, json: () => Promise.resolve(body) }
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: false, privacy: false, entryStyle: "opportunity", ...over,
  };
}

const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

function inspect(id: string, name: string, over: Partial<BookProps> = {}) {
  render(<DeskBook {...props(over)} />);
  fireEvent.click(within(deskRow(id)).getByRole("button", { name }));
  return screen.getByRole("complementary", { name: `inspector: ${name}` });
}

const chartOf = (root: HTMLElement) => within(root).findByRole("group", { name: "SPX against the strikes" });

const withSpx = (id: string, spx: (number | null)[]): Samples => ({
  ...SAMPLES[id]!, samples: SAMPLES[id]!.samples.map((s, i) => ({ ...s, spx: spx[i] ?? null })),
});

describe("the days, as runs", () => {
  it("breaks the line at a day stored without SPX's price, rather than drawing it at zero", () => {
    const runs = spxRuns(SAMPLES["h-puts"]!.samples);
    expect(runs.map((r) => r.map((d) => d.spx))).toEqual([[6812.4, 6840.1], [6871.25, 6871.25, 6880, 6895.75]]);
    expect(runs.flat().every((d) => d.spx > 0)).toBe(true);
  });

  it("breaks it at a day with no row at all, as the burndown does", () => {
    const s = SAMPLES["h-calls"]!.samples;
    const runs = spxRuns([s[0]!, s[1]!, s[4]!]);
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
  });

  it("has no runs when no day carries SPX's price", () => {
    expect(spxRuns(withSpx("h-ic", [null, null]).samples)).toEqual([]);
  });

  it("ranges over the strikes, SPX's days and SPX now — never down to a missing day's zero", () => {
    const [lo, hi] = spxRange(SAMPLES["h-puts"]!.samples, [6400, 6350], 6900.5);
    expect(lo).toBeLessThan(6350);
    expect(lo).toBeGreaterThan(6000);
    expect(hi).toBeGreaterThan(6900.5);
  });
});

describe("in the desk's inspector, outside the session", () => {
  it("draws each day's SPX against the holding's strikes, a gap where a day has none", async () => {
    const insp = inspect("h-puts", "1218_P6400");
    const chart = await chartOf(insp);
    const days = [...chart.querySelectorAll<SVGElement>("[data-spx-day]")].map((d) => d.dataset.spxDay);
    expect(days).toEqual(["2026-11-03", "2026-11-04", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(chart.querySelectorAll("polyline[data-spx-run]")).toHaveLength(2);
    expect(chart.querySelector('[data-strike="6400"]')!.getAttribute("data-side")).toBe("short");
    expect(chart.querySelector('[data-strike="6350"]')!.getAttribute("data-side")).toBe("long");
    // every point drawn sits inside the plot: a missing day mapped to zero would fall far below it
    const svg = chart.querySelector("svg")!;
    const height = Number(svg.getAttribute("height"));
    for (const c of chart.querySelectorAll<SVGCircleElement>("circle[data-spx-day]")) {
      const cy = Number(c.getAttribute("cy"));
      expect(cy).toBeGreaterThan(0);
      expect(cy).toBeLessThan(height);
    }
    expect(within(chart).getByText(/1 day stored without SPX's price: a gap, never zero/)).toBeTruthy();
  });

  it("marks SPX now, from the valuation's own batch, on today's DTE", async () => {
    const chart = await chartOf(inspect("h-puts", "1218_P6400"));
    expect(chart.querySelector("[data-spx-now]")!.textContent).toContain("6900.50");
  });

  it("says why there is no line when no day carries SPX's price, and draws no point", async () => {
    samples = (path) => (path.includes("h-ic") ? withSpx("h-ic", [null, null]) : samplesAnswer(path));
    const chart = await chartOf(inspect("h-ic", "1231_IC"));
    expect(chart.querySelectorAll("[data-spx-day]")).toHaveLength(0);
    expect(chart.querySelectorAll("polyline")).toHaveLength(0);
    expect(within(chart).getByText(/no day carries SPX's price/)).toBeTruthy();
  });

  it("draws every strike of a 4-leg condor, and its one stored day as a point", async () => {
    const chart = await chartOf(inspect("h-ic", "1231_IC"));
    expect([...chart.querySelectorAll<SVGElement>("[data-strike]")].map((g) => g.dataset.strike).sort())
      .toEqual(["6250", "6300", "7400", "7450"]);
    expect(chart.querySelectorAll("[data-spx-day]")).toHaveLength(1);
  });

  it("reads the samples once: the chart shares the burndown's answer", async () => {
    await chartOf(inspect("h-puts", "1218_P6400"));
    expect(asked.filter((a) => a.endsWith("/samples"))).toEqual(["GET /positions/h-puts/samples"]);
  });

  it("is not drawn in session, where the history is shut until opened", () => {
    const insp = inspect("h-puts", "1218_P6400", { session: true });
    expect(within(insp).queryByRole("group", { name: "SPX against the strikes" })).toBeNull();
  });
});

describe("a holding with two legs on one strike", () => {
  it("names each leg on its own line: an iron fly's short put and short call never print as one", () => {
    // short P7000 and short C7000 share a strike: their names are pushed apart, not laid on each other
    const fly = { ...HOLDINGS[0]!, id: "h-fly", name: "1218_IF7000", legs: [
      { side: "short", option_type: "PUT", strike: 7000 }, { side: "short", option_type: "CALL", strike: 7000 },
      { side: "long", option_type: "PUT", strike: 6950 }, { side: "long", option_type: "CALL", strike: 7050 },
    ] } as typeof HOLDINGS[number];
    const { container } = render(
      <SpxPath served={SAMPLES["h-puts"]!} holding={fly} span={45} gutters={{ L: spxGutter(fly), R: 10 }} />);
    const ys = [...container.querySelectorAll<SVGTextElement>("[data-strike] text")]
      .map((t) => [t.textContent, Number(t.getAttribute("y"))] as const);
    expect(ys.map(([name]) => name).sort()).toEqual(["C7000", "C7050", "P6950", "P7000"]);
    const at = Object.fromEntries(ys);
    expect(Math.abs(at["P7000"]! - at["C7000"]!)).toBeGreaterThanOrEqual(14);
    const sorted = ys.map(([, y]) => y).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(14);
  });
});

describe("on the phone, outside the session", () => {
  it("draws it in the holding's sheet, whose history opens with it (#374)", async () => {
    render(<PhoneBook {...props()} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^details of / })[0]!);
    const charts = await screen.findAllByRole("group", { name: "SPX against the strikes" });
    expect(charts.length).toBeGreaterThan(0);
    expect(charts[0]!.querySelectorAll("[data-spx-day]").length).toBeGreaterThan(0);
  });
});
