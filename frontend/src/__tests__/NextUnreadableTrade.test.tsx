/** A closed trade the service cannot read (#422's review): served with no legs, so the journal says
 *  so where the legs are drawn, rather than leaving the cell blank. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TradeLegs } from "../ClosedTrade";
import type { ClosedTrade } from "../journal";

afterEach(cleanup);

const trade = (over: Partial<ClosedTrade>): ClosedTrade => ({
  id: "t1", name: "1218_broken", strategy: null, strike_date: "2026-12-18", contracts: 1, entry: 2,
  legs: [], created_at: null, opened_at: "2026-11-03", closed_on: "2026-11-09", exit: 1,
  realized_points: 1, unreadable: null, ...over,
} as ClosedTrade);

describe("a closed trade's legs", () => {
  it("say the trade cannot be read where the service could not read it", () => {
    render(<TradeLegs trade={trade({ unreadable: "position 1218_broken cannot be read: legs must be JSON" })} />);
    expect(screen.getByText("cannot be read")).toBeTruthy();
  });

  it("are drawn as legs otherwise", () => {
    const { container } = render(<TradeLegs trade={trade({
      legs: [{ side: "short", option_type: "PUT", strike: 6400 }],
    })} />);
    expect(container.textContent).not.toContain("cannot be read");
  });
});
