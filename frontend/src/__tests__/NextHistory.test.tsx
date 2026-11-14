/** The burndown and the IV chart (#295, ADR 0023), drawn from `/positions/{id}/samples` in the
 *  desk's inspector and the phone's holding sheet: open from the start outside the session (#372,
 *  #374), on demand in it (#353). Behaviour only —
 *  what is asked for and when, what is drawn from what was served, what an off-close point says
 *  and what privacy hides. That the charts FIT is measured by the browser suite. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Holding, Samples } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { HistoryOnDemand } from "../HistoryOnDemand";
import { PhoneBook } from "../phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, SAMPLES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { legMarks } from "../testing/legs";

/** Every request the page made, as `METHOD path`. */
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const body = samplesAnswer(path) ?? payoffAnswer(path) ?? volAnswer(path);
    return Promise.resolve(body
      ? { ok: true, status: 200, json: () => Promise.resolve(body) }
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: false, privacy: false, entryStyle: "opportunity", ...over,
  };
}

/** Every route as before, but the samples answered with `samples`, or refused where it is null. The
 *  payoff is asked for in the same inspector, so a stub answering every path with samples would
 *  break it — the StrikeStrip suites' lesson. */
function serveSamples(samples: Samples | null) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const path = String(url).replace(/^.*\/api/, "");
    if (/\/samples$/.test(path)) {
      return Promise.resolve(samples
        ? { ok: true, status: 200, json: () => Promise.resolve(samples) }
        : { ok: false, status: 404, json: () => Promise.resolve({ detail: "position not found" }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer(path) ?? volAnswer(path)) });
  }));
}

const samplesAsked = () => asked.filter((a) => a.endsWith("/samples"));

const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

async function inspect(id: string, name: string, over: Partial<BookProps> = {}) {
  const view = render(<DeskBook {...props(over)} />);
  fireEvent.click(within(deskRow(id)).getByRole("button", { name }));
  const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
  return { view, insp };
}

const burndownOf = (root: HTMLElement) => within(root).findByRole("group", { name: "burndown" });
const ivOf = (root: HTMLElement) => within(root).findByRole("group", { name: "IV by leg" });

/** A pointer at a day's x — a mouse resting there unless said otherwise — offset by `by` pixels,
 *  which the crosshair snaps back to the day. jsdom lays nothing out, so the drawing's own x is the
 *  pointer's: its box is at 0 with no width. */
function pointAt(chart: HTMLElement, day: Element, { by = 0, type = "mouse" } = {}) {
  const x = Number(day.querySelector("circle")!.getAttribute("cx")) + by;
  const svg = chart.querySelector(".nx-bd svg")!;
  fireEvent.pointerMove(svg, { clientX: x, pointerType: type });
}
const dayOf = (chart: HTMLElement, selector: string) => chart.querySelector(`[data-sample]${selector}`)!;
const tipOf = (chart: HTMLElement) => chart.querySelector<HTMLElement>("[data-tip]");

