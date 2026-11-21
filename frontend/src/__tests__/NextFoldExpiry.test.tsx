/** The book's expiry groups fold (the owner, 2026-11-21), on the desk and the phone alike.
 *
 *  1. Each expiry's heading inside Spreads and Contracts is a button that folds that group's rows;
 *     the sections themselves do not fold.
 *  2. A folded heading keeps its date and DTE and adds what the arrangement draws of the group,
 *     counted — the desk's rows, the phone's cards — and what in it needs the owner, in the chips'
 *     own words and colours. A group never reopens by itself when it rings; a jump to one of its
 *     rows — a banner's tap, the palette, the price map — opens it, as a press on its heading.
 *  3. Remembered per browser in a cookie, keyed by section AND expiry, storing what is FOLDED: every
 *     group starts open; a write is made to the cookie as it stands now; a hand-edited cookie is read
 *     tolerantly; an expiry no longer in the book drops out of it when next written.
 *  4. The saved picture and "Copy as text" show every row whatever is folded
 *     (`NextSaveImage.test.tsx`, which drives the page's own presses).
 *  The geometry — a folded heading inside the screen at iPhone width — is the browser suite's
 *  (`__browser__/NextFoldExpiry*.test.tsx`).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { NOTHING_SELECTED, type DeskSelection } from "../desk/keys";
import { Next } from "../Next";
import { PhoneBook } from "../phone/PhoneBook";
import { reveal } from "../NeedsLine";
import { readFolded, writeFolded } from "../shared/prefs";
import { call, entry, HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { holdingService } from "../testing/holdingService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // jsdom has none: `scrolls()` gives it one for a test, taken away again here
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  for (const n of ["ui_folded", "ui_arrangement", "ui_price_map"]) document.cookie = `${n}=;path=/;max-age=0`;
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

/** The 12-18 put spread at its stop: so its group carries a Level as well as a ringing rule. */
const AT_STOP: Holding[] = HOLDINGS.map((h) => h.id !== "h-puts" ? h : {
  ...h, schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4, target_dte: 11,
    manage_by_dte: 21, reached: "stop", manage_by_due: false },
} as Holding);

/** Two rules drawn UNDER the held call spread, not on its row: one ringing, one at fault. Each is a
 *  row of its own on the desk, a line on the card on the phone, and counted on a folded heading. */
const under = (id: string, over: Partial<Entry>): Entry => entry(id, {
  code: `1218_C7300 ${id}`, strike_date: "2026-12-18", legs: call(7300, 7350), field: "option_delta",
  threshold: 0.3, watched: 0.33, distance: -0.03, held: true, scope: "all",
  positions: [{ id: "h-calls", name: "1218_C7300" }], combo_greeks: { option_delta: 0.33 }, ...over,
} as Partial<Entry> & { strike_date: string });
const UNDER = [under("r-under-ringing", { triggered: true }), under("r-under-fault", { error: "no figure" })];

const ARRANGEMENTS = [
  ["desk", (p: BookProps) => render(<DeskBook {...p} />), ".nxd-row[data-ref]"],
  ["phone", (p: BookProps) => render(<PhoneBook {...p} />), "article[data-ref]"],
] as const;

/** An expiry's heading button, in a section. */
const head = (section: string, expiry: string) =>
  document.querySelector<HTMLButtonElement>(`[data-section="${section}"] [data-expiry="${expiry}"] h3 button`)!;
/** What a heading's button folds. */
const body = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-controls")!)!;
/** Every `scrollIntoView` from here on, and whether what was scrolled to was folded away then: jsdom
 *  scrolls nothing, so the call is what is seen. */
function scrolls(): { el: Element; hidden: boolean }[] {
  const seen: { el: Element; hidden: boolean }[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    seen.push({ el: this, hidden: this.closest("[hidden]") !== null });
  };
  return seen;
}
const cookie = () => document.cookie.split("; ").find((c) => c.startsWith("ui_folded="))?.slice("ui_folded=".length) ?? null;

