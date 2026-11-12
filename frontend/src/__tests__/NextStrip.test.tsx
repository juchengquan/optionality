/** The strike strip (#297): a spread's short and long strikes on a scale, SPX's derived price as a
 *  dot, the short leg's Δ on its strike and the distance from SPX to the short strike in points and
 *  σ — every figure the service's (`short_strikes`, `spx`, `spx_reason`), drawn in both
 *  arrangements: the desk's rows and inspector, the phone's cards and sheet. Behaviour only; the
 *  layout is measured in the browser suite (`__browser__/StrikeStrip*.test.tsx`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Holding } from "../api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { COLUMNS, type DeskRow } from "../next/desk/columns";
import { PhoneBook } from "../next/phone/PhoneBook";
import { StrikeStrip } from "../next/StrikeStrip";
import { cellWords, distanceWords, joinStrips, nearest, scaleOf, stripOfEntry, stripOfHolding } from "../next/strip";
import { HOLDINGS, MONITORS, QUOTES, served } from "../testing/ownerBook";

afterEach(cleanup);

/** a lone long put held as a hedge: a holding, and no spread — no short strike for SPX to near */
const HEDGE: Holding = {
  ...HOLDINGS[0]!, id: "h-hedge", name: "1218_P6000L", legs: [{ side: "long", option_type: "PUT", strike: 6000 }],
  legs_delta: { "US.SPXW261218P6000000": -0.05 }, short_strikes: [],
};

const holding = (id: string) => HOLDINGS.find((h) => h.id === id)!;
const quote = (id: string) => QUOTES.find((q) => q.id === id)!;

/** a row with SPX's price gone, as with IB Gateway as the Provider (ADR 0024): the service still
 *  serves each short strike and its Δ, and only the distances are null */
const REASON = "the Provider gives no option premium to derive it from";
function bare<T extends Entry | Holding>(row: T): T {
  return {
    ...row, spx: null, spx_reason: REASON,
    short_strikes: row.short_strikes.map((s) => ({ ...s, points: null, sigma: null, one_sigma: null })),
  };
}

describe("what a strip is made of", () => {
  it("takes a holding's short strikes as served and its long strikes from its legs", () => {
    const s = stripOfHolding(holding("h-puts"))!;
    expect(s.shorts.map((k) => [k.strike, k.delta, k.points])).toEqual([[6400, -0.21, 500.5]]);
    expect(s.longs).toEqual([{ option_type: "PUT", strike: 6350 }]);
    expect([s.spx, s.reason]).toEqual([6900.5, null]);
  });

  it("draws none for a holding with no short leg, as for a single contract: there is no short strike to place", () => {
    expect(stripOfHolding(HEDGE)).toBeNull();
  });

  it("takes a watched spread's long strikes from its plus legs, and draws none for a single contract", () => {
    const s = stripOfEntry(quote("w-dec31"))!;
    expect(s.shorts.map((k) => k.strike)).toEqual([7600]);
    expect(s.longs).toEqual([{ option_type: "CALL", strike: 7650 }]);
    expect(stripOfEntry(quote("w-lone"))).toBeNull();
  });

  it("joins a condor held as two spreads into one strip", () => {
    const s = joinStrips(stripOfHolding(holding("h-calls"))!, stripOfHolding(holding("h-puts"))!);
    expect(s.shorts.map((k) => k.strike)).toEqual([7300, 6400]);
    expect(s.longs.map((k) => k.strike)).toEqual([7350, 6350]);
  });

  it("names the short strike SPX is nearest by the served points, a strike already passed first", () => {
    // the 4-leg condor: the call at 7400 is 499.50 away, the put at 6300 600.50
    expect(nearest(stripOfHolding(holding("h-ic"))!)!.strike).toBe(7400);
    const past = { ...stripOfHolding(holding("h-ic"))!,
      shorts: [served("2026-12-31", "CALL", 7400, 0.12, 38), served("2026-12-31", "PUT", 6950, -0.6, 38)] };
    expect(nearest(past)!.strike).toBe(6950);
    expect(nearest(stripOfHolding(bare(holding("h-ic")))!)).toBeNull();
  });

  it("says a distance in points and σ, away or past it, and a dash without one", () => {
    expect(distanceWords(served("2026-12-18", "PUT", 6400, -0.21, 38))).toBe("500.50 pts · 1.25σ away");
    expect(distanceWords(served("2026-12-18", "PUT", 7150, -0.6, 38))).toBe("249.50 pts · 0.62σ past it");
    expect(distanceWords({ ...served("2026-12-18", "PUT", 6400, -0.21, 38), sigma: null })).toBe("500.50 pts away");
    expect(distanceWords({ ...served("2026-12-18", "PUT", 6400, -0.21, 38), points: null, sigma: null })).toBe("—");
    expect(cellWords(stripOfHolding(holding("h-puts"))!)).toBe("500.50 pts · 1.25σ");
    // already past its strike: the row's words carry the minus, as the served points do
    expect(cellWords(stripOfEntry(quote("w-dec18"))!)).toBe("−249.50 pts · −0.62σ");
    expect(cellWords(stripOfHolding(bare(holding("h-puts")))!)).toBe("—");
  });

  it("places every strike and SPX inside the scale, in order", () => {
    const s = stripOfHolding(holding("h-ic"))!;
    const at = scaleOf(s);
    const xs = [6250, 6300, 6900.5, 7400, 7450].map(at);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    for (const x of xs) expect(x > 0 && x < 100).toBe(true);
  });
});