/** The x and y of each point a path or polyline joins. */
function corners(el: Element | null): [number, number][] {
  const text = el?.getAttribute("d") ?? el?.getAttribute("points") ?? "";
  return [...text.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("the burndown, in the desk's inspector outside the session", () => {
  it("asks for the holding's samples once, by its id, and draws a point for every day", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });

  it("draws the planned decay through the served points and computes no curve of its own", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-plan]")).toBeTruthy());
    const plan = corners(chart.querySelector("[data-plan]"));
    // one corner per served DTE from the open to expiry, and nothing interpolated between them
    expect(plan).toHaveLength(SAMPLES["h-calls"]!.plan.length);
    // the served figures are on a √ curve, so equal DTE steps are UNEQUAL height steps: a straight
    // line drawn by the browser between the ends would make them equal
    const drops = plan.slice(1).map(([, y], i) => y - plan[i]![1]);
    expect(Math.abs(drops[0]! - drops.at(-1)!)).toBeGreaterThan(1);
  });

  it("draws the Target, the Stop and Manage-by", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-level='stop']")).toBeTruthy());
    expect(chart.querySelector("[data-level='target']")).toBeTruthy();
    expect(chart.querySelector("[data-level='manage-by']")?.textContent).toContain("manage-by 21");
    // money, at the contract size the valuation served (100): a 2.00 credit's target is 1.00
    expect(chart.querySelector("[data-level='target']")?.textContent).toContain("$100");
  });

  it("marks a point that is not a close, and says why on hover", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    const timing = [...chart.querySelectorAll<SVGElement>("[data-sample]")].map((p) => p.dataset.timing);
    expect(timing).toEqual(["after-close", "close", "close", "unrecorded", "close", "before-open", "close"]);
    const evening = chart.querySelector<SVGElement>("[data-sample][data-timing='after-close']")!;
    // drawn apart from a close: hollow
    expect(evening.querySelector("[data-mark]")?.getAttribute("data-mark")).toBe("off-close");
    expect(chart.querySelector("[data-sample][data-timing='close'] [data-mark]")?.getAttribute("data-mark"))
      .toBe("close");
    pointAt(chart, evening);
    const said = within(chart).getByRole("status");
    expect(said.textContent).toMatch(/3 Nov · 45 DTE/);
    // the rule is New York's, so the time is said on New York's clock: 09:30 in Singapore is 20:30
    expect(said.textContent).toMatch(/not the close: observed 20:30 New York, after the 16:15 close/);
    // and in the crosshair's tooltip, shorter
    expect(tipOf(chart)?.textContent).toMatch(/not the close: 20:30 New York, after the 16:15 close/);
  });

  it("says what an overnight fill and a row from before observed times are", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    pointAt(chart, dayOf(chart, "[data-timing='before-open']"));
    expect(within(chart).getByRole("status").textContent)
      .toMatch(/not the close: observed 00:05 New York, before the 09:30 open/);
    pointAt(chart, dayOf(chart, "[data-timing='unrecorded']"));
    expect(within(chart).getByRole("status").textContent).toMatch(/whether it was the close is not known/);
  });

  it("says points per contract under privacy, never a $ figure, and keeps the shape", async () => {
    const shown = await inspect("h-calls", "1218_C7300");
    const before = await burndownOf(shown.insp);
    await waitFor(() => expect(before.querySelector("[data-costs]")).toBeTruthy());
    const shape = corners(before.querySelector("[data-costs]"));
    expect(before.querySelector("[data-axis='y']")?.textContent).toMatch(/\$/);
    cleanup();

    const hidden = await inspect("h-calls", "1218_C7300", { privacy: true });
    const chart = await burndownOf(hidden.insp);
    await waitFor(() => expect(chart.querySelector("[data-costs]")).toBeTruthy());
    // the same heights, and the same spacing across the width the plot has: the axis is the same
    // scale, labelled in points per contract rather than in dollars across the contracts (#395)
    const kept = corners(chart.querySelector("[data-costs]"));
    expect(kept.map(([, y]) => y)).toEqual(shape.map(([, y]) => y));
    const spacing = (pts: [number, number][]) =>
      pts.map(([x]) => (x - pts[0]![0]) / (pts.at(-1)![0] - pts[0]![0]));
    // to the drawing's own precision: each corner is written to a tenth of a pixel
    spacing(kept).forEach((f, i) => expect(f).toBeCloseTo(spacing(shape)[i]!, 2));
    expect(chart.querySelector("[data-axis='y']")?.textContent).not.toMatch(/\$/);
    expect(chart.textContent).not.toMatch(/\$/);
    expect(within(chart).getByText("points to close, per contract")).toBeTruthy();
    pointAt(chart, dayOf(chart, "[data-sample='2026-11-09']"));
    // h-calls on 9 Nov: 4.10 per contract — never $410
    expect(within(chart).getByRole("status").textContent).toMatch(/^9 Nov · 39 DTE · to close, per contract: 4\.10 pts · on pace \d\.\d\d pts · behind by/);
    expect(tipOf(chart)?.textContent).toMatch(/to close, per contract: 4\.10 pts/);
    expect(tipOf(chart)?.textContent).not.toMatch(/\$/);
    expect(tipOf(chart)?.querySelector("[data-outcome]")?.textContent).toMatch(/^(behind|ahead) by \d\.\d\d$/);
  });

  it("never polls the samples: a new valuation of the same holding asks nothing more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { view, insp } = await inspect("h-calls", "1218_C7300");
    await burndownOf(insp);
    const revalued = HOLDINGS.map((h) => ({ ...h, cost_to_close: (h.cost_to_close ?? 0) + 0.1 }) as Holding);
    view.rerender(<DeskBook {...props({ holdings: revalued })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });

  it("calls a day observed in the hours in hours, with its New York time, rather than the close", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    pointAt(chart, dayOf(chart, "[data-timing='close']"));
    expect(within(chart).getByRole("status").textContent).toMatch(/— in hours \(observed 16:00 New York\)$/);
    // a close says nothing about the close in the tooltip
    expect(tipOf(chart)?.querySelector(".nx-bd-tip-why")).toBeNull();
  });

  it("says its money's scope, so it cannot read as the inspector's cost to close per contract", async () => {
    // the 4-leg condor is held twice over: a Level is the per-contract figure × 2 × 100
    const { insp } = await inspect("h-ic", "1231_IC");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-level='target']")).toBeTruthy());
    expect(chart.querySelector("[data-level='target']")?.textContent).toBe("target $500");
    expect(within(chart).getByText("$ to close, 2 contracts")).toBeTruthy();
    pointAt(chart, dayOf(chart, ""));
    expect(within(chart).getByRole("status").textContent)
      .toMatch(/· to close, 2 contracts: \$1,000 · on pace \$1,000 · ahead by 0\.00 —/);
    expect(tipOf(chart)?.textContent).toMatch(/to close, 2 contracts: \$1,000/);
  });

  it("says no count and no $ under privacy: points per contract", async () => {
    const { insp } = await inspect("h-ic", "1231_IC", { privacy: true });
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(2));
    expect(within(chart).queryByText(/contracts/)).toBeNull();
    pointAt(chart, dayOf(chart, ""));
    expect(within(chart).getByRole("status").textContent)
      .toMatch(/· to close, per contract: 5\.00 pts · on pace 5\.00 pts · ahead by 0\.00 —/);
    expect(tipOf(chart)?.textContent).not.toMatch(/contracts|\$/);
  });

  it("under privacy, nowhere carries a $ figure or a figure across the contracts held (#395)", async () => {
    // the 4-leg condor is held twice over at a contract size of 100: per contract is all it may say
    const { insp } = await inspect("h-ic", "1231_IC", { privacy: true });
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(2));
    const history = [...insp.querySelectorAll<HTMLElement>(".nx-hist")];
    const keys = within(chart).getByRole("group", { name: /cost to close by day/ });
    const served = SAMPLES["h-ic"]!;
    const perContract = [...served.samples.flatMap((s) => [s.cost_to_close!, s.on_pace!]),
      served.levels!.target!, served.levels!.stop!, HOLDINGS.find((h) => h.id === "h-ic")!.cost_to_close!];
    // every figure across the contracts: × 2, and × 2 × 100 in dollars or not
    // (less any that is ALSO a per-contract figure: the Stop is twice the Entry, which is 5 × 2)
    const across = perContract.flatMap((v) => [(v * 2).toFixed(2), String(v * 200), (v * 200).toLocaleString("en-US")])
      .filter((n) => !perContract.some((v) => v.toFixed(2) === n));
    /** Everything said or carried: text, every aria-label and title, every data attribute. */
    const carried = () => history.flatMap((el) => [el, ...el.querySelectorAll("*")]).flatMap((el) => [
      el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3) ? el.textContent ?? "" : "",
      ...[...el.attributes].filter((a) => a.name === "aria-label" || a.name === "title" || a.name.startsWith("data-"))
        .map((a) => a.value),
    ]).join(" | ");
    for (const key of ["Home", "ArrowRight", "End"]) {
      fireEvent.keyDown(keys, { key });
      const said = carried();
      expect(said).not.toMatch(/\$/);
      for (const n of across) expect(said.split(/[^\d.,]/)).not.toContain(n);
    }
    // and it does say the per-contract figures: the valuation now, the Target and the Stop
    expect(carried()).toContain(`to close, per contract: ${perContract.at(-1)!.toFixed(2)} pts`);
    expect(chart.querySelector("[data-level='target']")?.textContent).toBe(`target ${served.levels!.target!.toFixed(2)} pts`);
  });

  it("is one stop for the keyboard, its arrows moving from day to day and the line saying each", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    const days = within(chart).getByRole("group", { name: /cost to close by day/ });
    expect(days.tabIndex).toBe(0);
    // no day is a tab stop of its own
    expect(chart.querySelectorAll("[tabindex]")).toHaveLength(1);
    const said = () => within(chart).getByRole("status").textContent;
    fireEvent.keyDown(days, { key: "ArrowRight" });
    expect(said()).toMatch(/^3 Nov · 45 DTE/);
    fireEvent.keyDown(days, { key: "ArrowRight" });
    expect(said()).toMatch(/^4 Nov · 44 DTE/);
    fireEvent.keyDown(days, { key: "ArrowLeft" });
    expect(said()).toMatch(/^3 Nov/);
    fireEvent.keyDown(days, { key: "ArrowLeft" });
    expect(said()).toMatch(/^3 Nov/);
    fireEvent.keyDown(days, { key: "End" });
    // the last stop is today's valuation (#360), and the day before it the last sample
    expect(said()).toMatch(/^valued now, 38 DTE/);
    fireEvent.keyDown(days, { key: "ArrowRight" });
    expect(said()).toMatch(/^valued now/);
    fireEvent.keyDown(days, { key: "ArrowLeft" });
    expect(said()).toMatch(/^9 Nov · 39 DTE/);
    fireEvent.keyDown(days, { key: "Home" });
    expect(said()).toMatch(/^3 Nov/);
  });

  it("names each tick on its axis once, for a debit whose every figure is below zero", async () => {
    const debit = HOLDINGS.map((h) => (h.id === "h-calls" ? { ...h, entry: -2, cost_to_close: -1.5 } : h) as Holding);
    serveSamples({
      levels: { dte_at_open: 45, target: null, stop: null, target_dte: null, manage_by_dte: 21 },
      plan: [{ dte: 45, on_pace: -2 }, { dte: 0, on_pace: 0 }],
      samples: SAMPLES["h-calls"]!.samples.map((s) => ({ ...s, cost_to_close: -s.cost_to_close!, on_pace: null })),
      qty_corrected_at: null,
    });
    const { insp } = await inspect("h-calls", "1218_C7300", { holdings: debit });
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-axis='y']")).toBeTruthy());
    const labels = [...chart.querySelectorAll("[data-axis='y'] text")].map((t) => t.textContent);
    // each value once: with every figure at or below zero the top IS zero, and named twice it was
    // two "$0" drawn over each other
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("$0");
    expect(labels[0]).toMatch(/^-\$\d/);
  });

  it("breaks the line across a missed session rather than joining the days either side", async () => {
    // no row at all for 5 Nov: the service was down that whole New York day
    const days = SAMPLES["h-calls"]!.samples.filter((s) => s.observed_on !== "2026-11-05");
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(6));
    expect([...chart.querySelectorAll("[data-costs]")].map((r) => corners(r).length)).toEqual([2, 4]);
    // and the IV, which also has 6 Nov's row without a reading: [3 Nov, 4 Nov] | [7, 8, 9 Nov]
    const iv = await ivOf(insp);
    const runs = [...iv.querySelectorAll("[data-leg]")][0]!.querySelectorAll("[data-iv-run]");
    expect([...runs].map((r) => corners(r).length)).toEqual([2, 3]);
  });

  it("draws no point for a day kept with no Cost to close, and does not call it missed (#380)", async () => {
    // 5 Nov's row is there for its vol readings, with no price: a leg had no two-sided quote
    const days = SAMPLES["h-calls"]!.samples.map((s) => (s.observed_on === "2026-11-05" ? { ...s, cost_to_close: null } : s));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(6));
    expect(chart.querySelector("[data-sample='2026-11-05']")).toBeNull();
    // the line breaks there, as it does across a missed day, but the day is not hatched as missed
    expect([...chart.querySelectorAll("[data-costs]")].map((r) => corners(r).length)).toEqual([2, 4]);
    expect(chart.querySelectorAll("[data-missed]")).toHaveLength(0);
  });

  it("says why the burndown is empty when no day has a Cost to close yet (#380)", async () => {
    const days = SAMPLES["h-calls"]!.samples.map((s) => ({ ...s, cost_to_close: null }));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(within(chart).getByText(/no day with a Cost to close yet/)).toBeTruthy());
    expect(chart.querySelectorAll("[data-sample]")).toHaveLength(0);
  });

  it("draws the days summed before a leg's quantity was corrected apart, and says so (#359)", async () => {
    // corrected at 13:00 in Singapore on 6 Nov, which is midnight on the 6th in New York: the 3rd,
    // 4th and 5th were summed under the quantities as first recorded
    const days = SAMPLES["h-calls"]!.samples.map((s) => ({ ...s, before_correction: s.observed_on < "2026-11-06" }));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days, qty_corrected_at: "2026-11-06 13:00:00+08:00" });
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect([...chart.querySelectorAll("[data-before-correction]")].map((g) => g.getAttribute("data-sample")))
      .toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
    // the line in two: the three days before, and the step to the 6th, faint; the rest as ever
    expect([...chart.querySelectorAll("[data-costs]")].map((r) => [r.getAttribute("data-costs"), corners(r).length]))
      .toEqual([["before-correction", 4], ["", 4]]);
    // a rule on the day it was corrected, at the 6th's x
    const marker = chart.querySelector("[data-corrected-on]")!;
    expect(marker.textContent).toBe("qty corrected");
    expect(marker.querySelector("line")!.getAttribute("x1"))
      .toBe(dayOf(chart, "[data-sample='2026-11-06']").querySelector("circle")!.getAttribute("cx"));
    expect(within(chart).getByRole("status").textContent).toMatch(/faint: summed before a leg's quantity was corrected$/);

    pointAt(chart, dayOf(chart, "[data-sample='2026-11-04']"));
    expect(within(chart).getByRole("status").textContent).toMatch(/— summed before a leg's quantity was corrected$/);
    // no gap is said against the plan for another structure's Cost to close
    expect(within(chart).getByRole("status").textContent).not.toMatch(/ahead by|behind by/);
    expect(tipOf(chart)?.querySelector("[data-corrected]")?.textContent).toBe("summed before a leg's quantity was corrected");
    pointAt(chart, dayOf(chart, "[data-sample='2026-11-07']"));
    expect(within(chart).getByRole("status").textContent).not.toMatch(/quantity was corrected/);
    expect(tipOf(chart)?.querySelector("[data-corrected]")).toBeNull();
  });

  it("marks nothing for a holding never corrected", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(chart.querySelector("[data-corrected-on]")).toBeNull();
    expect(chart.querySelector("[data-before-correction]")).toBeNull();
    expect(within(chart).getByRole("status").textContent).not.toMatch(/corrected/);
  });

  it("draws the costs with no plan, and says why, for a holding with no Opened", async () => {
    serveSamples({ ...SAMPLES["h-calls"]!, levels: null, plan: [],
      samples: SAMPLES["h-calls"]!.samples.map((s) => ({ ...s, on_pace: null })) });
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(chart.querySelector("[data-plan]")).toBeNull();
    expect(within(chart).getByText(/no plan: Opened not recorded/)).toBeTruthy();
  });

  it("says so when nothing has been sampled yet", async () => {
    serveSamples({ ...SAMPLES["h-calls"]!, samples: [] });
    const { insp } = await inspect("h-calls", "1218_C7300");
    expect(await within(insp).findByText(/no daily samples recorded yet/)).toBeTruthy();
  });

  it("says so when the service refuses, rather than drawing nothing", async () => {
    serveSamples(null);
    const { insp } = await inspect("h-calls", "1218_C7300");
    expect(await within(insp).findByText(/the samples could not be read — .*404/)).toBeTruthy();
  });
});

