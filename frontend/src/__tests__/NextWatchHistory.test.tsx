/** The watchlist's history (#402): a watched row's daily closes drawn as a holding's history is — its
 *  value against its price rule's threshold and its legs' IV, on one crosshair — the days a holding was watched before it was entered drawn faint in its burndown, and
 *  a watched spread's payoff drawn at its last close where it has no live price.
 *
 *  Behaviour only — what is asked for, what is drawn from what was served, what it is called. That
 *  the charts FIT, at desk width and on the iPhone, is the browser suite's. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entry, Samples, WatchSamples } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { HistoryOnDemand } from "../HistoryOnDemand";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, SAMPLES, volAnswer } from "../testing/ownerBook";
import { until } from "../testing/until";
import {
  closeWords, entryCloseDay, payoffAt, thresholdOf, watchedCharted, watchedSamples, withBeforeEntry,
} from "../watchhistory";

const SHORT = "US.SPXW261218P7150000";
const LONG = "US.SPXW261218P7100000";

/** A watched day as the service serves it: its price under the rule's signs. */
function day(on: string, dte: number, price: number | null, over: Partial<WatchSamples["samples"][number]> = {}) {
  return {
    observed_on: on, observed_at: `${on} 05:14:00+08:00`, timing: "close" as const, dte, price,
    legs_iv: { [SHORT]: 18.5, [LONG]: 19.25 }, legs_vega: null, legs_delta: null, spx: 7100,
    ...over,
  };
}

const RULE = { id: "w-dec18", threshold: 4.51, direction: "above", compare: "abs" };
const SERVED: WatchSamples = {
  contracts: [LONG, SHORT],
  price_rule: RULE,
  samples: [day("2026-11-10", 38, -2.25), day("2026-11-11", 37, null), day("2026-11-12", 36, -2.75)],
};

let asked: string[] = [];
let watch: WatchSamples | null = SERVED;
let holdingSamples: Samples | null = null;