for (const [arrangement, draw, rows] of ARRANGEMENTS) {
  /** "3 rows" on the desk, "3 cards" on the phone: each arrangement counts what it draws (the
   *  owner, 2026-11-21) */
  const n = (count: number) => `${count} ${arrangement === "desk" ? "row" : "card"}${count === 1 ? "" : "s"}`;
  describe(`on the ${arrangement}`, () => {
    it("draws every group open at first, each heading a button that controls its rows, and writes nothing", () => {
      draw(props());
      const heads = [...document.querySelectorAll<HTMLElement>("[data-section] [data-expiry] h3")];
      expect(heads).toHaveLength(5);
      for (const h of heads) {
        const b = h.querySelector("button")!;
        expect(b, h.textContent!).toBeTruthy();
        expect(b.getAttribute("aria-expanded")).toBe("true");
        expect(body(b).hidden).toBe(false);
        expect(body(b).querySelector(rows), "its body holds its rows").toBeTruthy();
        // the date and its DTE, as before
        expect(b.textContent).toMatch(/^\d{8} · \d+ DTE$/);
      }
      // the sections are headings, never buttons: they do not fold
      for (const s of document.querySelectorAll("[data-section] > h2")) expect(s.querySelector("button")).toBeNull();
      expect(cookie()).toBeNull();
    });

    it("folds a group's rows at a press and opens them at the next, the heading saying which", () => {
      draw(props());
      const b = head("spreads", "2026-12-18");
      fireEvent.click(b);
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(body(b).hidden).toBe(true);
      expect(body(b).closest("[data-expiry]")!.hasAttribute("data-folded")).toBe(true);
      // the others are left as they were
      expect(head("spreads", "2026-12-04").getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(b);
      expect(b.getAttribute("aria-expanded")).toBe("true");
      expect(body(b).hidden).toBe(false);
      expect(b.textContent).toBe("20261218 · 38 DTE");
    });

    it("says, folded, its rows and what needs you in it, in the chips' own words and colours", () => {
      draw(props({ holdings: AT_STOP }));
      fireEvent.click(head("spreads", "2026-12-04"));
      expect(head("spreads", "2026-12-04").textContent).toBe(`20261204 · 38 DTE · ${n(1)} · 1 entry signal`);
      fireEvent.click(head("spreads", "2026-12-18"));
      // the put spread at its stop, the call spread's own rule ringing: by the needs-you line's order
      const b = head("spreads", "2026-12-18");
      expect(b.textContent).toBe(`20261218 · 38 DTE · ${n(3)} · 1 at stop · 1 ringing`);
      const chips = [...b.querySelectorAll<HTMLElement>(".nx-chip")];
      expect(chips.map((c) => c.dataset.kind ?? c.dataset.attention)).toEqual(["stop", "alarm"]);
      for (const c of chips) expect(c.querySelector("svg"), "each carries its kind's glyph").toBeTruthy();
      // a quiet group says its count alone
      fireEvent.click(head("contracts", "2026-12-31"));
      expect(head("contracts", "2026-12-31").textContent).toBe(`20261231 · 38 DTE · ${n(1)}`);
    });

    it("counts the rules drawn under a holding: their chips, and on the desk their rows", () => {
      draw(props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP }));
      // both under the call spread on the desk's rows, and on its card on the phone
      const drawnUnder = arrangement === "desk"
        ? UNDER.map((e) => document.querySelector(`.nxd-row[data-ref="${e.id}"]`)!.hasAttribute("data-nested"))
        : UNDER.map((e) => document.querySelector(`article[data-ref="h-calls"] [data-ref="${e.id}"]`) !== null);
      expect(drawnUnder).toEqual([true, true]);
      fireEvent.click(head("spreads", "2026-12-18"));
      // the desk's rows: the call spread, its two rules, the put spread, the watched spread; the
      // phone's cards: the two spreads held and the one watched, the rules inside the first. Its own
      // rule and the one under it ringing, the other under it at fault, the put spread at its stop
      expect(head("spreads", "2026-12-18").textContent)
        .toBe(`20261218 · 38 DTE · ${arrangement === "desk" ? "5 rows" : "3 cards"} · 1 fault · 1 at stop · 2 ringing`);
    });

    it("counts each kind, and says a count of more than one in the plural", () => {
      const twice = QUOTES.map((q) => q.id === "w-dec31" ? { ...q, triggered: true } : q);
      const ic = AT_STOP.map((h) => h.id === "h-ic" ? { ...h, schedule: { ...AT_STOP[0]!.schedule!, reached: "stop" } } as Holding : h);
      draw(props({ quotes: twice.map((q) => q.id === "r-ic" ? { ...q, error: "no figure" } : q), holdings: ic }));
      fireEvent.click(head("spreads", "2026-12-31"));
      // the 4-leg condor at its stop with its own rule at fault; the watched call spread an entry signal
      expect(head("spreads", "2026-12-31").textContent).toBe(`20261231 · 38 DTE · ${n(2)} · 1 fault · 1 at stop · 1 entry signal`);
      cleanup();
      const two = [...QUOTES, { ...QUOTES.find((q) => q.id === "w-dec04")!, id: "w-dec04b", code: "1204_P6800" }];
      draw(props({ quotes: two }));
      fireEvent.click(head("spreads", "2026-12-04"));
      expect(head("spreads", "2026-12-04").textContent).toBe(`20261204 · 38 DTE · ${n(2)} · 2 entry signals`);
    });

    it("stays folded when a rule in it fires, and says so on its heading", () => {
      const { rerender } = draw(props());
      fireEvent.click(head("contracts", "2026-12-31"));
      const ringing = QUOTES.map((q) => q.id === "w-lone" ? { ...q, triggered: true } : q);
      rerender(arrangement === "desk" ? <DeskBook {...props({ quotes: ringing })} /> : <PhoneBook {...props({ quotes: ringing })} />);
      const b = head("contracts", "2026-12-31");
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(body(b).hidden).toBe(true);
      expect(b.textContent).toBe(`20261231 · 38 DTE · ${n(1)} · 1 entry signal`);
    });

    it("keeps an expiry folded under Spreads open under Contracts: the cookie keys the section too", () => {
      draw(props());
      fireEvent.click(head("spreads", "2026-12-18"));
      expect(head("contracts", "2026-12-18").getAttribute("aria-expanded")).toBe("true");
      expect(cookie()).toBe("spreads:20261218");
    });

    it("remembers what is folded for the next load", () => {
      draw(props());
      fireEvent.click(head("contracts", "2026-12-31"));
      fireEvent.click(head("spreads", "2026-12-04"));
      cleanup();
      draw(props());
      expect(head("contracts", "2026-12-31").getAttribute("aria-expanded")).toBe("false");
      expect(head("spreads", "2026-12-04").getAttribute("aria-expanded")).toBe("false");
      expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("true");
    });

    it("writes to the cookie as it stands now, another tab's folds kept", () => {
      draw(props());
      // another tab folded Contracts' 12-31 after this one read the cookie
      document.cookie = "ui_folded=contracts:20261231;path=/";
      fireEvent.click(head("spreads", "2026-12-04"));
      expect([...readFolded()].sort()).toEqual(["contracts:20261231", "spreads:20261204"]);
    });

    it("folds or opens what THIS tab shows, whatever another tab did to the same group", () => {
      draw(props());
      fireEvent.click(head("spreads", "2026-12-04"));
      // another tab opened 12-04 again and folded Contracts' 12-31, after this one drew it folded
      document.cookie = "ui_folded=contracts:20261231;path=/";
      fireEvent.click(head("spreads", "2026-12-04"));
      // the press here opens what is folded here, and keeps the other tab's fold
      expect(head("spreads", "2026-12-04").getAttribute("aria-expanded")).toBe("true");
      expect([...readFolded()]).toEqual(["contracts:20261231"]);
    });

    it("drops an expiry no longer in the book from the cookie when it is next written", () => {
      document.cookie = "ui_folded=spreads:20250117.contracts:20261231;path=/";
      draw(props());
      expect(head("contracts", "2026-12-31").getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(head("spreads", "2026-12-04"));
      expect([...readFolded()].sort()).toEqual(["contracts:20261231", "spreads:20261204"]);
    });

    it("drops nothing while the holdings are not valued: the book drawn then is not the whole book", () => {
      // 12-31's spreads are a held condor and a watched one; folded under a key only a holding makes
      document.cookie = "ui_folded=spreads:20261231.contracts:20261218;path=/";
      const watchOnly = QUOTES.filter((q) => q.id !== "w-dec31");
      draw(props({ quotes: watchOnly, holdings: null }));
      expect(document.querySelector('[data-section="spreads"] [data-expiry="2026-12-31"]')).toBeNull();
      fireEvent.click(head("spreads", "2026-12-04"));
      expect([...readFolded()].sort()).toEqual(["contracts:20261218", "spreads:20261204", "spreads:20261231"]);
    });

    it("drops nothing while the watchlist has not been read: the book drawn then is not the whole book", () => {
      // /quotes failed or has not answered: the holdings are drawn, no watched group is
      document.cookie = "ui_folded=contracts:20261231.spreads:20261204;path=/";
      draw(props({ quotes: [], quotesRead: false }));
      expect(document.querySelector('[data-section="contracts"]')).toBeNull();
      fireEvent.click(head("spreads", "2026-12-18"));
      expect([...readFolded()].sort()).toEqual(["contracts:20261231", "spreads:20261204", "spreads:20261218"]);
    });

    it("reads a hand-edited cookie tolerantly: nonsense is ignored, a stray % does not blank the page", () => {
      document.cookie = "ui_folded=%E0%A4%A.spreads:20261204.bogus.contracts:2026-12-31.Spreads:20261218;path=/";
      draw(props());
      expect(head("spreads", "2026-12-04").getAttribute("aria-expanded")).toBe("false");
      for (const [s, e] of [["spreads", "2026-12-18"], ["contracts", "2026-12-31"], ["spreads", "2026-12-31"]]) {
        expect(head(s!, e!).getAttribute("aria-expanded"), `${s} ${e}`).toBe("true");
      }
      // and the nonsense is gone at the next write
      fireEvent.click(head("contracts", "2026-12-18"));
      expect(cookie()).toBe("contracts:20261218.spreads:20261204");
    });

    it("opens a folded group at a needs-you banner's tap, then brings its row into view and marks it", async () => {
      const scrolled = scrolls();
      draw(props());
      fireEvent.click(head("spreads", "2026-12-04"));
      document.cookie = "ui_folded=spreads:20261204.contracts:20261231;path=/";
      reveal("w-dec04");
      const row = [...document.querySelectorAll<HTMLElement>("[data-ref]")].find((r) => r.dataset.ref === "w-dec04")!;
      await waitFor(() => expect(row.hasAttribute("data-revealed")).toBe(true));
      const b = head("spreads", "2026-12-04");
      expect(b.getAttribute("aria-expanded")).toBe("true");
      expect(body(b).hidden).toBe(false);
      // written as a press on its heading would write it, the other folds kept
      expect([...readFolded()]).toEqual(["contracts:20261231"]);
      // brought into view once it was there to be seen
      expect(scrolled.filter((s) => s.el === row)).toEqual([{ el: row, hidden: false }]);
      expect(b.hasAttribute("data-revealed")).toBe(false);
    });
  });
}