describe("the crosshair (#360)", () => {
  async function chartOf(id = "h-calls", name = "1218_C7300", over: Partial<BookProps> = {}) {
    const { insp } = await inspect(id, name, over);
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
    return chart;
  }
  const crossed = (chart: HTMLElement) => chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair");
  const said = (chart: HTMLElement) => within(chart).getByRole("status").textContent;

  it("snaps to the day nearest the pointer, from either side of it", async () => {
    const chart = await chartOf();
    const fourth = dayOf(chart, "[data-sample='2026-11-04']");
    const gap = Number(dayOf(chart, "[data-sample='2026-11-05']").querySelector("circle")!.getAttribute("cx"))
      - Number(fourth.querySelector("circle")!.getAttribute("cx"));
    expect(crossed(chart)).toBeUndefined();
    pointAt(chart, fourth, { by: gap * 0.4 });
    expect(crossed(chart)).toBe("2026-11-04");
    pointAt(chart, fourth, { by: -gap * 0.4 });
    expect(crossed(chart)).toBe("2026-11-04");
    pointAt(chart, fourth, { by: gap * 0.6 });
    expect(crossed(chart)).toBe("2026-11-05");
    // the day crossed is the day marked, the day said and the day the tooltip says
    expect(chart.querySelector("[data-pointed]")?.getAttribute("data-sample")).toBe("2026-11-05");
    expect(said(chart)).toMatch(/^5 Nov · 43 DTE/);
    expect(tipOf(chart)?.textContent).toMatch(/^5 Nov · 43 DTE/);
  });

  it("says the day's cost, on pace and the gap in the outcome colour, in the tooltip", async () => {
    const chart = await chartOf();
    pointAt(chart, dayOf(chart, "[data-sample='2026-11-09']"));
    const tip = tipOf(chart)!;
    expect(tip.getAttribute("aria-hidden")).toBe("true");
    const lines = [...tip.children].map((l) => l.textContent);
    // h-calls is a single call spread with a contract size of 100, behind pace
    expect(lines[0]).toBe("9 Nov · 39 DTE");
    expect(lines[1]).toMatch(/^to close, 1 contract: \$410$/);
    expect(lines[2]).toMatch(/^on pace \$\d+ · behind by \d\.\d\d$/);
    const gap = tip.querySelector("[data-outcome]")!;
    expect(gap.getAttribute("data-outcome")).toBe("loss");
    // the status line says the same gap, for whoever cannot see the tooltip
    expect(said(chart)).toContain(` · ${gap.textContent} — `);
  });

  it("lets go when a mouse leaves, and keeps the day when a finger lifts", async () => {
    const chart = await chartOf();
    const svg = chart.querySelector(".nx-bd svg")!;
    pointAt(chart, dayOf(chart, "[data-sample='2026-11-04']"));
    fireEvent.pointerLeave(svg, { pointerType: "mouse" });
    expect(crossed(chart)).toBeUndefined();
    expect(tipOf(chart)).toBeNull();
    expect(said(chart)).toMatch(/point at a day/);
    // a finger dragged across: once it has gone sideways each move scrubs to the day under it,
    // and lifting keeps the last
    const xOf = (on: string) => Number(dayOf(chart, `[data-sample='${on}']`).querySelector("circle")!.getAttribute("cx"));
    fireEvent.pointerDown(svg, { clientX: xOf("2026-11-03"), clientY: 50, pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
    fireEvent.pointerMove(svg, { clientX: xOf("2026-11-04"), clientY: 50, pointerType: "touch" });
    fireEvent.pointerMove(svg, { clientX: xOf("2026-11-06"), clientY: 50, pointerType: "touch" });
    expect(crossed(chart)).toBe("2026-11-06");
    fireEvent.pointerUp(svg, { pointerType: "touch" });
    fireEvent.pointerLeave(svg, { pointerType: "touch" });
    expect(crossed(chart)).toBe("2026-11-06");
  });

  it("chooses no day for a finger that touches down and scrolls the page", async () => {
    const chart = await chartOf();
    const svg = chart.querySelector(".nx-bd svg")!;
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
    // up the page, a little sideways as a thumb goes: the page's, not a scrub
    fireEvent.pointerMove(svg, { clientX: 112, clientY: 70, pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
    fireEvent.pointerCancel(svg, { pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
    expect(tipOf(chart)).toBeNull();
    // and a day chosen before is let go of when a scroll starts on the chart: it was not chosen
    // for the page to carry its tooltip away up the screen
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 50, pointerType: "touch" });
    fireEvent.click(svg, { clientX: 100, clientY: 50 });
    expect(crossed(chart)).toBeDefined();
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerType: "touch" });
    fireEvent.pointerCancel(svg, { pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
  });

  it("chooses a day on a tap, lets go of it on a second tap or a tap outside the chart", async () => {
    const chart = await chartOf();
    const svg = chart.querySelector(".nx-bd svg")!;
    const x = Number(dayOf(chart, "[data-sample='2026-11-05']").querySelector("circle")!.getAttribute("cx"));
    const tap = (at: number) => {
      fireEvent.pointerDown(svg, { clientX: at, clientY: 50, pointerType: "touch" });
      fireEvent.pointerUp(svg, { clientX: at, clientY: 50, pointerType: "touch" });
      fireEvent.click(svg, { clientX: at, clientY: 50 });
    };
    tap(x + 1);
    expect(crossed(chart)).toBe("2026-11-05");
    tap(x);
    expect(crossed(chart)).toBeUndefined();
    tap(x);
    expect(crossed(chart)).toBe("2026-11-05");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(crossed(chart)).toBeUndefined();
    expect(tipOf(chart)).toBeNull();
  });

  it("is driven by the keys too, and Escape lets go", async () => {
    const chart = await chartOf();
    const days = within(chart).getByRole("group", { name: /cost to close by day/ });
    fireEvent.keyDown(days, { key: "ArrowRight" });
    expect(crossed(chart)).toBe("2026-11-03");
    expect(tipOf(chart)?.textContent).toMatch(/^3 Nov/);
    fireEvent.keyDown(days, { key: "End" });
    expect(crossed(chart)).toBe("now");
    fireEvent.keyDown(days, { key: "Escape" });
    expect(crossed(chart)).toBeUndefined();
    expect(tipOf(chart)).toBeNull();
  });
});

describe("the crosshair and the inspector's Escape (#360)", () => {
  const inspector = () => screen.queryByRole("complementary", { name: /inspector/ });

  it("lets Escape through to close the inspector when no day is pointed at", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    const days = within(chart).getByRole("group", { name: /cost to close by day/ });
    days.focus();
    fireEvent.keyDown(days, { key: "Escape" });
    expect(inspector()).toBeNull();
  });

  it("takes the first Escape to let go of a day, and lets the second close the inspector", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    const days = within(chart).getByRole("group", { name: /cost to close by day/ });
    days.focus();
    fireEvent.keyDown(days, { key: "ArrowRight" });
    fireEvent.keyDown(days, { key: "Escape" });
    expect(chart.querySelector("[data-crosshair]")).toBeNull();
    expect(inspector()).toBeTruthy();
    fireEvent.keyDown(days, { key: "Escape" });
    expect(inspector()).toBeNull();
  });
});

describe("today's valuation on the crosshair (#360)", () => {
  async function chartOf(over: Partial<BookProps> = {}) {
    const { insp } = await inspect("h-calls", "1218_C7300", over);
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    return chart;
  }

  it("is the last stop for the keys, and says it is the valuation now", async () => {
    const chart = await chartOf();
    const days = within(chart).getByRole("group", { name: /cost to close by day/ });
    fireEvent.keyDown(days, { key: "End" });
    expect(chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")).toBe("now");
    expect(chart.querySelector("[data-now]")?.hasAttribute("data-pointed")).toBe(true);
    // h-calls is valued at 4.40 with 38 days to go, one contract at a size of 100
    expect(within(chart).getByRole("status").textContent).toBe("valued now, 38 DTE: to close, 1 contract: $440");
    expect(tipOf(chart)?.textContent).toBe("valued now · 38 DTEto close, 1 contract: $440");
    fireEvent.keyDown(days, { key: "ArrowLeft" });
    expect(chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")).toBe("2026-11-09");
  });

  it("is reached by a pointer at its x", async () => {
    const chart = await chartOf();
    const at = chart.querySelector("[data-now] rect:not(.nx-bd-halo)")!;
    const x = Number(at.getAttribute("x")) + 4.5;
    fireEvent.pointerMove(chart.querySelector(".nx-bd svg")!, { clientX: x, pointerType: "mouse" });
    expect(chart.querySelector("[data-crosshair]")?.getAttribute("data-crosshair")).toBe("now");
  });

  it("is said per contract in points under privacy", async () => {
    const chart = await chartOf({ privacy: true });
    fireEvent.keyDown(within(chart).getByRole("group", { name: /cost to close by day/ }), { key: "End" });
    expect(within(chart).getByRole("status").textContent).toBe("valued now, 38 DTE: to close, per contract: 4.40 pts");
    expect(tipOf(chart)?.textContent).not.toMatch(/\$|contracts/);
  });
});

describe("the value axis (#360)", () => {
  /** The y of the plot's top: the highest gridline. */
  const topOf = (chart: HTMLElement) =>
    Math.min(...[...chart.querySelectorAll("[data-grid] line")].map((l) => Number(l.getAttribute("y1"))));

  it("is the days' and the Target's, and marks a Stop beyond it at the top edge with its figure", async () => {
    // h-puts never went near its Stop at twice the Entry
    const { insp } = await inspect("h-puts", "1218_P6400");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-level='stop']")).toBeTruthy());
    const stop = chart.querySelector("[data-level='stop']")!;
    expect(stop.getAttribute("data-off")).toBe("above");
    expect(stop.textContent).toMatch(/^▲ stop \$\d/);
    expect(Number(stop.querySelector("line")!.getAttribute("y1"))).toBe(topOf(chart));
    // no tick reaches it: the scale stops short of the Stop
    const stopAt = SAMPLES["h-puts"]!.levels!.stop! * 100;
    const ticks = [...chart.querySelectorAll("[data-axis='y'] text")].map((t) => Number(t.textContent!.replace(/[$,]/g, "")));
    expect(Math.max(...ticks)).toBeLessThan(stopAt);
  });

  it("draws a Stop the days reached where it is", async () => {
    // h-calls' week ran up through its Stop at 4.00
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-level='stop']")).toBeTruthy());
    const stop = chart.querySelector("[data-level='stop']")!;
    expect(stop.hasAttribute("data-off")).toBe(false);
    expect(stop.textContent).toBe("stop $400");
    expect(Number(stop.querySelector("line")!.getAttribute("y1"))).toBeGreaterThan(topOf(chart));
  });

  it("marks it with its figure per contract, in points, under privacy", async () => {
    const { insp } = await inspect("h-puts", "1218_P6400", { privacy: true });
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-level='stop']")).toBeTruthy());
    expect(chart.querySelector("[data-level='stop']")?.textContent).toMatch(/^▲ stop \d+\.\d\d pts$/);
  });
});

describe("switching holdings outside the session", () => {
  /** Each holding's samples answered when the test says, as a slow service would. */
  function held() {
    const waiting = new Map<string, () => void>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      asked.push(`${init?.method ?? "GET"} ${path}`);
      const samples = samplesAnswer(path);
      if (!samples) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer(path) ?? volAnswer(path)) });
      return new Promise((resolve) => waiting.set(path, () =>
        resolve({ ok: true, status: 200, json: () => Promise.resolve(samples) })));
    }));
    return async (path: string) => { await act(async () => { waiting.get(path)!(); await Promise.resolve(); }); };
  }
  const select = (id: string, name: string) =>
    fireEvent.click(within(deskRow(id)).getByRole("button", { name }));
  const chartOf = () => burndownOf(screen.getByRole("complementary", { name: /inspector/ }));

  it("draws the holding now selected when the one before answers late", async () => {
    const answer = held();
    render(<DeskBook {...props()} />);
    select("h-calls", "1218_C7300");
    select("h-puts", "1218_P6400");
    await answer("/positions/h-puts/samples");
    await answer("/positions/h-calls/samples");
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples", "GET /positions/h-puts/samples"]);
    const chart = await chartOf();
    expect(within(chart).queryByText("reading the samples…")).toBeNull();
    // h-puts' week is all closes; h-calls' has a day recorded that evening
    expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7);
    expect(chart.querySelector("[data-timing='after-close']")).toBeNull();
  });

  it("never draws the last holding's days under the next while its own are asked for", async () => {
    const answer = held();
    render(<DeskBook {...props()} />);
    select("h-calls", "1218_C7300");
    await answer("/positions/h-calls/samples");
    expect((await chartOf()).querySelectorAll("[data-sample]")).toHaveLength(7);
    select("h-puts", "1218_P6400");
    const chart = await chartOf();
    expect(within(chart).getByText("reading the samples…")).toBeTruthy();
    expect(chart.querySelectorAll("[data-sample]")).toHaveLength(0);
  });
});

