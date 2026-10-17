import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Entry, Health } from "../api";
import { TopLine, needs } from "../TopLine";

const health = (over: Record<string, unknown> = {}): Health => ({
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, display_tz: "Asia/Singapore" },
  ...over,
} as Health);

const schedule = (over: Record<string, unknown> = {}) => ({
  dte_at_open: 45, position_id: "p1", on_pace: 1, pace_gap: 0,
  target: 0.5, stop: 2, target_dte: 11, manage_by_dte: 21,
  reached: null, manage_by_due: false, ...over,
});

const row = (over: Record<string, unknown> = {}): Entry => ({
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 45, fill: 10, scope: "all", positions: [{ id: "p1", name: "spread" }],
  cost_to_close: 1, entry: 1, pnl: 0, schedule: null,
  quote: { name: "SPXW 261120 8100.00C" }, ...over,
} as unknown as Entry);

describe("what needs you", () => {
  it("is nothing at all when nothing does", () => {
    // the silence is the point: a line that is almost always the same stops being read
    expect(needs([row()], health())).toEqual([]);
  });

  it("puts a fault first, because it means the rest is drawn from stale figures", () => {
    const items = needs(
      [row({ triggered: true, schedule: schedule({ reached: "target" }) })],
      health({ opend: false }),
    );
    expect(items.map((n) => n.kind)).toEqual(["fault", "alarm", "target"]);
    expect(items[0]!.text).toContain("stale");
  });

  it("ranks a stop above a ringing alarm, and both above a target", () => {
    const items = needs([
      row({ id: "a", schedule: schedule({ reached: "target" }) }),
      row({ id: "b", triggered: true }),
      row({ id: "c", schedule: schedule({ reached: "stop" }) }),
    ], health());
    expect(items.map((n) => n.kind)).toEqual(["stop", "alarm", "target"]);
  });

  it("reads the Level from the service and never compares anything itself", () => {
    // a row whose cost is miles past its target but whose schedule says otherwise contributes
    // NOTHING: #129 was the screen deciding for itself what the service had already decided
    const items = needs(
      [row({ cost_to_close: 0.01, schedule: schedule({ reached: null }) })],
      health(),
    );
    expect(items).toEqual([]);
  });

  it("says nothing for a row with no schedule, which is the documented blind spot", () => {
    // a schedule needs one rule covering one whole holding (ADR 0011), so a leg rule has none —
    // deliberate, and survivable only because this line never claims nothing needs you
    const items = needs([row({ scope: "leg", schedule: null, cost_to_close: 0.01 })], health());
    expect(items).toEqual([]);
  });

  it("counts a manage-by date that has arrived", () => {
    const items = needs([row({ schedule: schedule({ manage_by_due: true }) })], health());
    expect(items.map((n) => n.kind)).toEqual(["manage"]);
    expect(items[0]!.text).toContain("manage-by");
  });

  it("treats an unknown contract as a fault about that row", () => {
    const items = needs([row({ error: "unknown contract" })], health());
    expect(items.map((n) => n.kind)).toEqual(["fault"]);
  });
});

describe("how the line reads", () => {
  it("does not paint good news as bad", () => {
    // one line carries a reached Target (good) and a hit Stop (bad), so the colour follows the
    // contents. A green "at target" in the destructive red would say the opposite of the truth.
    render(<TopLine quotes={[row({ schedule: schedule({ reached: "target" }) })]} health={health()} />);
    expect(screen.getByRole("status").className, "target only").toBe("topline");
  });

  it("paints a fault and a stop as bad", () => {
    render(<TopLine quotes={[row({ schedule: schedule({ reached: "stop" }) })]} health={health()} />);
    expect(screen.getByRole("status").className).toContain("bad");
  });

  it("names three and counts the rest, rather than listing a paragraph", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `m${n}`, code: `c${n}`, triggered: true, legs: [] }));
    render(<TopLine quotes={rows} health={health()} />);
    const text = screen.getByRole("status").textContent!;
    expect(text).toContain("5 need you");
    expect(text).toContain("+2 more");
  });

  it("says it in the singular when there is one", () => {
    render(<TopLine quotes={[row({ triggered: true })]} health={health()} />);
    expect(screen.getByRole("status").textContent).toContain("1 needs you");
  });
});

describe("what only the Service panel can see", () => {
  const holding = (over: Record<string, unknown> = {}) => ({
    id: "p9", name: "1130_BS_6950", schedule: {
      dte_at_open: 45, on_pace: 1, pace_gap: 0, target: 0.5, stop: 2,
      target_dte: 11, manage_by_dte: 21, reached: "target", manage_by_due: false,
    }, ...over,
  } as never);

  it("counts a holding no rule covers, which has no row to speak for it", () => {
    // the glossary's whole reason for a holdings list: "a Position nothing watches used to appear
    // nowhere at all". Its Levels are reached whether or not a rule is pointed at it.
    expect(needs([], health(), [holding()]).map((n) => n.text)).toEqual(["1130_BS_6950 at target"]);
  });

  it("does not say the same holding twice when a row already spoke for it", () => {
    // a rule covering one whole holding carries that holding's schedule, so the row and the
    // holding are the same fact arriving by two routes
    const covered = row({
      schedule: schedule({ reached: "target", position_id: "p9" }),
    });
    expect(needs([covered], health(), [holding()])).toHaveLength(1);
  });

  it("passes none by default, which is what the page does", () => {
    expect(needs([row()], health())).toEqual([]);
  });
});
