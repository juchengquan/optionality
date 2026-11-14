/** The Reference strip: what it says, and what it refuses to say (ADR 0018). */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { servedWhen } from "../next/session";
import { Still } from "../next/snapshot/Still";
import type { Reference } from "../shared/api";
import { ReferenceStrip, referenceTitle } from "../shared/ReferenceStrip";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const spx = (over: Partial<Reference> = {}): Reference => ({
  id: "r1", code: "US.SPY", label: "SPX", source: "moomoo",
  name: "SPDR S&P 500 ETF Trust", figure: 7587.3, field: "mid_price",
  change: 0.003982956650611325, error: null,
  // moomoo reports no grade at all, which is the default a fixture should carry: null, not false
  delayed: null, last_known: null, delayed_by_minutes: null,
  // the service's stamp on the read, in DISPLAY_TZ (#371)
  fetched_at: "2026-11-13 21:04:11+08:00",
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

/** Outside New York's session the strip is read once, not polled, so every reading says when it was
 *  read, from the service's stamp — and a reading that cannot say when is not drawn at all (#371,
 *  ADR 0023 amended 2026-11-13; ADR 0018's frozen figure that looks live). */
describe("outside the session, every reading says when it was read", () => {
  const vix = spx({ id: "r2", code: "^VIX", label: "VIX", source: "yahoo", figure: 16.82, change: null,
    fetched_at: "2026-11-13 21:04:40+08:00" });
  const readings = () => [...document.querySelectorAll(".references .reference")].map((r) => r.textContent ?? "");
  // Friday 13 November, 21:30 in the service's +08:00: the stamps are today's, after the last edge
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-13T13:30:00Z") }); });
  const timeOf = (served: string | null | undefined) => servedWhen(served);

  it("puts the service's time on each reading, to the minute", () => {
    render(<ReferenceStrip references={[spx(), vix]} timeOf={timeOf} />);
    expect(readings()).toEqual([
      "SPX (moomoo) 7,587.30+0.40%read at 21:04",
      "VIX (yahoo) 16.82read at 21:04",
    ]);
  });

  it("says a dash was TRIED at that time: its source was asked and gave nothing (#371's review)", () => {
    render(<ReferenceStrip references={[spx({ figure: null, change: null, error: "no quote" })]} timeOf={timeOf} />);
    expect(readings()).toEqual(["SPX (moomoo) —tried at 21:04"]);
  });

  it("dates a reading from another day", () => {
    render(<ReferenceStrip references={[spx({ fetched_at: "2026-11-12 21:04:11+08:00" })]} timeOf={timeOf} />);
    expect(readings()).toEqual(["SPX (moomoo) 7,587.30+0.40%read at Thu 21:04"]);
  });

  it("never draws a reading without its time", () => {
    for (const stamp of [undefined, null, "", "x"]) {
      render(<ReferenceStrip references={[spx(), vix, spx({ id: "r3", label: "NDX", fetched_at: stamp as never })]}
                             timeOf={timeOf} />);
      for (const r of readings()) expect(r, "a reading drawn without its time").toMatch(/(read|tried) at \d\d:\d\d$/);
      expect(readings().some((r) => r.startsWith("NDX"))).toBe(false);
      cleanup();
    }
  });

  it("draws nothing when no reading can say when", () => {
    render(<ReferenceStrip references={[spx({ fetched_at: undefined as never })]} timeOf={timeOf} />);
    expect(document.querySelector(".references")).toBeNull();
  });

  it("says no time in session, where it is polled", () => {
    render(<ReferenceStrip references={[spx(), vix]} />);
    expect(readings().every((r) => !r.includes("read at"))).toBe(true);
    expect(readings()).toHaveLength(2);
  });

  for (const arrangement of ["desk", "phone"] as const) {
    it(`goes into the saved picture from the ${arrangement} with its time outside the session, and without it in`,
      () => {
        const still = (session: boolean) => render(
          <Still arrangement={arrangement} quotes={[]} monitors={[]} holdings={[]} holdingsError={null}
                 holdingsAt={null} session={session} privacy={false} entryStyle="opportunity"
                 needs={[]} health={null} polledAt={null} error={null}
                 references={[spx(), vix, spx({ id: "r3", label: "NDX", fetched_at: undefined as never })]} />);
        still(false);
        expect(readings()).toHaveLength(2);
        for (const r of readings()) expect(r, "a reading drawn without its time").toMatch(/read at 21:04$/);
        cleanup();
        still(true);
        expect(readings()).toHaveLength(3);
        expect(readings().every((r) => !r.includes("read at"))).toBe(true);
      });
  }
});