describe("the strip as drawn", () => {
  const text = () => document.querySelector(".nxs")!.textContent;

  it("draws SPX as a dot, each short strike with its Δ, each long strike, and says the distance", () => {
    render(<StrikeStrip strip={stripOfHolding(holding("h-ic"))!} />);
    const fig = screen.getByRole("figure", { name: "strike strip" });
    expect(fig.querySelectorAll(".nxs-spx")).toHaveLength(1);
    expect([...fig.querySelectorAll<HTMLElement>(".nxs-k[data-side=short]")].map((k) => k.textContent))
      .toEqual(["7400Δ 0.120", "6300Δ −0.250"]);
    expect([...fig.querySelectorAll<HTMLElement>(".nxs-k[data-side=long]")].map((k) => k.textContent))
      .toEqual(["7450", "6250"]);
    expect(within(fig).getByText("SPX 6900.50")).toBeTruthy();
    expect(within(fig).getByText("C7400 Δ 0.120 · 499.50 pts · 1.25σ away")).toBeTruthy();
    expect(within(fig).getByText("P6300 Δ −0.250 · 600.50 pts · 1.50σ away")).toBeTruthy();
  });

  it("with no derived price, still draws the strikes and Δ, and shows a dash with its reason", () => {
    render(<StrikeStrip strip={stripOfHolding(bare(holding("h-puts")))!} />);
    expect(document.querySelector(".nxs-spx")).toBeNull();
    expect(document.querySelector(".nxs-k[data-side=short]")!.textContent).toBe("6400Δ −0.210");
    expect(document.querySelector(".nxs-k[data-side=long]")!.textContent).toBe("6350");
    expect(text()).toContain(`SPX — ${REASON}`);
    expect(text()).not.toMatch(/pts/);
  });

  it("never fills a missing price from anywhere else: the References' SPX is not read", () => {
    // the strip takes ONE argument, the row's own strip; there is nothing else for it to read
    render(<StrikeStrip strip={stripOfEntry(bare(quote("w-dec18")))!} />);
    expect(document.querySelector(".nxs-spx")).toBeNull();
  });

  it("is a bare scale in a row, with the distance said beside it", () => {
    render(<StrikeStrip strip={stripOfHolding(holding("h-puts"))!} compact />);
    expect(document.querySelector(".nxs")!.hasAttribute("data-compact")).toBe(true);
    expect(document.querySelector(".nxs-k[data-side=short]")!.textContent).toBe("");
    expect(document.querySelector(".nxs-spx")).toBeTruthy();
  });
});

function deskProps(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    mode: "live", privacy: false, entryStyle: "opportunity", ...over,
  };
}

const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