describe("the IV chart", () => {
  it("draws each leg's IV per day, named by its side and strike", async () => {
    const { insp } = await inspect("h-ic", "1231_IC");
    const chart = await ivOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-leg]")).toHaveLength(4));
    const legs = [...chart.querySelectorAll<SVGElement>("[data-leg]")];
    expect(legs.map((l) => l.querySelector("text")?.textContent)).toEqual(["−C7400", "+C7450", "−P6300", "+P6250"]);
    // each name's type marked for its colour, a short leg's for its weight (#391)
    expect(legMarks(chart)).toEqual(["−C7400 short CALL", "+C7450 long CALL", "−P6300 short PUT", "+P6250 long PUT"]);
    expect(legs.map((l) => corners(l.querySelector("[data-iv-run]")).length)).toEqual([2, 2, 2, 2]);
  });

  it("keeps its % axis under privacy: IV is no money", async () => {
    const { insp } = await inspect("h-ic", "1231_IC", { privacy: true });
    const chart = await ivOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-axis='y']")).toBeTruthy());
    expect(chart.querySelector("[data-axis='y']")?.textContent).toMatch(/%/);
  });

  it("leaves a gap on a day with no IV rather than joining across it", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await ivOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-leg]")).toHaveLength(2));
    // seven days, one with no IV: two runs, of three and three
    const runs = [...chart.querySelectorAll("[data-leg]")][0]!.querySelectorAll("[data-iv-run]");
    expect([...runs].map((r) => corners(r).length)).toEqual([3, 3]);
  });
});