describe("the desk's rows and the phone's cards", () => {
  it("for every group, folded: the same chips, each its own count", () => {
    document.cookie = "ui_folded=spreads:20261204.spreads:20261218.spreads:20261231.contracts:20261218.contracts:20261231;path=/";
    const said = () => [...document.querySelectorAll("[data-section] [data-expiry] h3 button")].map((b) => b.textContent);
    render(<DeskBook {...props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP })} />);
    const desk = said();
    cleanup();
    render(<PhoneBook {...props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP })} />);
    const phone = said();
    expect(desk).toEqual([
      "20261204 · 38 DTE · 1 row · 1 entry signal",
      "20261218 · 38 DTE · 5 rows · 1 fault · 1 at stop · 2 ringing",
      "20261231 · 38 DTE · 2 rows",
      "20261218 · 38 DTE · 1 row",
      "20261231 · 38 DTE · 1 row",
    ]);
    // each arrangement counts what it draws (the owner, 2026-11-21): the phone, its cards — a held
    // spread's rules are lines inside its card. What needs you is said the same on both
    expect(phone).toEqual([
      "20261204 · 38 DTE · 1 card · 1 entry signal",
      "20261218 · 38 DTE · 3 cards · 1 fault · 1 at stop · 2 ringing",
      "20261231 · 38 DTE · 2 cards",
      "20261218 · 38 DTE · 1 card",
      "20261231 · 38 DTE · 1 card",
    ]);
  });
});

