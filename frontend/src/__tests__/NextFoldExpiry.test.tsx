/** The book's expiry groups fold (the owner, 2026-11-21), on the desk and the phone alike.
 *
 *  1. Each expiry's heading inside Spreads and Contracts is a button that folds that group's rows;
 *     the sections themselves do not fold.
 *  2. A folded heading keeps its date and DTE and adds the group's row count and what in it needs
 *     the owner, in the chips' own words and colours. A group never reopens by itself when it rings.
 *  3. Remembered per browser in a cookie, keyed by section AND expiry, storing what is FOLDED: every
 *     group starts open; a write is made to the cookie as it stands now; a hand-edited cookie is read
 *     tolerantly; an expiry no longer in the book drops out of it when next written.
 *  4. The saved picture and "Copy as text" show every row whatever is folded
 *     (`NextSaveImage.test.tsx`, which drives the page's own presses).
 *  The geometry — a folded heading inside the screen at iPhone width — is the browser suite's
 *  (`__browser__/NextFoldExpiry*.test.tsx`).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { Next } from "../Next";
import { PhoneBook } from "../phone/PhoneBook";
import { reveal } from "../NeedsLine";
import { readFolded, writeFolded } from "../shared/prefs";
import { call, entry, HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const n of ["ui_folded", "ui_arrangement"]) document.cookie = `${n}=;path=/;max-age=0`;
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
const cookie = () => document.cookie.split("; ").find((c) => c.startsWith("ui_folded="))?.slice("ui_folded=".length) ?? null;

for (const [arrangement, draw, rows] of ARRANGEMENTS) {
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
      expect(head("spreads", "2026-12-04").textContent).toBe("20261204 · 38 DTE · 1 row · 1 entry signal");
      fireEvent.click(head("spreads", "2026-12-18"));
      // the put spread at its stop, the call spread's own rule ringing: by the needs-you line's order
      const b = head("spreads", "2026-12-18");
      expect(b.textContent).toBe("20261218 · 38 DTE · 3 rows · 1 at stop · 1 ringing");
      const chips = [...b.querySelectorAll<HTMLElement>(".nx-chip")];
      expect(chips.map((c) => c.dataset.kind ?? c.dataset.attention)).toEqual(["stop", "alarm"]);
      for (const c of chips) expect(c.querySelector("svg"), "each carries its kind's glyph").toBeTruthy();
      // a quiet group says its count alone
      fireEvent.click(head("contracts", "2026-12-31"));
      expect(head("contracts", "2026-12-31").textContent).toBe("20261231 · 38 DTE · 1 row");
    });

    it("counts the rules drawn under a holding: their rows and their chips", () => {
      draw(props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP }));
      // both under the call spread on the desk's rows, and on its card on the phone
      const drawnUnder = arrangement === "desk"
        ? UNDER.map((e) => document.querySelector(`.nxd-row[data-ref="${e.id}"]`)!.hasAttribute("data-nested"))
        : UNDER.map((e) => document.querySelector(`article[data-ref="h-calls"] [data-ref="${e.id}"]`) !== null);
      expect(drawnUnder).toEqual([true, true]);
      fireEvent.click(head("spreads", "2026-12-18"));
      // the call spread, its two rules, the put spread, the watched spread; its own rule and the
      // one under it ringing, the other under it at fault, the put spread at its stop
      expect(head("spreads", "2026-12-18").textContent).toBe("20261218 · 38 DTE · 5 rows · 1 fault · 1 at stop · 2 ringing");
    });

    it("counts each kind, and says a count of more than one in the plural", () => {
      const twice = QUOTES.map((q) => q.id === "w-dec31" ? { ...q, triggered: true } : q);
      const ic = AT_STOP.map((h) => h.id === "h-ic" ? { ...h, schedule: { ...AT_STOP[0]!.schedule!, reached: "stop" } } as Holding : h);
      draw(props({ quotes: twice.map((q) => q.id === "r-ic" ? { ...q, error: "no figure" } : q), holdings: ic }));
      fireEvent.click(head("spreads", "2026-12-31"));
      // the 4-leg condor at its stop with its own rule at fault; the watched call spread an entry signal
      expect(head("spreads", "2026-12-31").textContent).toBe("20261231 · 38 DTE · 2 rows · 1 fault · 1 at stop · 1 entry signal");
      cleanup();
      const two = [...QUOTES, { ...QUOTES.find((q) => q.id === "w-dec04")!, id: "w-dec04b", code: "1204_P6800" }];
      draw(props({ quotes: two }));
      fireEvent.click(head("spreads", "2026-12-04"));
      expect(head("spreads", "2026-12-04").textContent).toBe("20261204 · 38 DTE · 2 rows · 2 entry signals");
    });

    it("stays folded when a rule in it fires, and says so on its heading", () => {
      const { rerender } = draw(props());
      fireEvent.click(head("contracts", "2026-12-31"));
      const ringing = QUOTES.map((q) => q.id === "w-lone" ? { ...q, triggered: true } : q);
      rerender(arrangement === "desk" ? <DeskBook {...props({ quotes: ringing })} /> : <PhoneBook {...props({ quotes: ringing })} />);
      const b = head("contracts", "2026-12-31");
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(body(b).hidden).toBe(true);
      expect(b.textContent).toBe("20261231 · 38 DTE · 1 row · 1 entry signal");
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

    it("leads a needs-you banner about a folded row to its group's heading, and leaves it folded", () => {
      draw(props());
      fireEvent.click(head("spreads", "2026-12-04"));
      reveal("w-dec04");
      const b = head("spreads", "2026-12-04");
      expect(b.hasAttribute("data-revealed")).toBe(true);
      expect(b.getAttribute("aria-expanded")).toBe("false");
    });
  });
}

describe("the same words on the desk and the phone", () => {
  it("for every group, folded", () => {
    document.cookie = "ui_folded=spreads:20261204.spreads:20261218.spreads:20261231.contracts:20261218.contracts:20261231;path=/";
    const said = () => [...document.querySelectorAll("[data-section] [data-expiry] h3 button")].map((b) => b.textContent);
    render(<DeskBook {...props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP })} />);
    const desk = said();
    cleanup();
    render(<PhoneBook {...props({ quotes: [...QUOTES, ...UNDER], holdings: AT_STOP })} />);
    expect(said()).toEqual(desk);
    expect(desk).toEqual([
      "20261204 · 38 DTE · 1 row · 1 entry signal",
      "20261218 · 38 DTE · 5 rows · 1 fault · 1 at stop · 2 ringing",
      "20261231 · 38 DTE · 2 rows",
      "20261218 · 38 DTE · 1 row",
      "20261231 · 38 DTE · 1 row",
    ]);
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
