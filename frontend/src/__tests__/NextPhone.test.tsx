/** The phone's book, arrangement B (ADR 0023, #290): cards drawn from `placeBook`, a detail sheet
 *  that Back closes (ADR 0005: a history entry, not a route), and REVIEW one holding per screen.
 *
 *  Behaviour only. What a phone must MEASURE — nothing pushed sideways, 44pt targets, Back under
 *  the iPhone profile — is `__browser__/NextPhone.iphone.test.tsx`. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { BookProps } from "../next/Book";
import { placeBook } from "../next/placement";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

afterEach(cleanup);

function draw(over: Partial<BookProps> = {}) {
  const props: BookProps = {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null,
    holdingsAt: "23:14:05", mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", ...over,
  };
  return render(<div className="nx"><PhoneBook {...props} /></div>);
}

/** The refs drawn inside a region, in document order: what the page says sits where. */
function refs(region: HTMLElement): string[] {
  return [...region.querySelectorAll<HTMLElement>("[data-ref]")].map((el) => el.dataset.ref!);
}

const region = (name: string) => screen.getByRole("region", { name });
const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((el) => el.dataset.ref === ref)!;

describe("the Live cards, on the owner's book", () => {
  const book = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("draw the holdings placeBook places, in its order, each with the rules about it", () => {
    draw();
    const expected = book.holdings.flatMap((g) =>
      g.rows.flat().flatMap(({ holding, rules }) => [holding.id, ...rules.map((r) => r.id)]));
    expect(refs(region("Holdings"))).toEqual(expected);
  });

  it("draw the watchlist placeBook places, each leg rule inside its spread's card", () => {
    draw();
    const expected = book.watchlist.flatMap((g) =>
      g.items.flatMap(({ entry, under }) => [entry.id, ...under.map((u) => u.id)]));
    expect(refs(region("Watchlist"))).toEqual(expected);
    const spread = card("w-dec18");
    expect(within(spread).getByText(/\|delta\| ≥ 0\.2/)).toBeTruthy();
  });

  it("group both by expiry, under a heading per expiry", () => {
    draw();
    const headings = (name: string) => [...region(name).querySelectorAll<HTMLElement>("[data-expiry]")]
      .map((g) => g.dataset.expiry);
    expect(headings("Holdings")).toEqual(book.holdings.map((g) => g.expiry));
    expect(headings("Watchlist")).toEqual(book.watchlist.map((g) => g.expiry));
    expect(within(region("Holdings")).getByRole("heading", { name: /18 Dec 2026/ })).toBeTruthy();
  });

  it("sit a condor's two cards together, the calls first", () => {
    draw();
    const condor = within(region("Holdings")).getByRole("group", { name: /iron condor/ });
    expect([...condor.querySelectorAll<HTMLElement>("article[data-ref]")].map((a) => a.dataset.ref))
      .toEqual(["h-calls", "h-puts"]);
  });

  it("give a held spread a large P&L, its Cost to close, short-leg Δ, DTE and the Level reached", () => {
    // the deltas withheld, so the short call's is its rule's (the fallback, #318)
    const stopped: Holding[] = HOLDINGS.map((h) => ({ ...h, legs_delta: null })).map((h) => h.id === "h-calls"
      ? { ...h, schedule: { ...SCHEDULE, reached: "stop" } } as Holding : h);
    draw({ holdings: stopped, quotes: [...QUOTES, SHORT_LEG], monitors: [...MONITORS, SHORT_LEG_RULE] });
    const c = card("h-calls");
    expect(c.querySelector(".nxp-hero [data-money]")!.textContent).toBe("-$240");
    expect(within(c).getByText("4.40")).toBeTruthy();         // cost to close
    expect(within(c).getByText("0.231")).toBeTruthy();        // the short call's Δ, from its rule
    expect(within(c).getByText("38 DTE")).toBeTruthy();
    expect(within(c).getByText("at stop")).toBeTruthy();
    // no served delta and no rule on its short leg: no figure to show, and it says so with a dash
    expect(within(card("h-puts")).getByText("short Δ").nextSibling!.textContent).toBe("—");
  });

  it("prefer the served delta to a rule's on the same leg", () => {
    // both come from the Provider; the order #318 asks for is served first
    draw({ quotes: [...QUOTES, SHORT_LEG], monitors: [...MONITORS, SHORT_LEG_RULE] });
    expect(within(card("h-calls")).getByText("short Δ").nextSibling!.textContent).toBe("0.330");
  });

  it("give each held spread its short leg's delta as the service serves it, with no rule on the leg", () => {
    // #318: each leg's own delta comes with the holding; the fixture has no rule on any held leg
    draw();
    const short = (id: string) => within(card(id)).getByText("short Δ").nextSibling!.textContent;
    expect(short("h-calls")).toBe("0.330");
    expect(short("h-puts")).toBe("-0.210");
    // a 4-leg holding lists each short leg
    expect(short("h-ic")).toBe("C7400 0.120 · P6300 -0.250");
  });

  it("show a candidate's progress toward its threshold and each Monitor's sentence", () => {
    draw();
    const c = card("w-dec18");
    expect(within(c).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(within(c).getByText(/\|spread value\| ≥ 6 — now 2\.40, 3\.60 away/)).toBeTruthy();
  });

  it("style a fired entry as an entry signal, and a fired rule on a holding as ringing", () => {
    draw();
    expect(card("w-dec04").dataset.state).toBe("entry");
    expect(within(card("w-dec04")).getByText("entry signal")).toBeTruthy();
    expect(card("r-calls").dataset.state).toBe("alarm");
    expect(within(card("r-calls")).getByText("ringing")).toBeTruthy();
  });

  it("list the quarantined Monitors as faults and the muted ones as muted", () => {
    draw();
    const off = region("Switched off");
    const row = (id: string) => off.querySelector<HTMLElement>(`[data-monitor="${id}"]`)!;
    expect(row("q-unknown").dataset.state).toBe("quarantined");
    expect(within(row("q-unknown")).getByText("quarantined")).toBeTruthy();
    expect(within(row("q-unknown")).getByText(/the provider does not know its contract/)).toBeTruthy();
    expect(row("m-muted").dataset.state).toBe("muted");
    expect(within(row("m-muted")).getByText(/muted by hand/)).toBeTruthy();
    expect(within(row("m-expired")).getByText(/expired/)).toBeTruthy();
  });

  it("say the rules on held contracts apart while the holdings are not valued", () => {
    draw({ holdings: null, holdingsError: "OpenD timed out" });
    expect(within(region("Holdings")).getByText(/could not be valued — OpenD timed out/)).toBeTruthy();
    expect(refs(region("Holdings"))).toEqual(["r-calls", "r-ic"]);
  });

  it("hide $ amounts under privacy and keep the rest", () => {
    draw({ privacy: true });
    expect(card("h-calls").querySelector(".nxp-hero [data-money]")!.textContent).toBe("$•••");
    expect(within(card("h-calls")).getByText("38 DTE")).toBeTruthy();
  });

  it("hide a condor's summed P&L under privacy, and show it otherwise", () => {
    const condor = () => within(region("Holdings")).getByRole("group", { name: /iron condor/ })
      .querySelector(".nxp-condor-head [data-money]")!;
    draw();
    expect(condor().textContent).toBe("-$140");
    cleanup();
    draw({ privacy: true });
    expect(condor().textContent).toBe("$•••");
  });

  it("draw no progress bar for a rule with no figure, where 0% would read as far from it", () => {
    const blind = QUOTES.map((q) => q.id === "w-dec18" ? { ...q, fill: null, watched: null } as Entry : q);
    draw({ quotes: blind });
    expect(within(card("w-dec18")).queryByRole("progressbar")).toBeNull();
    expect(within(card("w-dec18")).getByText(/no figure/)).toBeTruthy();
    expect(within(card("w-dec31")).getByRole("progressbar")).toBeTruthy();
  });
});

describe("the detail sheet", () => {
  it("opens from a holding's card with its detail and the Monitors about it", async () => {
    draw();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of 1218_C7300/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "1218_C7300" })).toBeTruthy();
    expect(within(sheet).getByText("cost to close")).toBeTruthy();
    expect(within(sheet).getByText(/\|spread value\| ≥ 4/)).toBeTruthy();
  });

  it("opens from a watchlist card with its sentence and the leg rules under it", async () => {
    draw();
    fireEvent.click(within(card("w-dec18")).getByRole("button", { name: /details of 1218_P7150/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/\|spread value\| ≥ 6/)).toBeTruthy();
    expect(within(sheet).getByText(/\|delta\| ≥ 0\.2/)).toBeTruthy();
  });

  it("closes on Back without leaving the page", async () => {
    draw();
    fireEvent.click(within(card("h-ic")).getByRole("button", { name: /details of/ }));
    await screen.findByRole("dialog");
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region("Holdings")).toBeTruthy();
  });

  it("follows the live figures while it is open", async () => {
    const { rerender } = draw();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("-$240")).toBeTruthy();
    const moved = HOLDINGS.map((h) => h.id === "h-calls" ? { ...h, pnl: -300 } : h);
    rerender(<div className="nx"><PhoneBook quotes={QUOTES} monitors={MONITORS} holdings={moved}
      holdingsError={null} holdingsAt={null} mode="live" session privacy={false} entryStyle="opportunity" /></div>);
    expect(within(screen.getByRole("dialog")).getByText("-$300")).toBeTruthy();
  });
});