/** The owner, 2026-11-21: on the desk, folding the group that holds the selected row closes its
 *  inspector and clears the selection — as if nothing had been selected — and the keyboard's focus
 *  goes to the heading just pressed. Folding any other group leaves both alone; opening one selects
 *  nothing. */
describe("on the desk, folding the selected row's group", () => {
  const inspector = () => screen.queryByRole("complementary", { name: /^inspector:/ });
  const deskRow = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;
  const select = (id: string) => fireEvent.click(deskRow(id).querySelector<HTMLElement>(".nxd-name")!);

  it("closes the inspector, clears the selection and puts the focus on the heading pressed", () => {
    render(<DeskBook {...props()} />);
    select("h-calls");
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    const b = head("spreads", "2026-12-18");
    fireEvent.click(b);
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    expect(document.activeElement).toBe(b);
    // j and k as with nothing selected: from the top of what is drawn
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.querySelector<HTMLElement>(".nxd-row[data-cursor]")!.dataset.ref).toBe("w-dec04");
  });

  it("does the same for a rule drawn under a holding, and for a row the inspector is shut on", () => {
    render(<DeskBook {...props({ quotes: [...QUOTES, ...UNDER] })} />);
    select("r-under-ringing");
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    fireEvent.click(head("spreads", "2026-12-18"));
    // the cursor alone, the inspector shut on it (j moved it there)
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.querySelector<HTMLElement>(".nxd-row[data-cursor]")!.dataset.ref).toBe("w-dec04");
    fireEvent.click(head("spreads", "2026-12-04"));
    expect(document.querySelector(".nxd-row[data-cursor]")).toBeNull();
    expect(document.activeElement).toBe(head("spreads", "2026-12-04"));
  });

  const writes = { edited: () => {}, closed: () => {}, deleted: () => {} };
  /** The selected holding's close form opened in the inspector, an Exit typed into it: a draft. */
  const draft = (exit: string) => {
    fireEvent.click(within(inspector()!).getByRole("button", { name: "close…" }));
    const box = within(inspector()!).getByLabelText("exit, per contract") as HTMLInputElement;
    fireEvent.change(box, { target: { value: exit } });
    return () => within(inspector()!).getByLabelText<HTMLInputElement>("exit, per contract").value;
  };

  // the owner, 2026-11-21 (#468, decision 1): a form open in the inspector holds it, as it holds j,
  // k and the palette
  it("folds the group but keeps the inspector, the selection and the draft while a form is open", () => {
    render(<DeskBook {...props({ writes })} />);
    select("h-calls");
    const typed = draft("1.55");
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    expect(deskRow("h-calls").hasAttribute("data-selected")).toBe(true);
    expect(typed()).toBe("1.55");
  });

  // #468, decision 2: one rule, whatever hid the row — here another tab's fold, taken from the
  // cookie at this tab's press on another heading
  it("clears when another tab's fold hides the selected row, the focus on the heading pressed here", () => {
    render(<DeskBook {...props()} />);
    select("h-calls");
    document.cookie = "ui_folded=spreads:20261218;path=/";
    const b = head("contracts", "2026-12-31");
    fireEvent.click(b);
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    expect(document.activeElement).toBe(b);
  });

  it("keeps a held inspector when another tab's fold hides its row", () => {
    render(<DeskBook {...props({ writes })} />);
    select("h-calls");
    const typed = draft("1.55");
    document.cookie = "ui_folded=spreads:20261218;path=/";
    fireEvent.click(head("contracts", "2026-12-31"));
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    expect(typed()).toBe("1.55");
  });

  // review of #468, round 1 finding 3: OPENING the group the selected row is in clears nothing. While
  // a form holds the row hidden, and on the palette's and the price map's landing (below), which
  // select a hidden row before they open its group
  it("clears nothing when the selected row's folded group is opened, the form still open", async () => {
    render(<DeskBook {...props({ writes })} />);
    select("h-calls");
    draft("1.55");
    fireEvent.click(head("spreads", "2026-12-18"));
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("true");
    // and the form shut now, with its row drawn, clears nothing either
    fireEvent.click(within(inspector()!).getByRole("button", { name: "close…" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    expect(deskRow("h-calls").hasAttribute("data-selected")).toBe(true);
  });

  // review of #468, round 2 finding 3: the rule as the hold ends — the form shut while its row is
  // folded away. No heading was pressed, so the focus is not moved to one
  it("clears when a form that held a folded row's inspector is shut, moving no focus to a heading", async () => {
    render(<DeskBook {...props({ writes })} />);
    select("h-calls");
    draft("1.55");
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(inspector()).not.toBeNull();
    const shut = within(inspector()!).getByRole("button", { name: "close…" });
    shut.focus();
    fireEvent.click(shut);
    await waitFor(() => expect(inspector()).toBeNull());
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    expect(document.activeElement?.closest("h3")).toBeNull();
  });

  // round 2 finding 1: the rule as the selected row comes back into the book — a holding kept in the
  // inspector through a failed valuation, its group folded meanwhile, the valuation recovered
  it("clears when the selected row comes back into the book inside a folded group", () => {
    const failed = { holdings: null, holdingsKept: HOLDINGS, holdingsError: "the valuation failed" };
    const { rerender } = render(<DeskBook {...props()} />);
    select("h-calls");
    rerender(<DeskBook {...props(failed)} />);
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    fireEvent.click(head("spreads", "2026-12-18"));
    // not drawn while the valuation has failed: nothing it holds is hidden yet
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    const pressed = document.activeElement;
    rerender(<DeskBook {...props()} />);
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    expect(pressed).not.toBeNull();
    expect(document.activeElement?.closest(".nx-expiry-toggle")).toBeNull();
  });

  // round 3 B, confirmed by the owner: within a held, folded group the inspector's link to the
  // condor's other spread lands on it — hidden too — and the hold ends as the inspector changes
  // subject, so the rule then clears it, moving no focus to a heading
  it("lands the condor link on the other hidden spread, then clears it once the hold ends", async () => {
    render(<DeskBook {...props({ writes })} />);
    select("h-calls");
    draft("1.55");
    fireEvent.click(head("spreads", "2026-12-18"));
    fireEvent.click(within(inspector()!).getByRole("button", { name: "condor with 1218_P6400 →" }));
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_P6400");
    await waitFor(() => expect(inspector()).toBeNull());
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
    expect(document.activeElement?.closest(".nx-expiry-toggle")).toBeNull();
  });

  // round 3: never because the selection itself changed. The palette selects a row in a folded group
  // BEFORE it opens the group (`unfold.ts`) — so a selection the page sets on a hidden row is the
  // page's own, and stays, after the desk has drawn it and whatever it watches has settled
  it("leaves a selection the page sets on a row folded away, as the palette's landing does", async () => {
    let set!: (s: DeskSelection) => void;
    function Page() {
      const [sel, setSel] = useState<DeskSelection>(NOTHING_SELECTED);
      set = setSel;
      return <DeskBook {...props()} selection={[sel, setSel]} />;
    }
    render(<Page />);
    fireEvent.click(head("spreads", "2026-12-18"));
    act(() => set({ id: "h-calls", open: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    expect(deskRow("h-calls").hasAttribute("data-selected")).toBe(true);
    expect(head("spreads", "2026-12-18").getAttribute("aria-expanded")).toBe("false");
  });

  // round 3 A: a rule on a holding, drawn apart while the valuation has failed and selected there,
  // moves under its holding into a folded group as the valuation recovers — the same selected row,
  // shown and then hidden
  it("clears when the selected rule moves into a folded group as a failed valuation recovers", () => {
    const quotes = [...QUOTES, ...UNDER];
    const failed = { quotes, holdings: null, holdingsKept: HOLDINGS, holdingsError: "the valuation failed" };
    const { rerender } = render(<DeskBook {...props(failed)} />);
    // drawn on its own while the holdings are not valued, in no folded group
    expect(deskRow("r-under-ringing").closest('[data-testid="unplaced"]')).not.toBeNull();
    select("r-under-ringing");
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300 r-under-ringing");
    rerender(<DeskBook {...props({ quotes })} />);
    expect(deskRow("r-under-ringing").closest("[hidden]")).not.toBeNull();
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
  });

  // round 2 finding 2: the rule's first run, as the desk is drawn — the page's selection on a row of
  // a group already folded (on the phone, or in another tab). Nothing was pressed: no focus moves
  it("clears, as the desk is drawn, a selection the page kept on a row of a folded group", () => {
    document.cookie = "ui_folded=spreads:20261218;path=/";
    let now: DeskSelection = { id: "h-calls", open: true };
    function Page() {
      const [sel, setSel] = useState<DeskSelection>(now);
      now = sel;
      return <DeskBook {...props()} selection={[sel, setSel]} />;
    }
    const before = document.activeElement;
    render(<Page />);
    expect(inspector()).toBeNull();
    expect(now).toEqual(NOTHING_SELECTED);
    expect(document.activeElement).toBe(before);
  });

  it("leaves the selection and the inspector alone when another group is folded, and opening selects nothing", () => {
    render(<DeskBook {...props()} />);
    select("h-calls");
    fireEvent.click(head("spreads", "2026-12-04"));
    fireEvent.click(head("contracts", "2026-12-18"));
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
    expect(deskRow("h-calls").hasAttribute("data-selected")).toBe(true);
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(inspector()).toBeNull();
    fireEvent.click(head("spreads", "2026-12-18"));
    expect(inspector()).toBeNull();
    expect(document.querySelector(".nxd-row[data-selected], .nxd-row[data-cursor]")).toBeNull();
  });
});

describe("on the desk, j and k", () => {
  it("walk past a folded group's rows", () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(head("spreads", "2026-12-18"));
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      fireEvent.keyDown(document.body, { key: "j" });
      seen.push(document.querySelector<HTMLElement>(".nxd-row[data-cursor]")!.dataset.ref!);
    }
    expect(seen).toEqual(["w-dec04", "h-ic", "w-dec31", "w-dec18-delta", "w-lone", "q-unknown", "q-unknown"]);
  });
});

describe("the cookie", () => {
  it("is written to outlive the tab, sorted, with no character that would quote it", () => {
    writeFolded(new Set(["spreads:20261218", "contracts:20261204"]));
    expect(cookie()).toBe("contracts:20261204.spreads:20261218");
  });

  it("reads and writes only a section and an eight-digit date, whatever was typed into it", () => {
    document.cookie = "ui_folded=%E0%A4%A.spreads:20261204.bogus.contracts:2026-12-31.Spreads:20261218.contracts:20261231x;path=/";
    expect([...readFolded()]).toEqual(["spreads:20261204"]);
    writeFolded(new Set(["spreads:20261204", "spreads:2026-12-18", "watchlist:20261218", "a;b"]));
    expect(cookie()).toBe("spreads:20261204");
  });
});

/** The page, through a Provider outage out of the session (review of #467): the holdings are valued
 *  from their closes and drawn, `/quotes` fails, and no watched group is drawn — so a press must not
 *  take the folds of the groups only the watchlist makes out of the cookie. */
describe("on the page, while /quotes fails", () => {
  for (const arrangement of ["desk", "phone"] as const) {
    it(`keeps the watchlist's folds at a press, on the ${arrangement}`, async () => {
      // a Saturday: out of the session
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-21T15:00:00Z") });
      document.cookie = `ui_arrangement=${arrangement};path=/`;
      document.cookie = "ui_folded=contracts:20261231.spreads:20261204;path=/";
      const health = { db: true, provider: { name: "moomoo", ok: false },
        monitor: { last_sweep_at: null, alarms: { label: "active", bad: false }, fetched_at: null },
        settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" } };
      window.fetch = ((url: string) => {
        const path = String(url).replace(/^.*\/api/, "");
        if (path === "/quotes") {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ detail: "OpenD login timed out" }) });
        }
        const body = path === "/monitors" ? MONITORS : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }) as unknown as typeof fetch;
      render(<Next />);
      await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
      expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe(arrangement);
      expect(document.querySelector('[data-section="contracts"]')).toBeNull();
      fireEvent.click(head("spreads", "2026-12-18"));
      expect([...readFolded()].sort()).toEqual(["contracts:20261231", "spreads:20261204", "spreads:20261218"]);
    });
  }
});

