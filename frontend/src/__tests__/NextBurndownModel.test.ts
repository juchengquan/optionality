/** The burndown's arithmetic and words (#360), with no chart drawn: which day a pointer means, which
 *  day a key moves to, the value axis and where it puts a Stop it does not reach, where the tooltip
 *  goes, and what the tooltip and the status line say — with privacy on and off. What is DRAWN
 *  from these is `NextHistory.test.tsx`'s, and that it fits is the browser suite's. */
import { describe, expect, it } from "vitest";

import type { Sample, Samples } from "../shared/api";
import {
  nearestDay, sampleWords, stepDay, tipLines, tipPlace, valueAxis, type Unit,
} from "../next/burndown";

const money: Unit = { size: 100, contracts: 2, money: true, hidden: false };
const points: Unit = { size: 1, contracts: 2, money: false, hidden: false };
const hidden: Unit = { ...money, hidden: true };

const day = (over: Partial<Sample> = {}): Sample => ({
  observed_on: "2026-11-03", dte: 45, cost_to_close: 2.3, on_pace: 2.02, timing: "close",
  observed_at: "2026-11-04 05:00:00+08:00", legs_iv: null, legs_vega: null, legs_delta: null, spx: null,
  ...over,
} as Sample);

/** A credit of 2.00 sold at 45 DTE: the Target at half, the Stop at twice. */
function served(costs: number[], stop: number | null = 4): Samples {
  return {
    levels: { dte_at_open: 45, target: 1, stop, target_dte: 11, manage_by_dte: 21 },
    plan: [{ dte: 45, on_pace: 2 }, { dte: 30, on_pace: 1.6 }, { dte: 0, on_pace: 0 }],
    samples: costs.map((c, i) => day({ observed_on: `2026-11-${String(3 + i).padStart(2, "0")}`, dte: 45 - i, cost_to_close: c })),
  } as Samples;
}
const held = { closed_on: null } as const;

describe("which day a pointer means", () => {
  it("is the day whose x is nearest, either side of it", () => {
    const xs = [10, 40, 70];
    expect(nearestDay(xs, 0)).toBe(0);
    expect(nearestDay(xs, 24)).toBe(0);
    expect(nearestDay(xs, 26)).toBe(1);
    expect(nearestDay(xs, 69)).toBe(2);
    expect(nearestDay(xs, 500)).toBe(2);
  });

  it("is no day when there are none", () => {
    expect(nearestDay([], 30)).toBeNull();
  });
});

describe("which day a key moves to", () => {
  it("starts at either end, steps a day at a time, stops at the ends, and Escape lets go", () => {
    expect(stepDay("ArrowRight", null, 5)).toBe(0);
    expect(stepDay("ArrowLeft", null, 5)).toBe(4);
    expect(stepDay("ArrowRight", 1, 5)).toBe(2);
    expect(stepDay("ArrowRight", 4, 5)).toBe(4);
    expect(stepDay("ArrowLeft", 0, 5)).toBe(0);
    expect(stepDay("Home", 3, 5)).toBe(0);
    expect(stepDay("End", 0, 5)).toBe(4);
    expect(stepDay("Escape", 2, 5)).toBe("clear");
  });

  it("leaves every other key alone, and every key with no days", () => {
    expect(stepDay("Tab", 1, 5)).toBeUndefined();
    expect(stepDay("ArrowRight", null, 0)).toBeUndefined();
  });
});

describe("the value axis", () => {
  it("fits the days, the plan and the Target, and leaves a Stop beyond them off the scale, marked", () => {
    const axis = valueAxis(served([2.1, 1.9, 1.7]), held, money);
    // the costs and the plan run 0 to 2.1: the Stop at 4 would have put them in the bottom half
    expect(axis.hi).toBeLessThan(4);
    expect(axis.hi).toBeGreaterThanOrEqual(2.1);
    expect(axis.lo).toBe(0);
    expect(axis.stop).toEqual({ value: 4, off: "above" });
  });

  it("draws a Stop the days reach on the scale", () => {
    const axis = valueAxis(served([2.1, 3.2, 4.4]), held, money);
    expect(axis.hi).toBeGreaterThanOrEqual(4.4);
    expect(axis.stop).toEqual({ value: 4, off: null });
  });

  it("marks a Stop below a debit's scale at the bottom", () => {
    const debit = served([-2.1, -1.9]);
    debit.levels = { ...debit.levels!, target: -3, stop: -0.5 };
    debit.plan = debit.plan.map((p) => ({ ...p, on_pace: -p.on_pace }));
    // a debit's Stop is a smaller value: here it is inside, at -0.5 between -2.1 and 0
    expect(valueAxis(debit, held, money).stop?.off).toBeNull();
    debit.levels.stop = -9;
    expect(valueAxis(debit, held, money).stop).toEqual({ value: -9, off: "below" });
  });

  it("has no Stop to mark when there is none", () => {
    expect(valueAxis(served([2.1], null), held, money).stop).toBeNull();
  });

  it("names every tick once, from the bottom of the scale to its top, and includes today", () => {
    const axis = valueAxis(served([2.1, 1.9]), { closed_on: null, cost_to_close: 2.6, dte: 43 }, money);
    expect(axis.hi).toBeGreaterThanOrEqual(2.6);
    expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
    expect(axis.ticks[0]).toBe(axis.lo);
    expect(axis.ticks.at(-1)).toBe(axis.hi);
    expect(axis.now).toEqual({ dte: 43, cost: 2.6 });
  });

  it("takes a gutter as wide as its widest label, and none worth reading under privacy", () => {
    const shown = valueAxis(served([2.1, 1.9]), held, money);
    expect(shown.labels).toContain("$0");
    expect(shown.L).toBeGreaterThan(Math.max(...shown.labels.map((l) => l.length)) * 6);
    const none = valueAxis(served([2.1, 1.9]), held, hidden);
    expect(none.labels).toEqual([]);
    expect(none.L).toBe(8);
  });

  it("says points without money: a tick is the figure itself", () => {
    expect(valueAxis(served([2.1, 1.9]), held, points).labels).toContain("0.5");
  });
});

