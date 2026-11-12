/** The burndown and the IV chart in REVIEW (#295, ADR 0023): in the desk's inspector and as the main
 *  chart of the phone's one-holding page, drawn from `/positions/{id}/samples`. Behaviour only —
 *  what is asked for and when, what is drawn from what was served, what an off-close point says
 *  and what privacy hides. That the charts FIT is measured by the browser suite. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Holding, Samples } from "../api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, SAMPLES, samplesAnswer } from "../testing/ownerBook";

/** Every request the page made, as `METHOD path`. */
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const body = samplesAnswer(path) ?? payoffAnswer(path);
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
    mode: "review", privacy: false, entryStyle: "opportunity", ...over,
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
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer(path)) });
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

/** The x and y of each point a path or polyline joins. */
function corners(el: Element | null): [number, number][] {
  const text = el?.getAttribute("d") ?? el?.getAttribute("points") ?? "";
  return [...text.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("the burndown, in the desk's inspector in REVIEW", () => {
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
    fireEvent.mouseEnter(evening);
    const said = within(chart).getByRole("status");
    expect(said.textContent).toMatch(/3 Nov · 45 DTE/);
    expect(said.textContent).toMatch(/not the close: observed after 16:15 New York \(2026-11-04 09:30:00\+08:00\)/);
    // and a native tooltip, for a pointer that rests on it
    expect(evening.querySelector("title")?.textContent).toMatch(/not the close/);
  });

  it("says what an overnight fill and a row from before observed times are", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300");
    const chart = await burndownOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    fireEvent.mouseEnter(chart.querySelector("[data-sample][data-timing='before-open']")!);
    expect(within(chart).getByRole("status").textContent).toMatch(/not the close: observed before 09:30 New York/);
    fireEvent.mouseEnter(chart.querySelector("[data-sample][data-timing='unrecorded']")!);
    expect(within(chart).getByRole("status").textContent).toMatch(/whether it was the close is not known/);
  });

  it("hides the $ axis and every $ figure under privacy, and keeps the shape", async () => {
    const shown = await inspect("h-calls", "1218_C7300");
    const before = await burndownOf(shown.insp);
    await waitFor(() => expect(before.querySelector("[data-costs]")).toBeTruthy());
    const shape = corners(before.querySelector("[data-costs]"));
    expect(before.querySelector("[data-axis='y']")?.textContent).toMatch(/\$/);
    cleanup();

    const hidden = await inspect("h-calls", "1218_C7300", { privacy: true });
    const chart = await burndownOf(hidden.insp);
    await waitFor(() => expect(chart.querySelector("[data-costs]")).toBeTruthy());
    // the same heights, and the same spacing across the width the plot has: only the value
    // axis's gutter is gone, since one as wide as its labels would say how many digits they hid
    const kept = corners(chart.querySelector("[data-costs]"));
    expect(kept.map(([, y]) => y)).toEqual(shape.map(([, y]) => y));
    const spacing = (pts: [number, number][]) =>
      pts.map(([x]) => (x - pts[0]![0]) / (pts.at(-1)![0] - pts[0]![0]));
    // to the drawing's own precision: each corner is written to a tenth of a pixel
    spacing(kept).forEach((f, i) => expect(f).toBeCloseTo(spacing(shape)[i]!, 2));
    expect(chart.querySelector("[data-axis='y']")).toBeNull();
    expect(chart.textContent).not.toMatch(/\$\d|\d\.\d\d/);
    fireEvent.mouseEnter(chart.querySelector("[data-sample]")!);
    expect(within(chart).getByRole("status").textContent).toMatch(/\$•••/);
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

  it("is not drawn in LIVE, which asks for no samples", async () => {
    const { insp } = await inspect("h-calls", "1218_C7300", { mode: "live" });
    await within(insp).findByRole("group", { name: "payoff at expiry" });
    expect(within(insp).queryByRole("group", { name: "burndown" })).toBeNull();
    expect(samplesAsked()).toEqual([]);
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

describe("the IV chart", () => {
  it("draws each leg's IV per day, named by its side and strike", async () => {
    const { insp } = await inspect("h-ic", "1231_IC");
    const chart = await ivOf(insp);
    await waitFor(() => expect(chart.querySelectorAll("[data-leg]")).toHaveLength(4));
    const legs = [...chart.querySelectorAll<SVGElement>("[data-leg]")];
    expect(legs.map((l) => l.querySelector("text")?.textContent)).toEqual(["−C7400", "+C7450", "−P6300", "+P6250"]);
    expect(legs.map((l) => corners(l.querySelector("polyline")).length)).toEqual([2, 2, 2, 2]);
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
    const runs = [...chart.querySelectorAll("[data-leg]")][0]!.querySelectorAll("polyline");
    expect([...runs].map((r) => corners(r).length)).toEqual([3, 3]);
  });
});

describe("on the phone's one-holding REVIEW page", () => {
  const draw = (over: Partial<BookProps> = {}) =>
    render(<div className="nx"><PhoneBook {...props(over)} /></div>);
  const page = (ref: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-page][data-ref]")].find((el) => el.dataset.ref === ref)!;

  it("is the page's main chart, read once per holding", async () => {
    draw();
    const chart = await burndownOf(page("h-calls"));
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    expect(await ivOf(page("h-calls"))).toBeTruthy();
    expect([...samplesAsked()].sort()).toEqual([
      "GET /positions/h-calls/samples", "GET /positions/h-ic/samples", "GET /positions/h-puts/samples",
    ]);
  });

  it("says why a point is not a close when it is tapped", async () => {
    draw();
    const chart = await burndownOf(page("h-calls"));
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(7));
    fireEvent.click(chart.querySelector("[data-sample][data-timing='before-open']")!);
    expect(within(chart).getByRole("status").textContent).toMatch(/not the close: observed before 09:30 New York/);
  });

  it("hides the $ axis under privacy", async () => {
    draw({ privacy: true });
    const chart = await burndownOf(page("h-calls"));
    await waitFor(() => expect(chart.querySelector("[data-costs]")).toBeTruthy());
    expect(chart.querySelector("[data-axis='y']")).toBeNull();
    expect(chart.textContent).not.toMatch(/\$\d/);
  });
});