describe("the detail sheet, beyond opening and closing", () => {
  const props = (over: Partial<BookProps> = {}): BookProps => ({
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null,
    holdingsAt: null, mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", ...over,
  });

  it("hides its $ amount under privacy", async () => {
    draw({ privacy: true });
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector(".nxp-hero [data-money]")!.textContent).toBe("$•••");
    expect(within(sheet).queryByText(/\$\d/)).toBeNull();
  });

  it("hides the contract count under privacy, since contracts × points × 100 is the money", async () => {
    const big = HOLDINGS.map((h) => ({ ...h, contracts: 7 }) as Holding);
    for (const privacy of [false, true]) {
      draw({ privacy, holdings: big });
      fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
      const sheet = await screen.findByRole("dialog");
      expect(sheet.textContent!.includes("×7")).toBe(!privacy);
      if (privacy) expect(sheet.textContent).toContain("×•••");
      cleanup();
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
  });

  it("draws no progress bar in the sheet for a rule with no figure", async () => {
    const blind = QUOTES.map((q) => q.id === "w-dec18" ? { ...q, fill: null, watched: null } as Entry : q);
    draw({ quotes: blind });
    fireEvent.click(within(card("w-dec18")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("progressbar")).toBeNull();
  });

  it("stays closed when what it showed goes away and comes back, and pushes no second entry", async () => {
    const pushed = vi.spyOn(window.history, "pushState");
    try {
      const { rerender } = render(<div className="nx"><PhoneBook {...props()} /></div>);
      fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
      await screen.findByRole("dialog");
      expect(pushed).toHaveBeenCalledTimes(1);
      // a valuation fails: the holding is gone from the page, and so is the sheet
      rerender(<div className="nx"><PhoneBook {...props({ holdings: null, holdingsError: "timed out" })} /></div>);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      // the next poll values it again: nobody asked for the sheet, so it does not come back
      rerender(<div className="nx"><PhoneBook {...props()} /></div>);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pushed).toHaveBeenCalledTimes(1);
    } finally {
      pushed.mockRestore();
    }
  });

  it("takes its history entry back when it is unmounted open, as when the phone turns into the desk", async () => {
    history.replaceState({ before: "the sheet" }, "");
    const { unmount } = draw();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    await screen.findByRole("dialog");
    expect(history.state?.panel).toBe(true);
    unmount();
    await waitFor(() => expect(history.state?.before).toBe("the sheet"));
  });
});