describe("where the tooltip goes", () => {
  const box = { W: 272, H: 208, tipW: 192, tipH: 80 };
  it("is at the edge further from the day's point: the top over a low point, the bottom under a high one", () => {
    expect(tipPlace({ ...box, x: 136, y: 150 }).top).toBe(0);
    expect(tipPlace({ ...box, x: 136, y: 40 }).top).toBe(208 - 80);
  });

  it("is centred on the day and never leaves the chart, at either end", () => {
    expect(tipPlace({ ...box, x: 136, y: 150 }).left).toBe(136 - 96);
    expect(tipPlace({ ...box, x: 20, y: 150 }).left).toBe(0);
    expect(tipPlace({ ...box, x: 260, y: 150 }).left).toBe(272 - 192);
  });

  it("goes beside the day where neither edge leaves room above or below its point", () => {
    // a tooltip taller than either side of a point in the middle, on a wide chart
    const tall = { W: 900, H: 208, tipW: 192, tipH: 110 };
    const right = tipPlace({ ...tall, x: 300, y: 104 });
    expect(right.left).toBeGreaterThan(300);
    expect(right.top).toBe(104 - 55);
    const left = tipPlace({ ...tall, x: 800, y: 104 });
    expect(left.left + 192).toBeLessThan(800);
  });

  it("stays at the edge, inside the chart, where there is no room beside either", () => {
    const place = tipPlace({ W: 272, H: 208, tipW: 192, tipH: 110, x: 136, y: 104 });
    expect(place.left).toBe(40);
    expect(place.top + 110).toBeLessThanOrEqual(208);
    expect(place.top).toBeGreaterThanOrEqual(0);
  });
});

describe("what a day says", () => {
  it("in the tooltip: the day, money across the contracts, on pace, the gap and why it is off-close", () => {
    const lines = tipLines(day({ timing: "after-close", observed_at: "2026-11-04 09:30:00+08:00" }), money);
    expect(lines.day).toBe("3 Nov · 45 DTE");
    expect(lines.cost).toBe("to close, 2 contracts: $460");
    expect(lines.pace).toBe("on pace $404");
    // the gap in points, as every Pace gap on the page is said: 2.30 against 2.02
    expect(lines.gap).toEqual({ words: "behind by 0.28", outcome: "loss" });
    expect(lines.why).toBe("not the close: 20:30 New York, after the 16:15 close");
  });

  it("in points per contract without a contract size, and nothing about the close for a close", () => {
    const lines = tipLines(day({ cost_to_close: 1.5, on_pace: 1.8 }), points);
    expect(lines.cost).toBe("to close, per contract: 1.50 pts");
    expect(lines.pace).toBe("on pace 1.80 pts");
    expect(lines.gap).toEqual({ words: "ahead by 0.30", outcome: "gain" });
    expect(lines.why).toBeNull();
  });

  it("no money and no count under privacy, but the gap in points, which is no money", () => {
    const lines = tipLines(day(), hidden);
    expect(lines.cost).toBe("to close: $•••");
    expect(lines.pace).toBe("on pace $•••");
    expect(lines.gap?.words).toBe("behind by 0.28");
  });

  it("no pace and no gap for a day with no plan", () => {
    const lines = tipLines(day({ on_pace: null }), money);
    expect(lines.pace).toBeNull();
    expect(lines.gap).toBeNull();
  });

  it("before the open, and before times were kept", () => {
    expect(tipLines(day({ timing: "before-open", observed_at: "2026-11-04 13:05:00+08:00" }), money).why)
      .toBe("not the close: 00:05 New York, before the 09:30 open");
    expect(tipLines(day({ timing: "unrecorded", observed_at: null }), money).why)
      .toBe("not timed: whether it was the close is not known");
  });

  it("in the status line, everything the tooltip says and the whole reason", () => {
    expect(sampleWords(day(), money))
      .toBe("3 Nov · 45 DTE · to close, 2 contracts: $460 · on pace $404 · behind by 0.28 — in hours (observed 16:00 New York)");
  });
});