/** The desk's other two jumps to a row (the owner, 2026-11-21): the palette and the price map open
 *  a folded group as a banner does — written as a press on its heading — select the row and bring
 *  it into view once it is drawn. */
describe("on the desk, a jump to a row in a folded group", () => {
  const deskRow = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;

  it("from the palette opens the group, selects the row and brings it into view", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T17:00:00Z") });
    document.cookie = "ui_arrangement=desk;path=/";
    vi.stubGlobal("fetch", holdingService().fetch);
    const user = userEvent.setup();
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    fireEvent.click(head("spreads", "2026-12-31"));
    expect(head("spreads", "2026-12-31").getAttribute("aria-expanded")).toBe("false");
    const scrolled = scrolls();
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "1231_C7600");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(deskRow("w-dec31").hasAttribute("data-selected")).toBe(true));
    expect(head("spreads", "2026-12-31").getAttribute("aria-expanded")).toBe("true");
    expect(readFolded().has("spreads:20261231")).toBe(false);
    await waitFor(() => expect(scrolled.filter((s) => s.el === deskRow("w-dec31"))).toContainEqual({ el: deskRow("w-dec31"), hidden: false }));
    expect(scrolled.filter((s) => s.el === deskRow("w-dec31") && s.hidden)).toEqual([]);
  });

  it("from the price map opens the group, selects the row and brings it into view", async () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(head("spreads", "2026-12-31"));
    document.cookie = "ui_folded=spreads:20261231.contracts:20261218;path=/";
    const scrolled = scrolls();
    fireEvent.click(screen.getByRole("button", { name: "price map" }));
    const map = screen.getByRole("region", { name: "price map" });
    fireEvent.click(map.querySelector<SVGGElement>('[data-spread="w-dec31"]')!);
    expect(deskRow("w-dec31").hasAttribute("data-selected")).toBe(true);
    expect(head("spreads", "2026-12-31").getAttribute("aria-expanded")).toBe("true");
    expect([...readFolded()]).toEqual(["contracts:20261218"]);
    await waitFor(() => expect(scrolled.filter((s) => s.el === deskRow("w-dec31"))).toContainEqual({ el: deskRow("w-dec31"), hidden: false }));
    expect(scrolled.filter((s) => s.el === deskRow("w-dec31") && s.hidden)).toEqual([]);
    document.cookie = "ui_price_map=;path=/;max-age=0";
  });
});
