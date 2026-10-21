import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Freshness } from "../Freshness";
import { marketClock } from "../format";

/** The freshness line, in both zones.
 *
 *  The owner reads this in Singapore and trades a US session, so "fetched at 21:47" says nothing
 *  about where in the trading day the figures are — and the PNG now carries this line to people
 *  who do not know the dashboard's zone at all. A bare second clock would be worse than none, so
 *  the zone is NAMED, and named by the tz database rather than assumed: EDT in October, EST in
 *  January, which no fixed offset of ours would get right twice a year.
 */
describe("the market clock", () => {
  it("names the session time for a summer evening in Singapore", () => {
    // 21:47 on 21 Oct in Singapore is 09:47 in New York — a quarter hour before the open
    expect(marketClock("2026-10-21 21:47:23+08:00")).toBe("09:47:23 EDT");
  });

  it("follows the tz database across the DST change, rather than a fixed offset", () => {
    // the same local evening in January is an hour further back, and the abbreviation changes
    expect(marketClock("2026-01-21 21:47:23+08:00")).toBe("08:47:23 EST");
  });

  it("says nothing at all when the service's string is not a time", () => {
    // every test fixture in this repo passes "x" here, and so does a service that has never
    // swept — "Invalid Date NaN" beside a real figure reads as a fault in the figure
    expect(marketClock("x")).toBeNull();
    expect(marketClock(null)).toBeNull();
  });
});

describe("the freshness line", () => {
  it("gives the service's time, the session's, and the screen's", () => {
    render(<Freshness fetchedAt="2026-10-21 21:47:23+08:00" polledAt="21:48:14" sweepSeconds={15} />);

    const line = screen.getByText(/fetched at/);
    expect(line.textContent).toContain("2026-10-21 21:47:23+08:00");
    expect(line.textContent, "the session time is missing").toContain("09:47:23 EDT");
    expect(line.textContent).toContain("screen updated 21:48:14");
    expect(line.textContent).toContain("sweeps every 15s");
  });

  it("says it is waiting before the first sweep, and claims no session time", () => {
    render(<Freshness fetchedAt={null} polledAt={null} sweepSeconds={null} />);

    expect(screen.getByText(/waiting for first sweep/)).toBeTruthy();
    expect(screen.queryByText(/EDT|EST/)).toBeNull();
  });
})