describe("in the phone's holding sheet outside the session, open from the start (#374)", () => {
  const draw = (over: Partial<BookProps> = {}) =>
    render(<div className="nx"><PhoneBook {...props({ session: false, ...over })} /></div>);
  async function sheetOf(name: string) {
    fireEvent.click(screen.getByRole("button", { name: `details of ${name}` }));
    return screen.getByRole("dialog");
  }

  it("is the sheet's chart at once, read once for its holding and no other", async () => {
    draw();
    const sheet = await sheetOf("1218_C7300");
    const chart = await burndownOf(sheet);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(await ivOf(sheet)).toBeTruthy();
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });

  it("says why a point is not a close when it is tapped", async () => {
    draw();
    const chart = await burndownOf(await sheetOf("1218_C7300"));
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    const svg = chart.querySelector(".nx-bd svg")!;
    const x = Number(dayOf(chart, "[data-timing='before-open']").querySelector("circle")!.getAttribute("cx"));
    // a tap: down, up and the click it makes
    fireEvent.pointerDown(svg, { clientX: x + 2, pointerType: "touch" });
    fireEvent.pointerUp(svg, { clientX: x + 2, pointerType: "touch" });
    fireEvent.click(svg, { clientX: x + 2 });
    expect(within(chart).getByRole("status").textContent)
      .toMatch(/not the close: observed 00:05 New York, before the 09:30 open/);
    // lifting the finger off leaves it said, where a mouse leaving lets it go
    fireEvent.pointerLeave(svg, { pointerType: "touch" });
    expect(tipOf(chart)).toBeTruthy();
  });

  it("hides the $ axis under privacy, labelling it in points per contract", async () => {
    draw({ privacy: true });
    const chart = await burndownOf(await sheetOf("1218_C7300"));
    await waitFor(() => expect(chart.querySelector("[data-costs]")).toBeTruthy());
    expect(chart.querySelector("[data-axis='y']")?.textContent).not.toMatch(/\$/);
    expect(chart.textContent).not.toMatch(/\$/);
  });

  it("draws no holding's history until a sheet is opened: the cards read no samples", async () => {
    draw();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(samplesAsked()).toEqual([]);
  });
});

/** The section that opens a holding's history (#353), wherever it is drawn. */
const toggleOf = (root: HTMLElement) => within(root).getByRole("button", { name: "history" });

/** Its toggle's state, and the box it controls: named by `aria-controls`, and there to be named
 *  whether it is open or shut. */
function disclosure(root: HTMLElement) {
  const toggle = toggleOf(root);
  const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  expect(body, "aria-controls names the box it opens").toBeTruthy();
  return { expanded: toggle.getAttribute("aria-expanded"), body: body! };
}

