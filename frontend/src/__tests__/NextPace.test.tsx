/** The pace explained (#333, ADR 0011): the gap in words wherever `/opt/next` shows it, and in the
 *  desk's inspector and the phone's holding detail the DTE at open, the √T working, the target on
 *  decay alone and the split of the gap that `/positions/{id}/vol` serves — read once when a
 *  holding is opened, never polled, and never shown under another holding.
 *
 *  Every figure is the service's. The split's gap is the one at the last close (the route's `gap`),
 *  which the fixtures keep apart from the schedule's live `pace_gap`, so a page that split the live
 *  gap itself would say other figures than these. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Holding, Vol } from "../api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer, VOLS } from "../testing/ownerBook";

/** Every request the page made, as `METHOD path`. */
let asked: string[] = [];
/** answers held back by path, released by the test: how a slow `/vol` is made */
let held: Map<string, (body: Vol) => void>;
let holdBack: RegExp | null;
/** a holding's split served in place of the owner's book's */
let volOver: Record<string, Vol>;

beforeEach(() => {
  asked = [];
  held = new Map();
  holdBack = null;
  volOver = {};
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (holdBack?.test(path)) {
      return new Promise((resolve) => { held.set(path, (body) => resolve(ok(body))); });
    }
    // every route the inspector and the sheet read, answered by name: the vol split, the payoff
    // and the samples
    const over = /^\/positions\/([^/]+)\/vol$/.exec(path)?.[1];
    const body = (over ? volOver[over] : undefined) ?? volAnswer(path) ?? payoffAnswer(path) ?? samplesAnswer(path);
    return Promise.resolve(body ? ok(body)
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A schedule as `/positions/values` serves it, with a live gap that is not the split's. */
const schedule = (pace_gap: number | null) => ({
  dte_at_open: 45, on_pace: 1.84, pace_gap, target: 1, stop: 4, target_dte: 11, manage_by_dte: 21,
  reached: null, manage_by_due: false,
});
const GAPS: Record<string, number> = { "h-puts": -0.5, "h-calls": 0.47 };
/** the condor's two spreads scheduled; the 4-leg condor with no Opened, so no schedule */
const scheduled: Holding[] = HOLDINGS.map((h) =>
  h.id in GAPS ? { ...h, schedule: schedule(GAPS[h.id]!) } : h);

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: scheduled, holdingsError: null, holdingsAt: null,
    mode: "review", privacy: false, entryStyle: "opportunity", ...over,
  };
}

const volAsked = () => asked.filter((a) => a.endsWith("/vol"));
const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const paceCell = (id: string) => deskRow(id).querySelector<HTMLElement>('[data-col="pace_gap"] .nxd-v');

function inspect(id: string, name: string) {
  fireEvent.click(within(deskRow(id)).getByRole("button", { name }));
  return screen.getByRole("complementary", { name: `inspector: ${name}` });
}
const paceOf = (root: HTMLElement) => within(root).getByRole("region", { name: "the pace explained" });
const splitOf = async (root: HTMLElement) => {
  const pace = paceOf(root);
  await waitFor(() => expect(pace.querySelector("[data-split]")).toBeTruthy());
  return pace.querySelector<HTMLElement>("[data-split]")!;
};

describe("the gap in words, in the desk's REVIEW columns", () => {
  it("says behind or ahead and by how much, in the outcome colour, and a dash without a schedule", () => {
    render(<DeskBook {...props()} />);
    expect(paceCell("h-calls")?.textContent).toBe("behind by 0.47");
    expect(paceCell("h-calls")?.dataset.outcome).toBe("loss");
    expect(paceCell("h-puts")?.textContent).toBe("ahead by 0.50");
    expect(paceCell("h-puts")?.dataset.outcome).toBe("gain");
    expect(paceCell("h-ic")?.textContent).toBe("—");
  });
});

describe("the pace explained, in the desk's inspector", () => {
  it("says the DTE at open, the gap in words, the √T working and the target on decay alone", async () => {
    render(<DeskBook {...props()} />);
    const insp = inspect("h-puts", "1218_P6400");
    const pace = paceOf(insp);
    expect(pace.textContent).toContain("opened at 45 DTE");
    const gap = within(pace).getByText("ahead by 0.50");
    expect(gap.dataset.outcome).toBe("gain");
    // the served on-pace with its working in the row's own served figures: Entry, DTE and D₀
    expect(pace.textContent).toContain("on pace 1.84 = 2.00 × √(38 ÷ 45)");
    expect(within(pace).getByText("target on decay alone").nextElementSibling!.textContent).toBe("11 DTE");
    expect(pace.textContent).toMatch(/A shape, not a price/);
    await splitOf(insp);
  });

  it("splits the gap with the route's own figures, at the close they were measured to", async () => {
    render(<DeskBook {...props()} />);
    const split = await splitOf(inspect("h-puts", "1218_P6400"));
    // the route's gap (-0.42 at the 9 Nov close), not the schedule's live -0.50
    expect(split.textContent).toContain("at the 9 Nov close: ahead by 0.42");
    // vol 0.31 hurt and the rest -0.73 helped, as served: a page subtracting from the live gap
    // would say the rest saved 0.81
    expect(split.textContent).toContain("vol cost you 0.31 · the rest saved you 0.73");
    expect(split.textContent).toContain("over 6 days from 3 Nov · net vega -0.86");
    // the hypothetical is never shown beside a measurement
    expect(split.textContent).not.toMatch(/would cover/);
    expect(volAsked()).toEqual(["GET /positions/h-puts/vol"]);
  });

  it("says why the route cannot split it, in the route's words, and what would cover the gap", async () => {
    render(<DeskBook {...props()} />);
    const split = await splitOf(inspect("h-calls", "1218_C7300"));
    expect(split.textContent).toContain("at the 9 Nov close: behind by 2.27");
    expect(split.textContent).toContain(`vol cannot be split out: ${VOLS["h-calls"]!.reason}`);
    expect(split.textContent).toContain("1.82 vol points would cover this gap · net vega -1.25");
    expect(split.textContent).not.toMatch(/cost you|saved you/);
  });

  it("says the route's rest as served, and adds up nothing of its own", async () => {
    // figures no sum of the page's could reach: the rest is what the service said, whatever the
    // gap and the vol part beside it would make of it
    volOver["h-puts"] = { ...VOLS["h-puts"]!, rest: -0.5 };
    render(<DeskBook {...props()} />);
    const split = await splitOf(inspect("h-puts", "1218_P6400"));
    expect(split.textContent).toContain("vol cost you 0.31 · the rest saved you 0.50");
  });

  it("says nothing has moved on the day it was opened, rather than that vol cost nothing", async () => {
    volOver["h-puts"] = { vol: 0, from: "2026-11-09", to: "2026-11-09", days: 0,
      reason: "only 2026-11-09, the day it was Opened, is recorded: nothing has moved yet",
      at: "2026-11-09", gap: 0, rest: null, vega: -0.86, cover: 0 };
    render(<DeskBook {...props()} />);
    const split = await splitOf(inspect("h-puts", "1218_P6400"));
    expect(split.textContent).toContain(
      "vol cannot be split out: only 2026-11-09, the day it was Opened, is recorded: nothing has moved yet");
    expect(split.textContent).not.toMatch(/cost you|saved you/);
  });

  it("says no figure would cover a gap the route has none for", async () => {
    volOver["h-calls"] = { ...VOLS["h-calls"]!, vega: null, cover: null };
    render(<DeskBook {...props()} />);
    const split = await splitOf(inspect("h-calls", "1218_C7300"));
    expect(split.textContent).toContain("vol cannot be split out");
    expect(split.textContent).not.toMatch(/would cover|net vega/);
  });

  it("asks nothing and says nothing for a holding with no schedule", async () => {
    render(<DeskBook {...props()} />);
    const insp = inspect("h-ic", "1231_IC");
    expect(within(insp).queryByRole("region", { name: "the pace explained" })).toBeNull();
    await act(async () => {});
    expect(volAsked()).toEqual([]);
  });

  it("says the read failed, and keeps the rest of the explanation", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (path.endsWith("/vol")) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ detail: "internal error" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payoffAnswer(path) ?? samplesAnswer(path)) });
    }));
    render(<DeskBook {...props()} />);
    const pace = paceOf(inspect("h-puts", "1218_P6400"));
    await waitFor(() => expect(pace.textContent).toMatch(/what vol did could not be read/));
    expect(pace.textContent).toContain("opened at 45 DTE");
  });

  it.each(["live", "review"] as const)("reads it once and never polls it, in %s", async (mode) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<DeskBook {...props({ mode })} />);
    await splitOf(inspect("h-puts", "1218_P6400"));
    // the figures move as polls and refreshes deliver them, and time passes: nothing more is asked
    for (const pnl of [90, 80, 70]) {
      const moved = scheduled.map((h) => ({ ...h, pnl }));
      view.rerender(<DeskBook {...props({ mode, holdings: moved })} />);
      await act(async () => { vi.advanceTimersByTime(60_000); });
    }
    expect(volAsked()).toEqual(["GET /positions/h-puts/vol"]);
  });

  it("never shows one holding's split under another, whichever answer lands last", async () => {
    holdBack = /\/vol$/;
    render(<DeskBook {...props()} />);
    inspect("h-calls", "1218_C7300");
    const insp = inspect("h-puts", "1218_P6400");
    expect(volAsked()).toEqual(["GET /positions/h-calls/vol", "GET /positions/h-puts/vol"]);
    // the first holding's answer lands after the second was asked for: it lands nowhere
    await act(async () => { held.get("/positions/h-calls/vol")!(VOLS["h-calls"]!); });
    expect(paceOf(insp).querySelector("[data-split]")).toBeNull();
    expect(paceOf(insp).textContent).not.toMatch(/2\.27|1\.82/);
    await act(async () => { held.get("/positions/h-puts/vol")!(VOLS["h-puts"]!); });
    expect((await splitOf(insp)).textContent).toContain("ahead by 0.42");
  });

  it("never shows the last holding's split under the next while the next's is asked for", async () => {
    holdBack = /\/vol$/;
    render(<DeskBook {...props()} />);
    inspect("h-calls", "1218_C7300");
    await act(async () => { held.get("/positions/h-calls/vol")!(VOLS["h-calls"]!); });
    // the first holding's split arrived and was shown; the next one opened asks for its own
    const insp = inspect("h-puts", "1218_P6400");
    expect(paceOf(insp).querySelector("[data-split]")).toBeNull();
    expect(paceOf(insp).textContent).toMatch(/reading what vol did/);
  });

  it("keeps the shown holding's split when an older answer lands after it", async () => {
    holdBack = /\/vol$/;
    render(<DeskBook {...props()} />);
    inspect("h-calls", "1218_C7300");
    const insp = inspect("h-puts", "1218_P6400");
    await act(async () => { held.get("/positions/h-puts/vol")!(VOLS["h-puts"]!); });
    await act(async () => { held.get("/positions/h-calls/vol")!(VOLS["h-calls"]!); });
    expect((await splitOf(insp)).textContent).toContain("vol cost you 0.31");
  });

  it("says nothing a stranger could read under privacy: no money and no contract count", async () => {
    const seven = scheduled.map((h) => ({ ...h, contracts: 7 }));
    render(<DeskBook {...props({ privacy: true, holdings: seven })} />);
    const insp = inspect("h-puts", "1218_P6400");
    await splitOf(insp);
    const pace = paceOf(insp);
    // every figure in it is points per contract, so it is all kept and none of it is money
    expect(pace.textContent).not.toMatch(/\$|×7|7 contracts/);
    expect(pace.textContent).toContain("vol cost you 0.31");
  });
});

