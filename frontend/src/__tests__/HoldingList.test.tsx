/** One ladder for what is HELD, used by the panel and by the picture.
 *
 *  Four states and the order between them: it could not be read, it has not arrived, nothing is
 *  held, here it is. The order is the load-bearing part, and it is why this is one function and
 *  not two. `App.loadHoldings` deliberately does NOT clear the rows on a failure, and the reason
 *  it can afford not to is that the error comes FIRST here — a cost to close nobody can vouch
 *  for is unreachable because of this precedence and nothing else. There were two copies of it,
 *  in `Holdings.tsx` and `SnapshotView.tsx`, which is two places for it to be got right and the
 *  picture is the one where getting it wrong is already in someone's chat.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HoldingList } from "../Holdings";
import { SnapshotView } from "../SnapshotView";
import type { Health, Holding } from "../api";

const holding = {
  id: "p1", name: "1204_BS_6950", entry: 2.72, cost_to_close: 1.02, pnl: 1.7, dte: 37,
  opened_at: "2026-10-15", schedule: null,
  legs: [{ side: "short", option_type: "PUT", strike: 6950 }],
} as unknown as Holding;

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
} as unknown as Health;

const row = (h: Holding) => <p key={h.id}>{h.name}</p>;

describe("the order the four states are read in", () => {
  it("prints the reason instead of figures nobody can vouch for", () => {
    // rows AND an error: the rows are last sweep's, the error is now, and a cost to close is
    // not a figure to show under a stamp that says it is current
    render(<HoldingList rows={[holding]} error="502 from /positions/values" row={row} />);
    expect(screen.getByText(/502/)).toBeTruthy();
    expect(screen.queryByText("1204_BS_6950")).toBeNull();
  });

  it("prints the reason instead of 'loading…', which would describe a fetch that is not coming", () => {
    render(
      <HoldingList rows={null} error="502" pending={<p>loading…</p>} row={row} />,
    );
    expect(screen.getByText("502")).toBeTruthy();
    expect(screen.queryByText(/loading/)).toBeNull();
  });

  it("says nothing is held, which is a claim about the account and not a failure", () => {
    render(<HoldingList rows={[]} error={null} row={row} />);
    expect(screen.getByText(/nothing held/i)).toBeTruthy();
  });

  it("waits with whatever the caller waits with, before anything has arrived", () => {
    render(<HoldingList rows={null} error={null} pending={<p>loading…</p>} row={row} />);
    expect(screen.getByText("loading…")).toBeTruthy();
    expect(screen.queryByText(/nothing held/i), "an empty account is not an unfinished fetch")
      .toBeNull();
  });

  it("shows nothing at all where the caller has nothing to wait with", () => {
    // the picture's case: an omitted section and an empty one look identical in a still image,
    // so it photographs neither rather than photographing a fetch mid-flight
    const { container } = render(<HoldingList rows={null} error={null} row={row} />);
    expect(container.textContent).toBe("");
  });

  it("draws each row through the caller's own renderer", () => {
    // the panel's row carries an edit form and a delete button; the picture's carries neither,
    // because nothing in a picture can be pressed
    render(<HoldingList rows={[holding]} error={null} row={row} />);
    expect(screen.getByText("1204_BS_6950")).toBeTruthy();
  });
});

describe("the picture reads the same ladder", () => {
  const view = (holdings: Holding[] | null, holdingsError: string | null) => render(
    <SnapshotView
      singles={[]} combos={[]} health={health} fetchedAt="x" polledAt="x" grouping="none"
      reading="distance" band={90} hiddenSingle={new Set()} hiddenCombo={new Set()}
      holdings={holdings} holdingsError={holdingsError}
    />,
  );

  it("photographs the reason, not the figures, when both are to hand", () => {
    view([holding], "502 from /positions/values");
    expect(screen.getByText(/502/)).toBeTruthy();
    expect(screen.queryByText("1204_BS_6950"), "a figure in an image outlives the error")
      .toBeNull();
  });

  it("leaves the section out entirely while the figures have not arrived", () => {
    view(null, null);
    expect(screen.queryByText("holdings")).toBeNull();
  });
});