describe("in session, on demand (#353): the desk's inspector", () => {
  it("is drawn when opened, and not before: shut, it asks for nothing", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300", { session: true });
    await within(insp).findByRole("group", { name: "payoff at expiry" });
    expect(disclosure(insp).expanded).toBe("false");
    expect(disclosure(insp).body.hidden).toBe(true);
    expect(within(insp).queryByRole("group", { name: "burndown" })).toBeNull();
    expect(samplesAsked()).toEqual([]);

    fireEvent.click(toggleOf(insp));
    expect(disclosure(insp).expanded).toBe("true");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    // the three charts drawn open outside the session, from the same one answer
    expect(await ivOf(insp)).toBeTruthy();
    expect(await within(insp).findByRole("group", { name: "SPX against the strikes" })).toBeTruthy();
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });

  it("asks nothing more when shut and opened again, or when a poll brings a new valuation", async () => {
    const { view, insp } = await inspect("h-calls", "1218_C7300", { session: true });
    fireEvent.click(toggleOf(insp));
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    fireEvent.click(toggleOf(insp));
    expect(disclosure(insp).expanded).toBe("false");
    expect(disclosure(insp).body.hidden).toBe(true);
    fireEvent.click(toggleOf(insp));
    expect(disclosure(insp).body.hidden).toBe(false);
    expect((await burndownOf(insp)).querySelectorAll("[data-sample]")).toHaveLength(7);
    // a poll: the same holdings, as new objects
    view.rerender(<DeskBook {...props({ session: true, holdings: HOLDINGS.map((h) => ({ ...h })) })} />);
    await act(async () => { await Promise.resolve(); });
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });

  // a 200 whose body is not the samples: said, rather than "reading the samples…" for ever (#353)
  for (const [what, body] of [["null", null], ["a string", "oops"], ["an object with no days", {}]] as const) {
    it(`says the samples could not be read when the service answers 200 with ${what}`, async () => {
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        const path = String(url).replace(/^.*\/api/, "");
        const answer = /\/samples$/.test(path) ? body : payoffAnswer(path) ?? volAnswer(path);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
      }));
      const { insp } = await inspect("h-calls", "1218_C7300", { session: true });
      fireEvent.click(within(insp).getByRole("button", { name: "history" }));
      expect(await within(insp).findByText(/the samples could not be read — the service answered without them/))
        .toBeTruthy();
    });
  }

  it("hides the $ axis under privacy, as it is outside the session", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300", { session: true, privacy: true });
    fireEvent.click(toggleOf(insp));
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelector("[data-costs]")).toBeTruthy());
    expect(chart.querySelector("[data-axis='y']")?.textContent).not.toMatch(/\$/);
    expect(chart.textContent).not.toMatch(/\$/);
  });

  it("starts shut for the next holding selected, and draws it, not the last, when the last answers late", async () => {
    const waiting = new Map<string, () => void>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      asked.push(`${init?.method ?? "GET"} ${path}`);
      const samples = samplesAnswer(path);
      if (!samples) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer(path) ?? volAnswer(path)) });
      return new Promise((resolve) => waiting.set(path, () =>
        resolve({ ok: true, status: 200, json: () => Promise.resolve(samples) })));
    }));
    const answer = async (path: string) => { await act(async () => { waiting.get(path)!(); await Promise.resolve(); }); };
    const { insp } = await inspect("h-calls", "1218_C7300", { session: true });
    fireEvent.click(toggleOf(insp));
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
    fireEvent.click(within(deskRow("h-puts")).getByRole("button", { name: "1218_P6400" }));
    const next = screen.getByRole("complementary", { name: "inspector: 1218_P6400" });
    expect(disclosure(next).expanded).toBe("false");
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
    fireEvent.click(toggleOf(next));
    await answer("/positions/h-puts/samples");
    await answer("/positions/h-calls/samples");
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples", "GET /positions/h-puts/samples"]);
    const chart = await burndownOf(next);
    // h-puts' week is all closes; h-calls' has a day recorded that evening
    expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7);
    expect(chart.querySelector("[data-timing='after-close']")).toBeNull();
  });
});

describe("in session, on demand (#353): the phone's holding sheet", () => {
  const draw = (over: Partial<BookProps> = {}) =>
    render(<div className="nx"><PhoneBook {...props({ session: true, ...over })} /></div>);

  it("is shut until opened, then reads the samples once, however often it is shut and opened", async () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_C7300" }));
    const sheet = screen.getByRole("dialog");
    expect(disclosure(sheet).expanded).toBe("false");
    expect(within(sheet).queryByRole("group", { name: "burndown" })).toBeNull();
    expect(samplesAsked()).toEqual([]);
    fireEvent.click(toggleOf(sheet));
    const chart = await burndownOf(sheet);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(await ivOf(sheet)).toBeTruthy();
    fireEvent.click(toggleOf(sheet));
    expect(disclosure(sheet).body.hidden).toBe(true);
    fireEvent.click(toggleOf(sheet));
    expect(disclosure(sheet).body.hidden).toBe(false);
    expect(samplesAsked()).toEqual(["GET /positions/h-calls/samples"]);
  });
});