describe("on the desk (arrangement A)", () => {
  const strip = COLUMNS.live.find((c) => c.key === "strip")!;

  it("gives every held spread and every watched spread a strip in its row, in Live", () => {
    render(<DeskBook {...deskProps()} />);
    for (const id of ["h-puts", "h-calls", "h-ic", "w-dec04", "w-dec18", "w-dec31"]) {
      expect(deskRow(id).querySelector("[data-col=strip] .nxs"), id).toBeTruthy();
    }
    expect(deskRow("h-puts").querySelector("[data-col=strip]")!.textContent).toContain("500.50 pts · 1.25σ");
    // a single contract is no spread; a rule under a holding is drawn on the holding's own row
    for (const id of ["w-lone", "w-dec18-delta", "r-calls", "r-ic"]) {
      expect(deskRow(id).querySelector("[data-col=strip] .nxs"), id).toBeNull();
    }
  });

  it("leaves a holding with no short leg without a strip: no scale, and no dash to explain", () => {
    render(<DeskBook {...deskProps({ holdings: [...HOLDINGS, HEDGE] })} />);
    const cell = deskRow("h-hedge").querySelector<HTMLElement>("[data-col=strip]")!;
    expect(cell.querySelector(".nxs")).toBeNull();
    expect(cell.textContent).toBe("");
    fireEvent.click(within(deskRow("h-hedge")).getByRole("button", { name: "1218_P6000L" }));
    expect(within(screen.getByRole("complementary", { name: /inspector/ })).queryByRole("figure")).toBeNull();
  });

  it("says a dash in the row without a derived price, with the reason to a pointer and a reader", () => {
    const row: DeskRow = { kind: "holding", holding: bare(holding("h-puts")), rules: [] };
    expect(strip.text(row, false)).toBe("—");
    render(<DeskBook {...deskProps({ holdings: HOLDINGS.map(bare) })} />);
    const cell = deskRow("h-puts").querySelector<HTMLElement>("[data-col=strip]")!;
    expect(cell.querySelector(".nxs")).toBeTruthy();
    expect(cell.querySelector("[title]")!.getAttribute("title")).toBe(REASON);
    expect(cell.textContent).toContain(REASON);
  });

  it("leaves REVIEW's columns alone: after the close is for the plan, not the market", () => {
    expect(COLUMNS.review.some((c) => c.key === "strip")).toBe(false);
  });

  it("draws the whole strip in the inspector, a bracketed condor's two spreads on one", () => {
    render(<DeskBook {...deskProps()} />);
    fireEvent.click(within(deskRow("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const inspector = screen.getByRole("complementary", { name: /inspector/ });
    const fig = within(inspector).getByRole("figure", { name: "strike strip" });
    expect([...fig.querySelectorAll(".nxs-k[data-side=short] b")].map((k) => k.textContent)).toEqual(["7300", "6400"]);
    expect(within(fig).getByText("C7300 Δ 0.330 · 399.50 pts · 1.00σ away")).toBeTruthy();
  });

  it("draws a watched spread's strip in the inspector, and none for a single contract", () => {
    render(<DeskBook {...deskProps()} />);
    fireEvent.click(within(deskRow("w-dec18")).getByRole("button", { name: /./ }));
    const fig = within(screen.getByRole("complementary", { name: /inspector/ })).getByRole("figure", { name: "strike strip" });
    expect(within(fig).getByText("P7150 Δ −0.170 · 249.50 pts · 0.62σ past it")).toBeTruthy();
    fireEvent.click(within(deskRow("w-lone")).getByRole("button", { name: /./ }));
    expect(within(screen.getByRole("complementary", { name: /inspector/ })).queryByRole("figure")).toBeNull();
  });
});

describe("on the phone (arrangement B)", () => {
  const card = (ref: string) =>
    [...document.querySelectorAll<HTMLElement>(".nxp-card[data-ref]")].find((c) => c.dataset.ref === ref)!;

  it("gives every held spread's card and every watched spread's card a strip", () => {
    render(<PhoneBook {...deskProps()} />);
    for (const id of ["h-puts", "h-calls", "h-ic", "w-dec04", "w-dec18", "w-dec31"]) {
      expect(within(card(id)).getByRole("figure", { name: "strike strip" }), id).toBeTruthy();
    }
    expect(within(card("w-lone")).queryByRole("figure")).toBeNull();
  });

  it("draws no strip on the card or in the sheet of a holding with no short leg", async () => {
    render(<PhoneBook {...deskProps({ holdings: [...HOLDINGS, HEDGE] })} />);
    expect(within(card("h-hedge")).queryByRole("figure")).toBeNull();
    fireEvent.click(within(card("h-hedge")).getByRole("button", { name: "details of 1218_P6000L" }));
    expect(within(await screen.findByRole("dialog")).queryByRole("figure")).toBeNull();
  });

  it("draws the strip in the detail sheet", async () => {
    render(<PhoneBook {...deskProps()} />);
    fireEvent.click(within(card("h-puts")).getByRole("button", { name: "details of 1218_P6400" }));
    const sheet = await screen.findByRole("dialog");
    const fig = within(sheet).getByRole("figure", { name: "strike strip" });
    expect(within(fig).getByText("P6400 Δ −0.210 · 500.50 pts · 1.25σ away")).toBeTruthy();
  });

  it("with no derived price, a card's strip keeps its strikes and Δ, and gives a dash and the reason", () => {
    render(<PhoneBook {...deskProps({ holdings: HOLDINGS.map(bare) })} />);
    const fig = within(card("h-puts")).getByRole("figure", { name: "strike strip" });
    expect(fig.querySelector(".nxs-k[data-side=short]")!.textContent).toBe("6400Δ −0.210");
    expect(fig.textContent).toContain(`SPX — ${REASON}`);
  });
});