describe("REVIEW", () => {
  it("pages through the holdings one per screen, in the book's order", () => {
    draw({ mode: "review" });
    const review = region("Review");
    const pages = [...review.querySelectorAll<HTMLElement>("[data-page]")];
    expect(pages.map((p) => p.dataset.ref)).toEqual(["h-calls", "h-puts", "h-ic"]);
    expect(within(review).getByText("1 of 3")).toBeTruthy();
    const prev = within(review).getByRole("button", { name: "previous holding" });
    const next = within(review).getByRole("button", { name: "next holding" });
    expect(prev.hasAttribute("disabled")).toBe(true);
    fireEvent.click(next);
    expect(within(review).getByText("2 of 3")).toBeTruthy();
    fireEvent.click(next);
    expect(within(review).getByText("3 of 3")).toBeTruthy();
    expect(next.hasAttribute("disabled")).toBe(true);
  });

  it("gives each page the holding's figures and says when they were valued", () => {
    draw({ mode: "review", holdings: HOLDINGS.map((h) => ({ ...h, schedule: SCHEDULE }) as Holding) });
    const page = region("Review").querySelector<HTMLElement>('[data-page][data-ref="h-calls"]')!;
    expect(within(page).getByText("-$240")).toBeTruthy();
    expect(within(page).getByText("captured")).toBeTruthy();
    expect(within(page).getByText("pace gap")).toBeTruthy();
    expect(within(region("Review")).getByText("market closed — valued at 23:14")).toBeTruthy();
  });

  it("says when they were valued by the session, whichever tab (#371)", () => {
    draw({ mode: "live", session: false });
    expect(screen.getByText("market closed — valued at 23:14")).toBeTruthy();
    cleanup();
    draw({ mode: "review", session: true });
    expect(document.querySelector(".nx-mkt-closed")).toBeNull();
  });

  it("hides the contract count on its pages under privacy, and shows it otherwise", () => {
    const big = HOLDINGS.map((h) => ({ ...h, contracts: 7 }) as Holding);
    draw({ mode: "review", holdings: big });
    expect(region("Review").textContent).toContain("×7");
    cleanup();
    draw({ mode: "review", holdings: big, privacy: true });
    expect(region("Review").textContent).not.toContain("×7");
    expect(region("Review").textContent).toContain("×•••");
  });

  it("still draws the watchlist, so a banner about it has a card to lead to", () => {
    draw({ mode: "review" });
    expect(refs(region("Watchlist"))).toContain("w-dec04");
  });
});

