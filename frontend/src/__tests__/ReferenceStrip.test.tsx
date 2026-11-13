/** The Reference strip: what it says, and what it refuses to say (ADR 0018). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Reference } from "../shared/api";
import { ReferenceStrip, referenceTitle } from "../shared/ReferenceStrip";

const spx = (over: Partial<Reference> = {}): Reference => ({
  id: "r1", code: "US.SPY", label: "SPX", source: "moomoo",
  name: "SPDR S&P 500 ETF Trust", figure: 7587.3, field: "mid_price",
  change: 0.003982956650611325, error: null,
  // moomoo reports no grade at all, which is the default a fixture should carry: null, not false
  delayed: null, last_known: null, delayed_by_minutes: null,
  ...over,
} as Reference);

describe("what it is called", () => {
  it("names the vendor that answered, which is why an outside source is allowed at all", () => {
    // a figure on this strip is acted on by a person whether or not any code depends on it, so
    // the one thing it must never hide is where it came from (ADR 0019)
    expect(referenceTitle(spx())).toBe("SPX (moomoo)");
  });

  it("names a vendor that is not the Provider, which is the whole point", () => {
    expect(referenceTitle(spx({ label: "SPX", code: "SPX", source: "ibkr" })))
      .toBe("SPX (ibkr)");
  });

  it("falls back to the code where there is no label, still naming the vendor", () => {
    // the code is already the truth about itself; the vendor is the part no code can tell you
    expect(referenceTitle(spx({ label: null, source: "moomoo", code: "US.QQQ" })))
      .toBe("QQQ (moomoo)");
  });

  it("shows no arithmetic, because there is none left", () => {
    // `SPX (via SPY ×10)` until ADR 0019 dropped the scale: a scaled stand-in is a simulation
    // rather than a reading
    expect(referenceTitle(spx())).not.toMatch(/via|×/);
  });
});

describe("how fresh the vendor says it is", () => {
  it("says nothing where the vendor said nothing", () => {
    // moomoo reports no grade. A bare `(moomoo)` therefore means "it never said" — which is why
    // the Service panel records which vendors report freshness (ADR 0019)
    expect(referenceTitle(spx())).toBe("SPX (moomoo)");
  });

  it("says nothing where the vendor said it is live and updating", () => {
    // false is a CLAIM, and the claim is reassuring, so it earns no words on the strip
    expect(referenceTitle(spx({ source: "ibkr", delayed: false, last_known: false })))
      .toBe("SPX (ibkr)");
  });

  it("names the tier where the vendor reports one and no duration", () => {
    // IBKR reports a tier and no minutes, so "delayed" is what it actually said
    expect(referenceTitle(spx({ source: "ibkr", delayed: true, last_known: false })))
      .toBe("SPX (ibkr, delayed)");
  });

  it("states the minutes where the vendor states them", () => {
    // Yahoo reports exchangeDataDelayedBy: 15
    expect(referenceTitle(spx({
      source: "yahoo", code: "^VIX", label: "VIX", delayed: true, delayed_by_minutes: 15,
      last_known: false,
    }))).toBe("VIX (yahoo, 15m late)");
  });

  it("says both where both are true, because grade 4 is both", () => {
    // the combination IBKR draws per contract, and the one that has nowhere to go if the four
    // grades are collapsed into three states
    expect(referenceTitle(spx({ source: "ibkr", delayed: true, last_known: true })))
      .toBe("SPX (ibkr, delayed, last known)");
  });

  it("says last known on its own, for a live-entitled figure out of session", () => {
    expect(referenceTitle(spx({ source: "ibkr", delayed: false, last_known: true })))
      .toBe("SPX (ibkr, last known)");
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
    expect(screen.getByText("SPX (moomoo)")).toBeTruthy();
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