beforeEach(() => {
  asked = [];
  watch = SERVED;
  holdingSamples = null;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
    const body = /^\/monitors\/[^/]+\/samples$/.test(path) ? watch
      : /^\/positions\/[^/]+\/samples$/.test(path) ? holdingSamples
        : payoffAnswer(path) ?? volAnswer(path);
    return Promise.resolve(body
      ? { ok: true, status: 200, json: () => Promise.resolve(body) }
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const watched = (id: string) => QUOTES.find((q) => q.id === id)!;

describe("a watched row's days, as the history's charts draw them", () => {
  it("draws each day's price as its rule compares it: its size under abs", () => {
    expect(watchedSamples(SERVED).samples.map((s) => s.cost_to_close)).toEqual([2.25, null, 2.75]);
    expect(thresholdOf(SERVED)).toBe(4.51);
  });

  it("draws the figure itself under a signed rule, and its threshold as set", () => {
    const signed = { ...SERVED, price_rule: { ...RULE, compare: "signed", threshold: -3 } };
    expect(watchedSamples(signed).samples.map((s) => s.cost_to_close)).toEqual([-2.25, null, -2.75]);
    expect(thresholdOf(signed)).toBe(-3);
  });

  it("draws the price's size, and no threshold, where no rule watches the price", () => {
    const none = { ...SERVED, price_rule: null };
    expect(watchedSamples(none).samples.map((s) => s.cost_to_close)).toEqual([2.25, null, 2.75]);
    expect(thresholdOf(none)).toBeNull();
    // no schedule before an entry: no plan, no Levels, no On-pace
    expect(watchedSamples(none)).toMatchObject({ levels: null, plan: [], before_entry: [] });
  });

  it("draws a watched spread as a holding of one, minus short", () => {
    expect(watchedCharted(watched("w-dec18"))).toEqual({
      id: "w-dec18", contracts: 1, strike_date: "2026-12-18", closed_on: null,
      legs: [{ side: "short", option_type: "PUT", strike: 7150 }, { side: "long", option_type: "PUT", strike: 7100 }],
    });
  });

  it("draws a single contract as the strike it watches, read from its code", () => {
    expect(watchedCharted(watched("w-lone")).legs).toEqual([{ side: "short", option_type: "CALL", strike: 8000 }]);
  });
});

describe("a holding's days before entry (#402)", () => {
  const own = SAMPLES["h-calls"]!;
  const earlier = (on: string, days: number) =>
    new Date(Date.parse(`${on}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const first = own.samples[0]!;
  const before = [2, 1].map((back) => ({ ...first, observed_on: earlier(first.observed_on, back), dte: first.dte + back }));

  it("draws them before the holding's own days", () => {
    const merged = withBeforeEntry({ ...own, before_entry: before });
    expect(merged.samples.slice(0, 2)).toEqual(before);
    expect(merged.samples.length).toBe(own.samples.length + 2);
  });

  it("never draws a day the holding has a sample of its own as the watch's", () => {
    const merged = withBeforeEntry({ ...own, before_entry: [own.samples[0]!] });
    expect(merged.samples).toEqual(own.samples);
    expect(merged.before_entry).toEqual([]);
  });
});

describe("the entry day's watched close (#402)", () => {
  const own = SAMPLES["h-calls"]!;
  const first = own.samples[0]!;
  const costless = { ...own, samples: own.samples.map((s, i) => (i === 0 ? { ...s, cost_to_close: null, timing: "after-close" as const } : s)) };
  const entry = { ...first, cost_to_close: 1.95, timing: "close" as const, observed_at: `${first.observed_on} 05:14:00+08:00`, on_pace: null };

  it("is drawn as the entry day's point where its own row that day has no Cost to close", () => {
    const merged = withBeforeEntry({ ...costless, entry_close: entry });
    expect(merged.samples[0]).toMatchObject({ observed_on: first.observed_on, cost_to_close: 1.95, timing: "close" });
    // the day's other figures are its own row's
    expect(merged.samples[0]!.legs_iv).toEqual(first.legs_iv);
    expect(entryCloseDay(merged)).toBe(first.observed_on);
  });

  it("never replaces a cost the holding's own row has", () => {
    const merged = withBeforeEntry({ ...own, entry_close: entry });
    expect(merged.samples[0]!.cost_to_close).toBe(first.cost_to_close);
  });

  it("says whose close it is, in the burndown", async () => {
    holdingSamples = { ...costless, entry_close: entry };
    const h = HOLDINGS.find((x) => x.id === "h-calls")!;
    render(<HistoryOnDemand holding={h} defaultOpen />);
    const chart = await screen.findByRole("group", { name: "burndown" });
    await waitFor(() => expect(chart.querySelector("[data-entry-close]")).toBeTruthy());
    fireEvent.keyDown(chart.querySelector(".nx-bd")!, { key: "Home" });
    await until(() => expect(within(chart).getByRole("status").textContent).toContain("the close, watched before entry"));
  });
});

describe("what a watched spread's payoff is drawn at", () => {
  const close = { price: -2.75, observed_on: "2026-11-13", observed_at: "2026-11-14 05:14:00+08:00", timing: "close" as const };
  const spread = { ...watched("w-dec18"), last_close: close } as Entry;

  it("is its live value in the session", () => {
    expect(payoffAt(spread, true, true)).toEqual({ value: -2.4, from: "live" });
  });

  it("is ALWAYS its last close out of the session, though a value is quoted overnight", () => {
    expect(payoffAt(spread, false, true)).toEqual({ value: -2.75, from: "close", close });
  });

  it("is its last close in the session where the rule watches no price", () => {
    expect(payoffAt({ ...spread, field: "option_delta", combo_value: -0.12 } as Entry, true, false))
      .toEqual({ value: -2.75, from: "close", close });
  });

  it("is nothing, with the reason, where neither is there", () => {
    const bare = { ...spread, last_close: null } as Entry;
    expect(payoffAt(bare, false, true)).toEqual({ value: null, blank: "no close recorded to draw it at" });
    expect(payoffAt({ ...bare, combo_value: null } as Entry, true, true))
      .toEqual({ value: null, blank: "no current value to draw it at" });
  });

  it("calls a reading a close only where it was one", () => {
    expect(closeWords(close)).toBe("its close");
    expect(closeWords({ ...close, timing: "after-close" })).toBe("its reading after the close");
    expect(closeWords({ ...close, timing: "weekend" })).toBe("its weekend reading");
  });
});

describe("a watched row's history, drawn", () => {
  const open = (entry: Entry) => render(<HistoryOnDemand watched={entry} defaultOpen />);

  it("asks for its closes once, by the rule's id, and draws a point for each day with a price", async () => {
    open(watched("w-dec18"));
    const chart = await screen.findByRole("group", { name: "value against the threshold" });
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(2));
    expect(asked).toEqual(["GET /monitors/w-dec18/samples"]);
    expect(within(chart).getByText(/points value, per contract/)).toBeTruthy();
  });

  it("draws its price rule's threshold across its value, in points", async () => {
    open(watched("w-dec18"));
    const chart = await screen.findByRole("group", { name: "value against the threshold" });
    await waitFor(() => expect(chart.querySelector("[data-level='threshold']")).toBeTruthy());
    expect(chart.querySelector("[data-level='threshold'] text")?.textContent).toBe("threshold 4.51");
    // nothing of a holding's: no plan, no Target, no Stop
    expect(chart.querySelector("[data-plan], [data-level='target'], [data-level='stop']")).toBeNull();
  });

  it("draws no threshold where no rule watches the price", async () => {
    watch = { ...SERVED, price_rule: null };
    open(watched("w-dec18"));
    const chart = await screen.findByRole("group", { name: "value" });
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]")).toHaveLength(2));
    expect(chart.querySelector("[data-level='threshold']")).toBeNull();
  });

  it("draws its legs' IV on the same crosshair, and no SPX panel", async () => {
    open(watched("w-dec18"));
    const iv = await screen.findByRole("group", { name: "IV by leg" });
    expect(iv.querySelectorAll("[data-leg]")).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "SPX against the strikes" })).toBeNull();
    // a day pointed at in one panel is crossed in both
    const chart = screen.getByRole("group", { name: "value against the threshold" });
    fireEvent.keyDown(chart.querySelector(".nx-bd")!, { key: "End" });
    await waitFor(() => expect(iv.querySelector("[data-crosshair='2026-11-12']")).toBeTruthy());
    expect(within(chart).getByRole("status").textContent).toMatch(/^20261112 · 36 DTE · value: 2\.75/);
  });

  it("says so when nothing has been recorded yet", async () => {
    watch = { ...SERVED, samples: [] };
    open(watched("w-dec18"));
    expect(await screen.findByText(/no daily closes recorded yet/)).toBeTruthy();
  });
});

describe("a holding's burndown with the days it was watched before entry", () => {
  const own = SAMPLES["h-calls"]!;
  const first = own.samples[0]!;
  const watchDay = (back: number) => ({
    ...first, observed_on: new Date(Date.parse(`${first.observed_on}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10),
    dte: first.dte + back, on_pace: null, cost_to_close: 2.1 + back / 10,
  });

  it("draws them faint, before an 'entered' rule, and says what they are", async () => {
    holdingSamples = { ...own, before_entry: [watchDay(2), watchDay(1)] };
    const h = HOLDINGS.find((x) => x.id === "h-calls")!;
    render(<HistoryOnDemand holding={h} defaultOpen />);
    const chart = await screen.findByRole("group", { name: "burndown" });
    await waitFor(() => expect(chart.querySelectorAll("[data-before-entry]")).toHaveLength(2));
    expect(chart.querySelector("[data-costs='before-entry']")).toBeTruthy();
    expect(chart.querySelector("[data-entered]")).toBeTruthy();
    expect(within(chart).getByRole("status").textContent).toContain("faint: before entry, while watched");
    fireEvent.keyDown(chart.querySelector(".nx-bd")!, { key: "Home" });
    await until(() => expect(within(chart).getByRole("status").textContent).toContain("before entry: watched, not yet held"));
    // the IV chart and SPX's path draw them faint too
    const iv = screen.getByRole("group", { name: "IV by leg" });
    expect(iv.querySelector("circle[data-before-entry]")).toBeTruthy();
  });

  it("draws none, and no rule, for a holding never watched", async () => {
    holdingSamples = own;
    const h = HOLDINGS.find((x) => x.id === "h-calls")!;
    render(<HistoryOnDemand holding={h} defaultOpen />);
    const chart = await screen.findByRole("group", { name: "burndown" });
    await waitFor(() => expect(chart.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
    expect(chart.querySelector("[data-before-entry], [data-entered]")).toBeNull();
  });
});

describe("a watched spread's payoff at its last close", () => {
  // the close below is Fri 2026-11-13, and the page writes a close inside the week by its weekday
  // alone ("Fri 16:14 ET") and an older one with its date: read against the real clock, these two
  // tests passed only until 2026-11-19. Pinned to the Monday after, only the Date faked.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T15:00:00Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  function props(over: Partial<BookProps> = {}): BookProps {
    return {
      quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
      session: true, privacy: false, entryStyle: "opportunity", ...over,
    };
  }
  const close = { price: -4.12, observed_on: "2026-11-13", observed_at: "2026-11-14 05:14:00+08:00", timing: "close" as const };
  const deskRow = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
  async function payoffOf(quotes: Entry[], session: boolean) {
    render(<DeskBook {...props({ quotes, session })} />);
    fireEvent.click(within(deskRow("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_P7150" });
    const payoff = await within(insp).findByRole("group", { name: "payoff at expiry" });
    await until(() => expect(within(payoff).queryByText("drawing…")).toBeNull());
    return payoff;
  }

  it("draws a spread watched on its delta at its close, said with its time", async () => {
    const quotes = QUOTES.map((q) => (q.id === "w-dec18"
      ? { ...q, field: "option_delta", combo_value: -0.12, last_close: close } : q) as Entry);
    const payoff = await payoffOf(quotes, true);
    expect(within(payoff).getByText("no Entry: drawn at its close, Fri 16:14 ET, 4.12, as the credit")).toBeTruthy();
    expect(asked.filter((a) => a.startsWith("POST"))[0]).toContain('"entry":4.12');
  });

  it("draws at its close out of the session, never at a value quoted out of it", async () => {
    const quotes = QUOTES.map((q) => (q.id === "w-dec18" ? { ...q, last_close: close } : q) as Entry);
    const payoff = await payoffOf(quotes, false);
    expect(within(payoff).getByText(/drawn at its close, Fri 16:14 ET, 4\.12/)).toBeTruthy();
    expect(asked.filter((a) => a.startsWith("POST")).every((a) => a.includes('"entry":4.12'))).toBe(true);
  });

  it("draws at its live value in the session", async () => {
    const quotes = QUOTES.map((q) => (q.id === "w-dec18" ? { ...q, last_close: close } : q) as Entry);
    const payoff = await payoffOf(quotes, true);
    expect(within(payoff).getByText("no Entry: drawn at its current value, 2.40, as the credit")).toBeTruthy();
  });
});