describe("HistoryOnDemand opened by default (#371, for #372 and #374)", () => {
  /** every samples read, by path */
  let reads: string[] = [];
  beforeEach(() => {
    reads = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (path.endsWith("/samples")) reads.push(path);
      const body = samplesAnswer(path);
      return Promise.resolve({ ok: body !== null, status: body ? 200 : 404, json: () => Promise.resolve(body) });
    }));
  });

  it("starts open and reads the samples once, at once, when told to", async () => {
    render(<HistoryOnDemand holding={HOLDINGS[0]!} privacy={false} defaultOpen />);
    expect(screen.getByRole("button", { name: "history" }).getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(reads).toEqual(["/positions/h-puts/samples"]));
    // shut and opened again, it asks nothing more
    fireEvent.click(screen.getByRole("button", { name: "history" }));
    fireEvent.click(screen.getByRole("button", { name: "history" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(reads).toEqual(["/positions/h-puts/samples"]);
  });

  for (const given of [{}, { defaultOpen: false }]) {
    it(`starts shut and reads nothing ${"defaultOpen" in given ? "when told not to open" : "by default"}`, async () => {
      render(<HistoryOnDemand holding={HOLDINGS[0]!} privacy={false} {...given} />);
      expect(screen.getByRole("button", { name: "history" }).getAttribute("aria-expanded")).toBe("false");
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(reads).toEqual([]);
    });
  }
});

describe("one crosshair across the burndown, the IV chart and SPX's path (#395)", () => {
  /** The three panels of a holding's history in the desk's inspector, drawn. */
  async function panelsOf(id = "h-calls", name = "1218_C7300", over: Partial<BookProps> = {}) {
    const { insp } = await inspect(id, name, over);
    const burndown = await burndownOf(insp);
    const iv = await ivOf(insp);
    const spx = await within(insp).findByRole("group", { name: "SPX against the strikes" });
    await waitFor(() => expect(spx.querySelectorAll("[data-spx-day]").length).toBeGreaterThan(0));
    return { insp, burndown, iv, spx, all: [burndown, iv, spx] as const };
  }
  const crossed = (panel: HTMLElement) => panel.querySelector("[data-crosshair]")?.getAttribute("data-crosshair");
  const said = (panel: HTMLElement) => within(panel).getByRole("status").textContent;
  const tipText = (panel: HTMLElement) => [...(tipOf(panel)?.children ?? [])].map((l) => l.textContent);
  /** Each panel's SVG and the box its keys go to. */
  const svgOf = (panel: HTMLElement) => panel.querySelector<SVGSVGElement>(".nx-bd svg, .nx-cross svg")!;
  const keysOf = (panel: HTMLElement) => panel.querySelector<HTMLElement>("[tabindex='0']")!;
  /** A mouse at a DTE's x in a panel: every panel puts a DTE at one x. */
  const xOf = (iv: HTMLElement, dte: number) =>
    Number(iv.querySelector(`circle[data-dte="${dte}"]`)!.getAttribute("cx"));
  const hover = (panel: HTMLElement, x: number) => fireEvent.pointerMove(svgOf(panel), { clientX: x, pointerType: "mouse" });

  it("follows a mouse in any panel into all three, each saying the day in its own readout", async () => {
    const { burndown, iv, spx, all } = await panelsOf();
    for (const panel of all) {
      hover(panel, xOf(iv, 39));
      expect(all.map(crossed)).toEqual(["2026-11-09", "2026-11-09", "2026-11-09"]);
      hover(panel, xOf(iv, 44));
      expect(all.map(crossed)).toEqual(["2026-11-04", "2026-11-04", "2026-11-04"]);
    }
    hover(iv, xOf(iv, 39));
    expect(tipText(burndown)[0]).toBe("9 Nov · 39 DTE");
    expect(tipText(burndown)[1]).toBe("to close, 1 contract: $410");
    // each leg's IV that day, named as the chart names it, with its type's colour (#391)
    expect(tipText(iv)).toEqual(["9 Nov · 39 DTE", "−C7300 14.00%", "+C7350 13.25%"]);
    expect(legMarks(tipOf(iv)!)).toEqual(["−C7300 short CALL", "+C7350 long CALL"]);
    expect(said(iv)).toBe("9 Nov · 39 DTE: −C7300 14.00%, +C7350 13.25%");
    // SPX that day and the short strike's distance from it, in points and σ, as the service placed it
    expect(tipText(spx)).toEqual(["9 Nov · 39 DTE", "SPX 6895.75", "C7300 404.25 pts · 1.28σ away"]);
    expect(said(spx)).toBe("9 Nov · 39 DTE: SPX 6895.75 · C7300 404.25 pts · 1.28σ away");
    // a mouse leaving any panel lets go in all three
    fireEvent.pointerLeave(svgOf(spx), { pointerType: "mouse" });
    expect(all.map(crossed)).toEqual([undefined, undefined, undefined]);
    expect(all.map(tipOf)).toEqual([null, null, null]);
  });

  it("is stepped by the keys from any panel, each panel one tab stop, Escape letting go in all three", async () => {
    const { insp, burndown, iv, spx, all } = await panelsOf();
    // one stop each, and the days none of their own
    expect([...insp.querySelectorAll("[tabindex='0']")].filter((el) => all.some((p) => p.contains(el))))
      .toHaveLength(3);
    for (const panel of all) {
      fireEvent.keyDown(keysOf(panel), { key: "Home" });
      expect(all.map(crossed)).toEqual(["2026-11-03", "2026-11-03", "2026-11-03"]);
      fireEvent.keyDown(keysOf(panel), { key: "ArrowRight" });
      expect(all.map(crossed)).toEqual(["2026-11-04", "2026-11-04", "2026-11-04"]);
    }
    expect(said(burndown)).toMatch(/^4 Nov · 44 DTE/);
    expect(said(iv)).toBe("4 Nov · 44 DTE: −C7300 12.00%, +C7350 11.50%");
    expect(said(spx)).toBe("4 Nov · 44 DTE: SPX 6840.10 · C7300 459.90 pts · 1.61σ away");
    // the last stop is today's valuation, in all three
    fireEvent.keyDown(keysOf(iv), { key: "End" });
    expect(all.map(crossed)).toEqual(["now", "now", "now"]);
    expect(said(burndown)).toBe("valued now, 38 DTE: to close, 1 contract: $440");
    expect(said(iv)).toBe("valued now · 38 DTE: no IV in the history for today's valuation");
    expect(said(spx)).toBe("valued now · 38 DTE: SPX now 6900.50 · C7300 399.50 pts · 1.00σ away");
    fireEvent.keyDown(keysOf(spx), { key: "ArrowLeft" });
    expect(all.map(crossed)).toEqual(["2026-11-09", "2026-11-09", "2026-11-09"]);
    fireEvent.keyDown(keysOf(spx), { key: "Escape" });
    expect(all.map(crossed)).toEqual([undefined, undefined, undefined]);
  });

  it("marks a day that is not the close in every panel, and says why in each readout", async () => {
    const { iv, spx, all } = await panelsOf();
    // 3 Nov was recorded that evening: hollow in the IV chart and on SPX's path, as on the burndown
    expect(iv.querySelector("circle[data-dte='45']")!.getAttribute("data-mark")).toBe("off-close");
    expect(spx.querySelector("[data-spx-day='2026-11-03']")!.getAttribute("data-mark")).toBe("off-close");
    expect(spx.querySelector("[data-spx-day='2026-11-04']")!.getAttribute("data-mark")).toBe("close");
    hover(iv, xOf(iv, 45));
    for (const panel of all) {
      expect(tipOf(panel)!.querySelector(".nx-bd-tip-why")?.textContent)
        .toBe("not the close: 20:30 New York, after the 16:15 close");
    }
    expect(said(spx)).toMatch(/ — not the close: 20:30 New York, after the 16:15 close$/);
  });

  it("says so in a panel with no figure for the day, rather than drawing nothing", async () => {
    // the call spread's 6 Nov has no IV; the put spread's 5 Nov has no SPX
    const calls = await panelsOf();
    fireEvent.keyDown(keysOf(calls.iv), { key: "Home" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(keysOf(calls.iv), { key: "ArrowRight" });
    expect(calls.all.map(crossed)).toEqual(["2026-11-06", "2026-11-06", "2026-11-06"]);
    expect(tipText(calls.iv)).toEqual(["6 Nov · 42 DTE", "no IV recorded this day",
      "not timed: whether it was the close is not known"]);
    // SPX that day, and points with no σ to put them in: the service had no IV to measure by
    expect(tipText(calls.spx)[2]).toBe("C7300 428.75 pts away · no σ: no IV that day");
    cleanup();
    const puts = await panelsOf("h-puts", "1218_P6400");
    fireEvent.keyDown(keysOf(puts.spx), { key: "Home" });
    fireEvent.keyDown(keysOf(puts.spx), { key: "ArrowRight" });
    fireEvent.keyDown(keysOf(puts.spx), { key: "ArrowRight" });
    expect(puts.all.map(crossed)).toEqual(["2026-11-05", "2026-11-05", "2026-11-05"]);
    expect(tipText(puts.spx)).toEqual(["5 Nov · 43 DTE",
      "no SPX this day: stored before it was recorded, or its batch could not give it", "P6400 — no SPX that day"]);
    // the rule down the day, and nothing across: there is no price to cross at
    expect(puts.spx.querySelectorAll("[data-crosshair] line")).toHaveLength(1);
  });

  it("stops on a day kept with no Cost to close, where the burndown says it has none (#380)", async () => {
    const days = SAMPLES["h-calls"]!.samples.map((s) => (s.observed_on === "2026-11-05" ? { ...s, cost_to_close: null } : s));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { burndown, iv, all } = await panelsOf();
    hover(iv, xOf(iv, 43));
    expect(all.map(crossed)).toEqual(["2026-11-05", "2026-11-05", "2026-11-05"]);
    expect(burndown.querySelector("[data-crosshair]")!.hasAttribute("data-bare")).toBe(true);
    expect(tipText(burndown)).toEqual(["5 Nov · 43 DTE", "no Cost to close: no two-sided quote to price it"]);
    expect(said(burndown)).toBe("5 Nov · 43 DTE · no Cost to close: no two-sided quote to price it");
    expect(tipText(iv)[1]).toBe("−C7300 12.75%");
  });

  it("says a leg with no IV that day as such, beside the legs that have one", async () => {
    const days = SAMPLES["h-calls"]!.samples.map((s) => (s.observed_on !== "2026-11-09" ? s
      : { ...s, legs_iv: { "US.SPXW261218C7300000": 14 } }));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { iv } = await panelsOf();
    hover(iv, xOf(iv, 39));
    expect(tipText(iv)).toEqual(["9 Nov · 39 DTE", "−C7300 14.00%", "+C7350 no IV"]);
  });

  it("keeps privacy's promise: no $ in any readout, the burndown's in points per contract", async () => {
    const { iv, spx, burndown, all } = await panelsOf("h-calls", "1218_C7300", { privacy: true });
    for (const key of ["Home", "End"]) {
      fireEvent.keyDown(keysOf(iv), { key });
      for (const panel of [iv, spx]) {
        expect(tipOf(panel)!.textContent).not.toMatch(/\$/);
        expect(said(panel)).not.toMatch(/\$/);
      }
      expect(tipOf(burndown)!.textContent).not.toMatch(/\$/);
      expect(all.map(crossed).every((c) => c !== undefined)).toBe(true);
    }
    expect(said(burndown)).toBe("valued now, 38 DTE: to close, per contract: 4.40 pts");
    // IV in %, SPX and the strikes in points, as with privacy off
    expect(said(iv)).toMatch(/no IV in the history/);
    expect(said(spx)).toMatch(/SPX now 6900\.50 · C7300 399\.50 pts/);
  });

  it("chooses on a tap in any panel, and lets go only on a tap outside all three", async () => {
    const { burndown, iv, spx, all } = await panelsOf();
    const tap = (panel: HTMLElement, x: number) => {
      fireEvent.pointerDown(svgOf(panel), { clientX: x, clientY: 50, pointerType: "touch" });
      fireEvent.pointerUp(svgOf(panel), { clientX: x, clientY: 50, pointerType: "touch" });
      fireEvent.click(svgOf(panel), { clientX: x, clientY: 50 });
    };
    tap(spx, Number(burndown.querySelector("[data-sample='2026-11-06'] circle")!.getAttribute("cx")));
    expect(all.map(crossed)).toEqual(["2026-11-06", "2026-11-06", "2026-11-06"]);
    // a tap in another panel is no tap outside: it moves the day
    tap(iv, xOf(iv, 40));
    expect(all.map(crossed)).toEqual(["2026-11-08", "2026-11-08", "2026-11-08"]);
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(all.map(crossed)).toEqual([undefined, undefined, undefined]);
  });

  it("draws the IV and SPX crosshairs at the burndown's x for the day", async () => {
    const { burndown, iv, spx } = await panelsOf();
    fireEvent.keyDown(keysOf(burndown), { key: "Home" });
    fireEvent.keyDown(keysOf(burndown), { key: "ArrowRight" });
    const rule = (panel: HTMLElement) => Number(panel.querySelector("[data-crosshair] line")!.getAttribute("x1"));
    const day = Number(burndown.querySelector("[data-sample='2026-11-04'] circle")!.getAttribute("cx"));
    expect([rule(burndown), rule(iv), rule(spx)]).toEqual([day, day, day]);
  });

  it("keeps only the panel being driven live: one key, one announcement (#399's review)", async () => {
    const { all } = await panelsOf();
    const live = () => all.map((p) => within(p).getByRole("status").getAttribute("aria-live"));
    for (const [i, panel] of all.entries()) {
      fireEvent.keyDown(keysOf(panel), { key: "ArrowRight" });
      expect(live()).toEqual(all.map((_, j) => (j === i ? "polite" : "off")));
    }
    // a pointer drives too
    hover(all[1]!, Number(all[0]!.querySelector("[data-sample='2026-11-05'] circle")!.getAttribute("cx")));
    expect(live()).toEqual(["off", "polite", "off"]);
  });

  it("says a costless day has no Cost to close and nothing about the hours that contradicts it", async () => {
    // a Saturday's row at 11:00 New York (#380): the sweep's hours run every calendar day, but no
    // leg has a two-sided quote on a weekend, so the day is kept for its vol with no price
    const days = SAMPLES["h-calls"]!.samples.map((s) => (s.observed_on !== "2026-11-07" ? s
      : { ...s, cost_to_close: null, timing: "close" as const, observed_at: "2026-11-08 00:00:00+08:00" }));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { burndown, iv, all } = await panelsOf();
    hover(iv, xOf(iv, 41));
    expect(all.map(crossed)).toEqual(["2026-11-07", "2026-11-07", "2026-11-07"]);
    expect(said(burndown)).toBe("7 Nov · 41 DTE · no Cost to close: no two-sided quote to price it");
    expect(tipText(burndown)).toEqual(["7 Nov · 41 DTE", "no Cost to close: no two-sided quote to price it"]);
    expect(burndown.textContent).not.toMatch(/hours/);
  });

  it("has no 'now' stop outside the session, where the valuation is the latest close restated", async () => {
    const closed = HOLDINGS.map((h) => (h.id !== "h-calls" ? h
      : { ...h, valued_from: "close", valued_on: "2026-11-09", valued_timing: "close" }) as Holding);
    const { burndown, spx, all } = await panelsOf("h-calls", "1218_C7300", { holdings: closed });
    fireEvent.keyDown(keysOf(spx), { key: "End" });
    expect(all.map(crossed)).toEqual(["2026-11-09", "2026-11-09", "2026-11-09"]);
    // neither the burndown's diamond nor SPX's: they would draw the 9th's close again at today's DTE
    expect(burndown.querySelector("[data-now]")).toBeNull();
    expect(spx.querySelector("[data-spx-now]")).toBeNull();
    expect(said(spx)).not.toMatch(/now/);
  });

  it("names on its keys' group how many stops they step: every recorded day, and the valuation", async () => {
    const days = SAMPLES["h-calls"]!.samples.map((s) => (s.observed_on === "2026-11-05" ? { ...s, cost_to_close: null } : s));
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { burndown } = await panelsOf();
    expect(keysOf(burndown).getAttribute("aria-label")).toMatch(/^cost to close by day, 7 days and today's valuation/);
  });

  it("reaches today's valuation with a pointer where today's sample shares its x, in session", async () => {
    // a sample written today at 38 DTE, and the live valuation at 38 DTE: one x, two stops
    const days = [...SAMPLES["h-calls"]!.samples, { ...SAMPLES["h-calls"]!.samples.at(-1)!, observed_on: "2026-11-10", dte: 38 }];
    serveSamples({ ...SAMPLES["h-calls"]!, samples: days });
    const { burndown, all } = await panelsOf();
    const x = Number(burndown.querySelector("[data-sample='2026-11-10'] circle")!.getAttribute("cx"));
    hover(burndown, x);
    expect(all.map(crossed)).toEqual(["now", "now", "now"]);
    // and the keys still reach the day before it
    fireEvent.keyDown(keysOf(burndown), { key: "ArrowLeft" });
    expect(all.map(crossed)).toEqual(["2026-11-10", "2026-11-10", "2026-11-10"]);
  });
});