// ---- the phone

function drawPhone(over: Partial<BookProps> = {}) {
  return render(<div className="nx"><PhoneBook {...props({ mode: "live", ...over })} /></div>);
}
const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref)!;

describe("the pace explained, in the phone's holding detail", () => {
  it("says the gap in words in the exit schedule, and explains it beneath", async () => {
    drawPhone();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of 1218_C7300/ }));
    const sheet = await screen.findByRole("dialog");
    const gap = within(sheet).getByText("pace gap").nextElementSibling as HTMLElement;
    expect(gap.textContent).toBe("behind by 0.47");
    expect(gap.dataset.outcome).toBe("loss");
    const pace = paceOf(sheet);
    expect(pace.textContent).toContain("opened at 45 DTE");
    expect(pace.textContent).toContain("on pace 1.84 = 2.00 × √(38 ÷ 45)");
    expect(within(pace).getByText("target on decay alone").nextElementSibling!.textContent).toBe("11 DTE");
    const split = await splitOf(sheet);
    expect(split.textContent).toContain(`vol cannot be split out: ${VOLS["h-calls"]!.reason}`);
    expect(split.textContent).toContain("1.82 vol points would cover this gap");
  });

  it("reads it once per holding opened, and never under the next one", async () => {
    holdBack = /\/vol$/;
    drawPhone({ mode: "review" });
    const page = (id: string) => document.querySelector<HTMLElement>(`[data-page][data-ref="${id}"]`)!;
    fireEvent.click(within(page("h-calls")).getByRole("button", { name: "detail and Monitors" }));
    await screen.findByRole("dialog");
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(page("h-puts")).getByRole("button", { name: "detail and Monitors" }));
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(within(sheet).getByRole("heading", { name: "1218_P6400" })).toBeTruthy());
    await act(async () => { held.get("/positions/h-calls/vol")?.(VOLS["h-calls"]!); });
    expect(paceOf(sheet).textContent).not.toMatch(/2\.27|1\.82/);
    await act(async () => { held.get("/positions/h-puts/vol")!(VOLS["h-puts"]!); });
    expect((await splitOf(sheet)).textContent).toContain("vol cost you 0.31 · the rest saved you 0.73");
    expect(volAsked().filter((a) => a.includes("h-puts"))).toEqual(["GET /positions/h-puts/vol"]);
  });

  it("says the gap in words on each REVIEW page", () => {
    drawPhone({ mode: "review" });
    const page = document.querySelector<HTMLElement>('[data-page][data-ref="h-puts"]')!;
    const gap = within(page).getByText("pace gap").nextElementSibling as HTMLElement;
    expect(gap.textContent).toBe("ahead by 0.50");
    expect(gap.dataset.outcome).toBe("gain");
  });
});