// ---- fixtures beyond the owner's book ----

const SCHEDULE = {
  on_pace: 1.5, pace_gap: 0.3, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21,
  reached: null, manage_by_due: false, dte_at_open: 45,
};

/** A delta rule on the held call spread's short leg, linked to that holding. */
const SHORT_LEG = {
  ...QUOTES.find((q) => q.id === "w-lone")!,
  id: "r-calls-short", code: "US.SPXW261218C7300000", strike_date: "2026-12-18",
  held: true, positions: [{ id: "h-calls", name: "1218_C7300" }], threshold: 0.3, watched: 0.231,
  distance: 0.069, quote: { name: "SPXW 261218 7300.00C", option_delta: 0.231 },
} as Entry;

const SHORT_LEG_RULE = {
  ...MONITORS[0]!, id: "r-calls-short", code: "US.SPXW261218C7300000", strike_date: "2026-12-18",
  option_type: "CALL", strike: 7300, legs: null, enabled: true,
} as Monitor;

describe("a combo that only partly overlaps a holding (#346)", () => {
  const overlap = (over: Partial<BookProps> = {}) =>
    draw({ quotes: OVERLAP_QUOTES, holdings: OVERLAP_HOLDINGS, monitors: OVERLAP_MONITORS, ...over });
  const note = (ref: string) => card(ref).querySelector<HTMLElement>("[data-overlap]")?.textContent ?? null;

  it("is a card in the watchlist with its note, and the holding's card keeps its own rules", () => {
    overlap();
    // a wing of a held condor names nothing unheld, and stays on the condor's card
    expect(refs(region("Holdings")))
      .toEqual(["h-8050", "r-8050", "r-8050-delta", "h-7700", "r-7700", "h-ic", "r-ic-calls", "h-7200"]);
    expect(refs(region("Watchlist"))).toEqual(["r-8100", "w-8150-delta", "w-7700", "r-ratio"]);
    expect(note("r-8100")).toBe("shares C8100 with 1231_8050");
    expect(note("w-7700")).toBe("contains 1231_7700's C7700");
    expect(note("r-ratio")).toBe("contains 1231_7200's C7200 and C7250");
    expect(card("h-8050").querySelector("[data-overlap]")).toBeNull();
    expect(card("h-ic").querySelector("[data-overlap]")).toBeNull();
  });

  it("says it in the detail sheet too, and under privacy", async () => {
    overlap({ privacy: true });
    expect(note("w-7700")).toBe("contains 1231_7700's C7700");
    fireEvent.click(within(card("w-7700")).getByRole("button", { name: /details of 1231_C7700/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector("[data-overlap]")!.textContent).toBe("contains 1231_7700's C7700");
  });

  it("is on its holding's REVIEW page no more, and still in the watchlist there", () => {
    overlap({ mode: "review" });
    expect(refs(region("Watchlist"))).toEqual(["r-8100", "w-8150-delta", "w-7700", "r-ratio"]);
    expect(refs(region("Review"))).not.toContain("r-8100");
    expect(refs(region("Review"))).toContain("r-ic-calls");
  });
});
