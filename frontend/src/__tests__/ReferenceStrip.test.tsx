/** The Reference strip: what it says, and what it refuses to say (ADR 0018). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Reference } from "../api";
import { ReferenceStrip, referenceTitle } from "../ReferenceStrip";

const spx = (over: Partial<Reference> = {}): Reference => ({
  id: "r1", code: "US.SPY", label: "SPX", scale: 10,
  name: "SPDR S&P 500 ETF Trust", figure: 7587.3, field: "mid_price",
  change: 0.003982956650611325, error: null, ...over,
} as Reference);

describe("what it is called", () => {
  it("shows the arithmetic, and never claims to be the index", () => {
    // SPY×10 is not SPX: tracking error, dividends, and two different sessions. The label is the
    // only place SPX is said at all, so the `via` is what keeps it honest.
    expect(referenceTitle(spx())).toBe("SPX (via SPY ×10)");
  });

  it("names the proxy even where there is no scale to show", () => {
    expect(referenceTitle(spx({ label: "Nasdaq", code: "US.QQQ", scale: null })))
      .toBe("Nasdaq (via QQQ)");
  });

  it("is just the code where the code is already the truth about itself", () => {
    expect(referenceTitle(spx({ label: null, scale: null, code: "US.QQQ" }))).toBe("QQQ");
  });
});

describe("the figure", () => {
  it("is separated and two-placed, because it is read by its digits", () => {
    render(<ReferenceStrip references={[spx()]} />);
    expect(screen.getByText("7,587.30")).toBeTruthy();
  });

  it("carries the day's move, signed", () => {
    render(<ReferenceStrip references={[spx()]} />);
    expect(screen.getByText("+0.40%")).toBeTruthy();
  });

  it("signs a day down the other way", () => {
    render(<ReferenceStrip references={[spx({ change: -0.0123 })]} />);
    expect(screen.getByText("-1.23%")).toBeTruthy();
  });

  it("says nothing about the move where no close arrived", () => {
    render(<ReferenceStrip references={[spx({ change: null })]} />);
    expect(screen.queryByText(/%/)).toBeNull();
  });
});

describe("where the figure came from", () => {
  it("stays quiet about a mid, which is what every other figure on the page is", () => {
    render(<ReferenceStrip references={[spx()]} />);
    expect(screen.queryByText("last")).toBeNull();
  });

  it("says so when it is the last trade, because that can be a session old", () => {
    // measured: SPY's last read 755.72 while its own book gave 758.73
    render(<ReferenceStrip references={[spx({ field: "last_price", figure: 7557.2 })]} />);
    expect(screen.getByText("last")).toBeTruthy();
  });
});

describe("a Reference with no figure", () => {
  it("is a dash, and still a Reference", () => {
    render(<ReferenceStrip references={[spx({
      figure: null, field: null, change: null, name: null,
      error: "snapshot API failed: US stock indices are not supported",
    })]} />);
    // the row stays: removing it is the owner's decision, and its absence is not an event
    expect(screen.getByText("SPX (via SPY ×10)")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("is never painted as urgent", () => {
    const { container } = render(<ReferenceStrip references={[spx({
      figure: null, field: null, change: null, error: "Client connection failed!",
    })]} />);
    // `bad` is the class the top line uses for a fault, and a backdrop must never claim to be one
    expect(container.querySelectorAll(".bad")).toHaveLength(0);
  });

  it("carries the reason where a pointer can reach it", () => {
    const { container } = render(<ReferenceStrip references={[spx({
      figure: null, error: "snapshot API failed: US stock indices are not supported",
    })]} />);
    expect(container.querySelector(".reference")!.getAttribute("title"))
      .toContain("US stock indices are not supported");
  });
});

describe("nothing kept", () => {
  it("draws nothing at all", () => {
    const { container } = render(<ReferenceStrip references={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
