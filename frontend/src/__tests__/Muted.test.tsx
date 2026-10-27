import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DISABLED_REASONS } from "backend/schemas";

import { GROUPS, MutedTables } from "../MutedTables";
import type { Monitor } from "../api";

/** The muted tables group BY `disabled_reason`, and a reason with no group renders in NO group:
 *  the row vanishes from the page while sitting disabled in the database — a rule that cannot
 *  fire and is nowhere to be seen. That is what #167's new reason would have done, so the list
 *  the service writes from is published as `DISABLED_REASONS` and this holds the page to it.
 *
 *  Imported into the TEST and not into the page: the list is a runtime value, and importing it
 *  from the bundle would pull zod and the domain into the dashboard for four strings. */
const muted = (over: Partial<Monitor> = {}): Monitor => ({
  id: "m1", code: "US.SPXW261120C8100000", strike_date: "2026-11-20", option_type: "CALL",
  strike: 8100, field: "option_delta", threshold: 0.2, direction: "above", compare: "abs",
  enabled: false, disabled_reason: "no-figure", triggered: false, last_value: null,
  last_checked_at: null, last_alarm_at: null, legs: null, scope: null, dte: 29,
  created_at: "2026-10-01 00:00:00.000000", ...over,
} as Monitor);

describe("the muted tables", () => {
  it("has a group for every reason the service disables a rule for", () => {
    const grouped = new Set(GROUPS.map(([reason]) => reason));
    for (const reason of DISABLED_REASONS) {
      expect(grouped.has(reason), `no group for '${reason}'`).toBe(true);
    }
  });

  it("shows a quarantined rule whose figure never arrived", () => {
    render(<MutedTables monitors={[muted()]} retentionDays={7} onUnmute={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/US\.SPXW261120C8100000/)).toBeTruthy();
    // and it is offered back: a Quarantine is never deleted, and unmuting is the owner's call
    expect(screen.getByRole("button", { name: "unmute" })).toBeTruthy();
  });

  it("keeps the two Quarantines above the rule you muted yourself", () => {
    const order = GROUPS.map(([reason]) => reason);
    expect(order.indexOf("unknown-contract")).toBeLessThan(order.indexOf("manual"));
    expect(order.indexOf("no-figure")).toBeLessThan(order.indexOf("manual"));
  });
});
