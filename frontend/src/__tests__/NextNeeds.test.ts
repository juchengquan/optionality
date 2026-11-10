/** The redesigned page's needs-you line (ADR 0012, amended by ADR 0023).
 *
 *  Two things are new against the line at `/opt`. A QUARANTINED rule is named as a fault: the
 *  service switched it off itself, so nothing is watching what it watched, and that used to be said
 *  only in a muted table at the foot of the page. And a fired rule on the WATCHLIST is an entry
 *  signal — a spread worth selling — not an alarm about something held, so it is its own kind.
 */
import { describe, expect, it } from "vitest";

import type { Entry, Health, Holding, Monitor } from "../api";
import { isEntrySignal, needsYou, sentence, toneOf } from "../next/needs";

const health = (over: Partial<{ ok: boolean; bad: boolean }> = {}) => ({
  db: true,
  provider: { name: "moomoo", ok: over.ok ?? true },
  monitor: { last_sweep_at: "x", alarms: { label: over.bad ? "stalled" : "active", bad: over.bad ?? false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
}) as unknown as Health;

function entry(over: Record<string, unknown>): Entry {
  return {
    id: "e1", code: "1218_7150P", strike_date: "2026-12-18", option_type: "CMB",
    field: "mid_price", threshold: 6.01, direction: "above", compare: "abs", triggered: false,
    quote: null, legs: [], combo_value: 2, dte: 38, scope: null, positions: [],
    cost_to_close: null, entry: null, pnl: null, fill: 33, schedule: null,
    watched: 2, distance: 4.01, in_combos: [],
    ...over,
  } as unknown as Entry;
}

function monitor(over: Record<string, unknown>): Monitor {
  return {
    id: "m9", code: "US.SPXW261211P6800000", strike_date: "2026-12-11", option_type: "PUT",
    strike: 6800, field: "option_delta", threshold: 0.2, direction: "above", compare: "abs",
    legs: null, enabled: false, scope: null, positions: [], disabled_reason: "no-figure",
    triggered: false, last_value: null, last_checked_at: null, created_at: null,
    ...over,
  } as unknown as Monitor;
}

describe("a quarantined rule is a fault", () => {
  it("names each rule the service switched off because it cannot evaluate it", () => {
    const items = needsYou([], [
      monitor({ id: "a", disabled_reason: "no-figure" }),
      monitor({ id: "b", code: "1211_8300", legs: [{ sign: -1, option_type: "CALL", strike: 8300 }],
        disabled_reason: "unknown-contract" }),
      monitor({ id: "c", disabled_reason: "unreadable" }),
    ], health(), null);
    expect(items.map((n) => n.kind)).toEqual(["fault", "fault", "fault"]);
    expect(items.map((n) => n.text)).toEqual([
      "261211 6800P delta quarantined — its figure never arrives",
      "1211_8300 spread delta quarantined — the provider does not know its contract",
      "261211 6800P delta quarantined — its stored row cannot be read",
    ]);
  });

  it("tells two quarantined rules on one contract apart by what each watches", () => {
    const items = needsYou([], [
      monitor({ id: "a", field: "option_delta" }),
      monitor({ id: "b", field: "mid_price" }),
    ], health(), null);
    expect(items.map((n) => n.text)).toEqual([
      "261211 6800P delta quarantined — its figure never arrives",
      "261211 6800P mid quarantined — its figure never arrives",
    ]);
  });

  it("says nothing of a rule muted by hand, expired, or switched off by closing its holding", () => {
    const items = needsYou([], [
      monitor({ disabled_reason: "manual" }),
      monitor({ disabled_reason: "expired" }),
      monitor({ disabled_reason: "holding-closed" }),
      monitor({ disabled_reason: null }),
    ], health(), null);
    expect(items).toEqual([]);
  });

  it("does not name an enabled rule whatever its reason column says", () => {
    expect(needsYou([], [monitor({ enabled: true })], health(), null)).toEqual([]);
  });
});

describe("a fired rule on the watchlist is an entry signal, not an alarm", () => {
  it("calls a rule that watches nothing held an entry signal", () => {
    expect(isEntrySignal(entry({ positions: [] }))).toBe(true);
    expect(isEntrySignal(entry({ positions: [{ id: "p1", name: "1218_7150P" }] }))).toBe(false);
  });

  it("files a fired watchlist rule as an entry and a fired holding rule as an alarm", () => {
    const items = needsYou([
      entry({ id: "w", code: "1218_7150P", triggered: true }),
      entry({ id: "h", code: "1218_7700C", triggered: true,
        positions: [{ id: "p1", name: "1218_7700C" }] }),
    ], [], health(), null);
    expect(items).toEqual([
      { kind: "alarm", text: "1218_7700C ringing", ref: "h" },
      { kind: "entry", text: "1218_7150P entry signal", ref: "w" },
    ]);
  });
});

describe("worst first", () => {
  it("leads with faults, then a stop, an alarm, an entry signal, a target, a manage-by", () => {
    const sched = (o: Record<string, unknown>) => ({ reached: null, manage_by_due: false, position_id: "p", ...o });
    const items = needsYou([
      entry({ id: "1", code: "M", schedule: sched({ manage_by_due: true }), positions: [{ id: "p", name: "M" }] }),
      entry({ id: "2", code: "T", schedule: sched({ reached: "target" }), positions: [{ id: "p", name: "T" }] }),
      entry({ id: "3", code: "E", triggered: true }),
      entry({ id: "4", code: "A", triggered: true, positions: [{ id: "p", name: "A" }] }),
      entry({ id: "5", code: "S", schedule: sched({ reached: "stop" }), positions: [{ id: "p", name: "S" }] }),
    ], [monitor({})], health({ ok: false }), null);
    expect(items.map((n) => n.kind)).toEqual(
      ["fault", "fault", "stop", "alarm", "entry", "target", "manage"]);
    expect(items[0]!.text).toBe("moomoo down — the figures are stale");
  });

  it("says the alarm engine is unhappy, and a row whose contract is unknown", () => {
    const items = needsYou([entry({ code: "X", error: "unknown contract" })], [], health({ bad: true }), null);
    expect(items.map((n) => n.text)).toEqual(["alarms stalled", "X — unknown contract"]);
  });
});

describe("holdings, when the page has them", () => {
  const holding = (o: Record<string, unknown>) => ({
    id: "p2", name: "1231_7000P", schedule: { reached: null, manage_by_due: false }, ...o,
  }) as unknown as Holding;

  it("adds a holding's Level that no row spoke for", () => {
    const items = needsYou([], [], health(), [holding({ schedule: { reached: "target", manage_by_due: false } })]);
    expect(items).toEqual([{ kind: "target", text: "1231_7000P at target", ref: "p2" }]);
  });

  it("does not say a holding twice when its rule's row already did", () => {
    const items = needsYou([
      entry({ code: "1231_7000P", positions: [{ id: "p2", name: "1231_7000P" }],
        schedule: { reached: "stop", manage_by_due: false, position_id: "p2" } }),
    ], [], health(), [holding({ schedule: { reached: "stop", manage_by_due: false } })]);
    expect(items.map((n) => n.text)).toEqual(["1231_7000P at stop"]);
  });
});

describe("a rule said as a sentence", () => {
  it("says what it watches, against what, where it is now and how far it has to go", () => {
    expect(sentence(entry({ compare: "signed" }))).toBe("spread value ≥ 6.01 — now 2.00, 4.01 away");
  });

  it("marks a rule that compares the size of its figure, and shows the figure as it is", () => {
    // a credit spread summed with the short leg negative is a negative figure; under compare abs
    // the bell, the bar and the distance all compare its size, which the bars say without the
    // page computing an absolute value of its own (ADR 0005)
    expect(sentence(entry({ watched: -2, distance: 4.01 })))
      .toBe("|spread value| ≥ 6.01 — now -2.00, 4.01 away");
  });

  it("names a single leg's figure and keeps the digits a delta needs", () => {
    expect(sentence(entry({ legs: undefined, field: "option_delta", threshold: 0.2,
      watched: -0.1684, distance: 0.0316 }))).toBe("|delta| ≥ 0.2 — now -0.168, 0.032 away");
  });

  it("writes a signed comparison without the bars", () => {
    expect(sentence(entry({ legs: undefined, field: "option_delta", threshold: -0.3,
      direction: "below", compare: "signed", watched: -0.25, distance: 0.05 })))
      .toBe("delta ≤ -0.3 — now -0.250, 0.050 away");
  });

  it("says a breached rule is past its threshold, or at it", () => {
    expect(sentence(entry({ watched: 6.2, distance: -0.19 })))
      .toBe("|spread value| ≥ 6.01 — now 6.20, past it by 0.19");
    expect(sentence(entry({ watched: 6.01, distance: 0 })))
      .toBe("|spread value| ≥ 6.01 — now 6.01, at the threshold");
  });

  it("says when there is no figure rather than printing a stale one", () => {
    expect(sentence(entry({ watched: null, distance: null })))
      .toBe("|spread value| ≥ 6.01 — no figure");
  });
});

describe("the line's tone is its worst item's", () => {
  const n = (kind: string) => ({ kind, text: kind }) as never;
  it("is bad for a fault, a stop or an alarm", () => {
    for (const k of ["fault", "stop", "alarm"]) expect(toneOf([n("target"), n(k)], false)).toBe("bad");
  });

  it("is a warning for a manage-by, which is a deadline and not good news", () => {
    expect(toneOf([n("manage")], false)).toBe("warn");
    expect(toneOf([n("target"), n("manage")], false)).toBe("warn");
  });

  it("is good for an entry signal or a Target, unless entries are to look like risk", () => {
    expect(toneOf([n("entry"), n("target")], false)).toBe("good");
    expect(toneOf([n("entry")], true)).toBe("bad");
  });
});
