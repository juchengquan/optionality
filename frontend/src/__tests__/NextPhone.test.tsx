/** The phone's book, arrangement B (ADR 0023, #290): cards drawn from `placeBook`, a detail sheet
 *  that Back closes (ADR 0005: a history entry, not a route), and one book in session and out
 *  of it (#374).
 *
 *  Behaviour only. What a phone must MEASURE — nothing pushed sideways, 44pt targets, Back under
 *  the iPhone profile — is `__browser__/NextPhone.iphone.test.tsx`. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { BookProps } from "../Book";
import { placeBook } from "../placement";
import { PhoneBook } from "../phone/PhoneBook";
import { DeskBook } from "../desk/DeskBook";
import { Still } from "../snapshot/Still";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";
import { legMarks } from "../testing/legs";

afterEach(cleanup);

function draw(over: Partial<BookProps> = {}) {
  const props: BookProps = {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null,
    holdingsAt: "23:14:05", session: true, privacy: false, entryStyle: "opportunity", ...over,
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

describe("the cards, on the owner's book", () => {
  const book = placeBook(QUOTES, HOLDINGS, MONITORS);

  it("draw the one book placeBook places, in its order: each expiry's held spreads with their rules, watched spreads, contracts", () => {
    draw();
    const expected = book.book.flatMap((g) => [
      ...g.held.flat().flatMap(({ holding, rules }) => [holding.id, ...rules.map((r) => r.id)]),
      ...[...g.spreads, ...g.contracts].flatMap(({ entry, under }) => [entry.id, ...under.map((u) => u.id)]),
    ]);
    expect(refs(region("Book"))).toEqual(expected);
    expect(expected).toEqual([
      "w-dec04", "h-calls", "r-calls", "h-puts", "w-dec18", "w-dec18-delta", "h-ic", "r-ic", "w-dec31", "w-lone",
    ]);
    expect(screen.queryByRole("region", { name: "Holdings" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Watchlist" })).toBeNull();
    const spread = card("w-dec18");
    expect(within(spread).getByText(/\|Δ\| ≥ 0\.20 — now/)).toBeTruthy();
  });

  it("group it by expiry, under ONE heading per expiry in each of Spreads and Contracts", () => {
    draw();
    const groups = [...region("Spreads").querySelectorAll<HTMLElement>("[data-expiry]")].map((g) => g.dataset.expiry);
    expect(groups).toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
    expect([...region("Contracts").querySelectorAll<HTMLElement>("[data-expiry]")].map((g) => g.dataset.expiry))
      .toEqual(["2026-12-31"]);
    // the expiry as the page writes a date, and its DTE said once, here (parts F and K)
    expect(within(region("Book")).getAllByRole("heading", { name: /20261218/ })).toHaveLength(1);
  });

  it("sit a condor's two cards together, the calls first", () => {
    draw();
    const condor = within(region("Book")).getByRole("group", { name: /iron condor/ });
    expect([...condor.querySelectorAll<HTMLElement>("article[data-ref]")].map((a) => a.dataset.ref))
      .toEqual(["h-calls", "h-puts"]);
  });

  it("give a held spread a large P&L, its Cost to close, short-leg Δ and the Level reached, its DTE once, on its expiry", () => {
    // the deltas withheld, so the short call's is its rule's (the fallback, #318)
    const stopped: Holding[] = HOLDINGS.map((h) => ({ ...h, legs_delta: null })).map((h) => h.id === "h-calls"
      ? { ...h, schedule: { ...SCHEDULE, reached: "stop" } } as Holding : h);
    draw({ holdings: stopped, quotes: [...QUOTES, SHORT_LEG], monitors: [...MONITORS, SHORT_LEG_RULE] });
    const c = card("h-calls");
    expect(c.querySelector(".nxp-hero [data-money]")!.textContent).toBe("−$240");
    expect(within(c).getByText("4.40")).toBeTruthy();         // cost to close
    expect(within(c).getByText("0.231")).toBeTruthy();        // the short call's Δ, from its rule
    // the DTE is its expiry's heading's, and not said again on the card (part K)
    expect(c.textContent).not.toContain("DTE");
    expect(c.closest("[data-expiry]")!.querySelector("h3")!.textContent).toMatch(/38 DTE/);
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
    expect(short("h-puts")).toBe("−0.210");
    // a 4-leg holding lists each short leg
    expect(short("h-ic")).toBe("C7400 0.120 · P6300 −0.250");
  });

  it("show each rule's sentence and its arrowed distance, and no progress bar (2026-11-17)", () => {
    draw();
    const c = card("w-dec18");
    // the distance says how close; the bar under the figures said it again
    expect(c.querySelector(".nx-rule-short")!.textContent).toMatch(/↑3\.60$/);
    expect(document.querySelectorAll("[role=progressbar], [role=meter], .nxp-progress, .nxd-fill, [data-fill]")).toHaveLength(0);
    expect(within(c).getByText(/\|value\| ≥ 6\.00 — now 2\.40, 3\.60 away/)).toBeTruthy();
  });

  it("style a fired entry as an entry signal, and a fired rule on a holding as ringing", () => {
    draw();
    expect(card("w-dec04").dataset.state).toBe("entry");
    expect(within(card("w-dec04")).getByText("entry signal")).toBeTruthy();
    expect(card("r-calls").dataset.state).toBe("alarm");
    expect(within(card("r-calls")).getByText("ringing")).toBeTruthy();
  });

  it("list the quarantined rules as faults and the muted ones as muted", () => {
    draw();
    const off = region("Switched off");
    const row = (id: string) => off.querySelector<HTMLElement>(`[data-monitor="${id}"]`)!;
    expect(row("q-unknown").dataset.state).toBe("quarantined");
    expect(within(row("q-unknown")).getByText("quarantined")).toBeTruthy();
    expect(within(row("q-unknown")).getByText(/the provider does not know its contract/)).toBeTruthy();
    expect(row("m-muted").dataset.state).toBe("muted");
    // the page's one set of words for why a rule is off (part I)
    expect(within(row("m-muted")).getByText(/muted by you/)).toBeTruthy();
    expect(within(row("m-expired")).getByText(/expired/)).toBeTruthy();
  });

  it("say the rules on held contracts apart while the holdings are not valued", () => {
    draw({ holdings: null, holdingsError: "OpenD timed out" });
    expect(within(region("Book")).getByText(/could not be valued — OpenD timed out/)).toBeTruthy();
    expect(refs(screen.getByTestId("unplaced"))).toEqual(["r-calls", "r-ic"]);
  });

  it("hide $ amounts under privacy and keep the rest", () => {
    draw({ privacy: true });
    expect(card("h-calls").querySelector(".nxp-hero [data-money]")!.textContent).toBe("$•••");
    expect(within(card("h-calls")).getByText(/^captured \d+%$/)).toBeTruthy();
  });

  it("hide a condor's summed P&L under privacy, and show it otherwise", () => {
    const condor = () => within(region("Book")).getByRole("group", { name: /iron condor/ })
      .querySelector(".nxp-condor-head [data-money]")!;
    draw();
    expect(condor().textContent).toBe("−$140");
    cleanup();
    draw({ privacy: true });
    expect(condor().textContent).toBe("$•••");
  });

  it("say a rule with no figure has none, in words", () => {
    const blind = QUOTES.map((q) => q.id === "w-dec18" ? { ...q, fill: null, watched: null } as Entry : q);
    draw({ quotes: blind });
    expect(within(card("w-dec18")).getAllByText(/no figure/).length).toBeGreaterThan(0);
  });
});

describe("the cards say what the desk's rows say (part K)", () => {
  it("gives every watch card its value and Δ, as its desk row writes them", () => {
    render(<DeskBook quotes={QUOTES} monitors={MONITORS} holdings={HOLDINGS} holdingsError={null} holdingsAt={null}
                     session privacy={false} entryStyle="opportunity" />);
    const desk = new Map([...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].map((r) => [r.dataset.ref!, {
      value: r.querySelector('[data-col="value"] .nxd-v')?.textContent ?? null,
      delta: r.querySelector('[data-col="delta"] .nxd-v')?.textContent ?? null,
    }]));
    cleanup();
    draw();
    const cards = [...region("Book").querySelectorAll<HTMLElement>("article.nxp-watch[data-ref]")];
    expect(cards.length).toBeGreaterThan(3);
    for (const c of cards) {
      const row = desk.get(c.dataset.ref!)!;
      expect(c.querySelector("[data-value] dd")!.textContent, c.dataset.ref).toBe(row.value);
      expect(c.querySelector("[data-delta] dd")!.textContent, c.dataset.ref).toBe(row.delta);
    }
  });

  it("draws each rule on a holding's card with its arrowed distance, as a watch card draws its own, and no bar", () => {
    draw();
    const lines = [...card("h-calls").querySelectorAll<HTMLElement>(".nxp-rule")];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.querySelector(".nx-rule-short")!.textContent, line.dataset.ref).toMatch(/[↑↓▲▼]/);
      expect(line.querySelectorAll("[role=progressbar], [role=meter], .nxp-progress, .nxd-fill, [data-fill]"), line.dataset.ref).toHaveLength(0);
    }
  });

  it("says a short leg's Δ from the one source the desk's table reads, a delta rule's figure included (review of #420)", async () => {
    // no served leg delta, and a quote that carries none: the rule's watched figure is the Δ
    const bare = HOLDINGS.map((h) => ({ ...h, legs_delta: null }));
    const leg = { ...SHORT_LEG, field: "option_delta", quote: { name: "SPXW 261218 7300.00C" } } as Entry;
    const book = { holdings: bare, quotes: [...QUOTES, leg], monitors: [...MONITORS, SHORT_LEG_RULE] };
    render(<DeskBook {...book} holdingsError={null} holdingsAt={null} session privacy={false} entryStyle="opportunity" />);
    const row = document.querySelector<HTMLElement>('.nxd-row[data-ref="h-calls"]')!;
    const table = row.querySelector('[data-col="delta"] .nxd-v')!.textContent;
    fireEvent.click(within(row).getByRole("button", { name: "1218_C7300 held" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_C7300" });
    const inspector = within(insp).getByText("short Δ").nextElementSibling!.textContent;
    cleanup();
    draw(book);
    const onCard = within(card("h-calls")).getByText("short Δ").nextSibling!.textContent;
    expect(table).toBe("0.231");
    expect(inspector).toBe(table);
    expect(onCard).toBe(table);
  });

  it("says a holding's DTE once, on its expiry's heading and not on its card", () => {
    draw();
    for (const c of region("Book").querySelectorAll<HTMLElement>("article.nxp-holding[data-ref]")) {
      expect(c.textContent, c.dataset.ref).not.toMatch(/\bDTE\b/);
      expect(c.closest("[data-expiry]")!.querySelector("h3")!.textContent).toMatch(/\d+ DTE$/);
    }
  });
});

describe("the legs, each type marked for its colour and a short leg for its weight (#391)", () => {
  // short first, as every place writes a structure's legs (2026-11-16)
  const IC = ["−C7400 short CALL", "−P6300 short PUT", "+C7450 long CALL", "+P6250 long PUT"];

  it("on a holding's card and a watched spread's, and where the card names each short leg by its Δ", () => {
    draw();
    expect(legMarks(within(card("h-ic")).getByText("short Δ").nextElementSibling!))
      .toEqual(["C7400 short CALL", "P6300 short PUT"]);
    expect(legMarks(card("h-ic").querySelector(".nxp-legs")!)).toEqual(IC);
    expect(legMarks(card("w-dec31").querySelector(".nxp-legs")!)).toEqual(["−C7600 short CALL", "+C7650 long CALL"]);
  });

  it("in the detail sheet of each", async () => {
    draw();
    fireEvent.click(within(card("h-ic")).getByRole("button", { name: /details of/ }));
    // the legs are a section of their own, as the desk's inspector draws them (part J)
    const line = () => screen.getByRole("dialog").querySelector("[data-section='legs']")!;
    await screen.findByRole("dialog");
    // in words, short first, as the inspector lists them
    expect(legMarks(line())).toEqual(IC.map((m) => m.replace(/^[−+]([CP])(\d+) (\w+) (\w+)$/, "$3 $4 $2 $3 $4")));
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(card("w-dec31")).getByRole("button", { name: /details of/ }));
    await screen.findByRole("dialog");
    expect(legMarks(line())).toEqual(["short CALL 7600 short CALL", "long CALL 7650 long CALL"]);
  });

  it("in the saved picture, as words only: the letters and signs, never a colour (#394)", () => {
    render(<Still quotes={QUOTES} monitors={MONITORS} holdings={HOLDINGS} holdingsError={null}
                  holdingsAt="23:14:05" session privacy={false} needs={[]} health={null} polledAt={null}
                  error={null} references={[]} hidden={new Set()} takenAt={new Date("2026-11-16T15:00:00Z")} />);
    const ic = [...document.querySelectorAll("tr")].find((tr) => tr.children[0]?.textContent === "1231_IC held")!;
    expect(ic.children[1]!.textContent).toBe("−C7400 −P6300 +C7450 +P6250");
    expect(document.querySelectorAll(".nx-still .nx-leg, .nx-still [data-type]")).toHaveLength(0);
  });
});

describe("the detail sheet", () => {
  it("opens from a holding's card with its detail and the Monitors about it", async () => {
    draw();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of 1218_C7300/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "1218_C7300" })).toBeTruthy();
    expect(within(sheet).getByText("cost to close")).toBeTruthy();
    expect(within(sheet).getByText(/\|value\| ≥ 4\.00 — now/)).toBeTruthy();
  });

  it("opens from a watchlist card with its sentence and the leg rules under it", async () => {
    draw();
    fireEvent.click(within(card("w-dec18")).getByRole("button", { name: /details of 1218_P7150/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/\|value\| ≥ 6\.00 — now/)).toBeTruthy();
    expect(within(sheet).getByText(/\|Δ\| ≥ 0\.20 — now/)).toBeTruthy();
  });

  it("closes on Back without leaving the page", async () => {
    draw();
    fireEvent.click(within(card("h-ic")).getByRole("button", { name: /details of/ }));
    await screen.findByRole("dialog");
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region("Book")).toBeTruthy();
  });

  it("follows the live figures while it is open", async () => {
    const { rerender } = draw();
    fireEvent.click(within(card("h-calls")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("−$240")).toBeTruthy();
    const moved = HOLDINGS.map((h) => h.id === "h-calls" ? { ...h, pnl: -300 } : h);
    rerender(<div className="nx"><PhoneBook quotes={QUOTES} monitors={MONITORS} holdings={moved}
      holdingsError={null} holdingsAt={null} session privacy={false} entryStyle="opportunity" /></div>);
    expect(within(screen.getByRole("dialog")).getByText("−$300")).toBeTruthy();
  });
});

describe("the detail sheet, beyond opening and closing", () => {
  const props = (over: Partial<BookProps> = {}): BookProps => ({
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null,
    holdingsAt: null, session: true, privacy: false, entryStyle: "opportunity", ...over,
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

  it("draws no progress bar in the sheet: its rule lines say the distance (2026-11-17)", async () => {
    draw();
    fireEvent.click(within(card("w-dec18")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector("[data-section='rules'] li .nx-rule-short")!.textContent).toMatch(/↑3\.60$/);
    expect(sheet.querySelectorAll("[role=progressbar], [role=meter], .nxp-progress, .nxd-fill, [data-fill]")).toHaveLength(0);
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

describe("one book, in session and out of it (#374)", () => {
  const drawn = () => [...document.querySelectorAll<HTMLElement>(".nx [data-ref]")].map((el) => el.dataset.ref);

  it("draws the same cards in session and out of it, and no pager", () => {
    draw({ session: true });
    const inSession = drawn();
    expect(inSession.length).toBeGreaterThan(0);
    for (const session of [true, false]) {
      cleanup();
      draw({ session });
      expect(drawn(), `${session ? "in" : "out of"} session`).toEqual(inSession);
      expect(document.querySelector("[data-page], .nxp-pager, .nxp-track")).toBeNull();
      expect(screen.queryByRole("button", { name: /next holding|previous holding/ })).toBeNull();
      expect(region("Book")).toBeTruthy();
    }
  });

  it("says when they were valued outside the session, and not in it (#371)", () => {
    draw({ session: false });
    expect(within(region("Book")).getByText("market closed — valued at 23:14")).toBeTruthy();
    cleanup();
    draw({ session: true });
    expect(document.querySelector(".nx-mkt-closed")).toBeNull();
  });

  it("gives each holding's card its cost to close and pace gap in ONE field, the gap in its outcome's colour (2026-11-16)", () => {
    const paced = HOLDINGS.map((h) => ({ ...h, schedule: { ...SCHEDULE, pace_gap: h.id === "h-puts" ? -0.25 : 0.3 } }) as Holding);
    draw({ holdings: [...paced,
      { ...HOLDINGS[0]!, id: "h-bare", name: "bare", schedule: null } as Holding,
      { ...paced[0]!, id: "h-unvalued", name: "unvalued", cost_to_close: null } as Holding] });
    const terms = (ref: string) => [...card(ref).querySelectorAll(".nxp-facts dt")].map((d) => d.textContent);
    const field = (ref: string) => [...card(ref).querySelectorAll(".nxp-facts > div")]
      .find((d) => d.querySelector("dt")?.textContent === "cost to close")!.querySelector("dd")!;
    const drawn = (ref: string) => field(ref).querySelector<HTMLElement>('[aria-hidden="true"]') ?? field(ref);
    // one field: no "pace gap" of its own
    expect(terms("h-calls")).toEqual(["cost to close", "short Δ"]);
    expect(drawn("h-calls").textContent).toBe("4.40 +0.30");
    expect(drawn("h-calls").querySelector("[data-outcome]")?.getAttribute("data-outcome")).toBe("loss");
    expect(drawn("h-puts").textContent).toBe("1.00 \u22120.25");
    expect(drawn("h-puts").querySelector("[data-outcome]")?.getAttribute("data-outcome")).toBe("gain");
    // said in words, both of them
    expect(field("h-puts").querySelector(".sr-only")?.textContent).toBe("1.00, pace gap ahead by 0.25");
    // no schedule: the cost alone; no cost: a dash and no gap
    expect(field("h-bare").textContent).toBe("1.00");
    expect(field("h-unvalued").textContent).toBe("—");
  });

  it("still draws the watchlist outside the session, so a banner about it has a card to lead to", () => {
    draw({ session: false });
    expect(refs(region("Book"))).toContain("w-dec04");
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
  const OVERLAP_ORDER = [
    "h-8050", "r-8050", "r-8050-delta", "h-ic", "r-ic-calls", "h-7200",
    "r-8100", "w-8150-delta", "w-7700", "r-ratio",
    "h-7700", "r-7700",
  ];

  it("is a card among the watched spreads with no note on it, and the holding's card keeps its own rules", () => {
    overlap();
    // a wing of a held condor names nothing unheld, and stays on the condor's card; the combos
    // that name a contract nobody holds follow the held spreads, under the same expiry; the holding
    // of one call is under Contracts (2026-11-17)
    expect(refs(region("Book"))).toEqual(OVERLAP_ORDER);
    // what each shares is said in its sheet, not on its card (the owner, 2026-11-17)
    for (const id of ["r-8100", "w-7700", "r-ratio"]) expect(note(id), id).toBeNull();
    expect(card("h-8050").querySelector("[data-overlap]")).toBeNull();
    expect(card("h-ic").querySelector("[data-overlap]")).toBeNull();
  });

  it("says it in the detail sheet too, and under privacy", async () => {
    overlap({ privacy: true });
    // not on its card (2026-11-17): the sheet says it
    expect(note("w-7700")).toBeNull();
    fireEvent.click(within(card("w-7700")).getByRole("button", { name: /details of 1231_C7700/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector("[data-overlap]")!.textContent).toBe("contains 1231_7700's C7700");
  });

  it("lists no cost to close in its sheet, as the desk's inspector lists none (2026-11-16)", async () => {
    overlap();
    fireEvent.click(within(card("r-8100")).getByRole("button", { name: /details of 1231_8100/ }));
    const sheet = await screen.findByRole("dialog");
    const labels = [...within(sheet).getByRole("group", { name: "figures" }).querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toEqual(["value", "Δ", "Γ", "Θ", "ν"]);
  });

  it("is placed the same outside the session", () => {
    overlap({ session: false });
    expect(refs(region("Book"))).toEqual(OVERLAP_ORDER);
  });
});
