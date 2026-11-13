import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MutedTables } from "../MutedTables";
import type { Monitor } from "../shared/api";

/** The list itself, and its hold on `DISABLED_REASONS`, are `Groups.test.ts`'s (#337). */
const muted = (over: Partial<Monitor> = {}): Monitor => ({
  id: "m1", code: "US.SPXW261120C8100000", strike_date: "2026-11-20", option_type: "CALL",
  strike: 8100, field: "option_delta", threshold: 0.2, direction: "above", compare: "abs",
  enabled: false, disabled_reason: "no-figure", triggered: false, last_value: null,
  last_checked_at: null, last_alarm_at: null, legs: null, scope: null, dte: 29,
  created_at: "2026-10-01 00:00:00.000000", ...over,
} as Monitor);

describe("the muted tables", () => {
  it("shows a quarantined rule whose figure never arrived", () => {
    render(<MutedTables monitors={[muted()]} retentionDays={7} onUnmute={() => {}} onDelete={() => {}} />);
    expect(screen.getByText(/US\.SPXW261120C8100000/)).toBeTruthy();
    // and it is offered back: a Quarantine is never deleted, and unmuting is the owner's call
    expect(screen.getByRole("button", { name: "unmute" })).toBeTruthy();
  });
});
