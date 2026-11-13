/** The desk's book, arrangement A (ADR 0023, #289): the terminal table, its inspector and REVIEW's
 *  columns, on the owner-shaped book both arrangements are held to (`testing/ownerBook.ts`).
 *  Behaviour only — what sits where, what each row says, what stays live. Layout (no sideways
 *  scroll, columns dropping as measured, the colours) is the browser suite's: `NextDesk.test.tsx`
 *  under `__browser__/`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { charsOf, COLUMNS, fitColumns, offerable, PRIORITY, type DeskRow } from "../next/desk/columns";
import { Next } from "../next/Next";
import { placeBook } from "../next/placement";
import { readHidden } from "../shared/prefs";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, volAnswer } from "../testing/ownerBook";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", ...over,
  };
}

const row = (id: string) => {
  const el = [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};
const cell = (id: string, key: string) => row(id).querySelector<HTMLElement>(`[data-col="${key}"]`);
const cellText = (id: string, key: string) => cell(id, key)?.querySelector(".nxd-v")?.textContent ?? null;
const order = () => [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].map((r) => r.dataset.ref);
const headers = () => [...document.querySelectorAll(".nxd-head [data-col]")].map((h) => h.getAttribute("data-col"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const n of ["ui_cols_combo", "ui_arrangement"]) document.cookie = `${n}=;path=/;max-age=0`;
});

describe("one table: holdings first, then the watchlist, each by expiry", () => {
  it("draws the holdings, then the watchlist, the earliest expiry first in each", () => {
    render(<DeskBook {...props()} />);
    expect(order()).toEqual([
      // holdings: the 12-18 condor as two spreads, calls first; then the 4-leg condor on 12-31
      "h-calls", "r-calls", "h-puts", "h-ic", "r-ic",
      // the watchlist: 12-04, then 12-18 with its short leg's delta under it, then 12-31
      "w-dec04", "w-dec18", "w-dec18-delta", "w-dec31", "w-lone",
      // the rule the service switched off, after the watchlist
      "q-unknown",
    ]);
    const holdings = screen.getByRole("region", { name: "Holdings" });
    const watchlist = screen.getByRole("region", { name: "Watchlist" });
    expect(holdings.compareDocumentPosition(watchlist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...holdings.querySelectorAll(".nxd-expiry h3")].map((h) => h.textContent))
      .toEqual(["261218 · 38 DTE", "261231 · 38 DTE"]);
    expect([...watchlist.querySelectorAll(".nxd-expiry h3")].map((h) => h.textContent?.slice(0, 6)))
      .toEqual(["261204", "261218", "261231"]);
  });

  it("joins a condor's two spreads with a bracket, and keeps a 4-leg holding one row", () => {
    render(<DeskBook {...props()} />);
    const bracket = row("h-calls").closest("[data-bracket]")!;
    expect(bracket.getAttribute("data-bracket")).toBe("condor");
    expect(bracket.contains(row("h-puts"))).toBe(true);
    // the 4-leg condor is bracketed with nothing, and is one row carrying all four legs
    expect(row("h-ic").closest("[data-bracket]")).toBeNull();
    expect(document.querySelectorAll('.nxd-row[data-ref="h-ic"]')).toHaveLength(1);
    expect(cellText("h-ic", "legs")).toBe("-C7400 +C7450 -P6300 +P6250");
    expect(document.querySelectorAll("[data-bracket]")).toHaveLength(1);
  });

  it("sits a short leg's delta rule under its spread, and a rule matching no spread alone", () => {
    render(<DeskBook {...props()} />);
    const spread = row("w-dec18").closest("li")!;
    expect(spread.contains(row("w-dec18-delta"))).toBe(true);
    expect(row("w-dec18-delta").dataset.nested).toBe("");
    // w-lone is a contract no watched spread holds: its own item, nested under nothing
    expect(row("w-lone").closest("li")!.querySelectorAll(".nxd-row")).toHaveLength(1);
    expect(row("w-lone").dataset.nested).toBeUndefined();
  });

  it("gives every rule its fill bar and its sentence", () => {
    render(<DeskBook {...props()} />);
    expect(cellText("w-dec18-delta", "alarm")).toBe("|delta| ≥ 0.2 — now -0.170, 0.030 away");
    const bar = cell("w-dec18", "alarm")!.querySelector<HTMLElement>("[data-fill]")!;
    expect(bar.dataset.fill).toBe("40");
  });
});

describe("what each row says", () => {
  it("gives a holding its Cost to close, P&L in the outcome colour, DTE and Manage-by", () => {
    const holdings: Holding[] = HOLDINGS.map((h) => h.id === "h-puts"
      ? { ...h, schedule: { dte_at_open: 45, on_pace: 1.5, pace_gap: -0.5, target: 1, stop: 4,
          target_dte: 11, manage_by_dte: 21, reached: null, manage_by_due: false } }
      : h);
    render(<DeskBook {...props({ holdings })} />);
    expect(cellText("h-calls", "value")).toBe("4.40");
    expect(cell("h-calls", "pnl")!.querySelector("[data-money]")!.getAttribute("data-outcome")).toBe("loss");
    expect(cellText("h-calls", "pnl")).toBe("-$240");
    expect(cellText("h-puts", "pnl")).toBe("+$100");
    expect(cell("h-puts", "pnl")!.querySelector("[data-money]")!.getAttribute("data-outcome")).toBe("gain");
    expect(cellText("h-puts", "dte")).toBe("38");
    expect(cellText("h-puts", "manage")).toBe("in 17d");
    // no schedule: no Manage-by to count to, said as a dash rather than a guess
    expect(cellText("h-calls", "manage")).toBe("—");
  });

  it("gives each holding its short leg's delta as the service serves it, with no rule on the leg", () => {
    // #318: each leg's own delta comes with the holding; the fixture has no rule on any held leg
    render(<DeskBook {...props()} />);
    expect(cellText("h-calls", "delta")).toBe("0.330");
    expect(cellText("h-puts", "delta")).toBe("-0.210");
    // a 4-leg holding: the larger of its two short legs, in size
    expect(cellText("h-ic", "delta")).toBe("-0.250");
  });

  it("prefers the served delta to a rule's on the same leg", () => {
    // both come from the Provider; the order #318 asks for is served first
    const leg: Entry = {
      ...QUOTES.find((q) => q.id === "w-dec18-delta")!, id: "r-leg", code: "US.SPXW261218C7300000",
      option_type: "CALL", held: true, scope: "leg", in_combos: [],
      positions: [{ id: "h-calls", name: "1218_C7300" }],
      quote: { name: "SPXW 261218 7300.00C", option_delta: 0.214 } as Entry["quote"], watched: 0.214,
    };
    render(<DeskBook {...props({ quotes: [...QUOTES, leg] })} />);
    expect(cellText("h-calls", "delta")).toBe("0.330");
  });

  it("falls back to the rule watching the leg where the service sent no deltas, then to a dash", () => {
    const leg: Entry = {
      ...QUOTES.find((q) => q.id === "w-dec18-delta")!, id: "r-leg", code: "US.SPXW261218C7300000",
      option_type: "CALL", held: true, scope: "leg", in_combos: [],
      positions: [{ id: "h-calls", name: "1218_C7300" }],
      quote: { name: "SPXW 261218 7300.00C", option_delta: 0.214 } as Entry["quote"], watched: 0.214,
    };
    const unserved = HOLDINGS.map((h) => ({ ...h, legs_delta: null }));
    render(<DeskBook {...props({ quotes: [...QUOTES, leg], holdings: unserved })} />);
    expect(cellText("h-calls", "delta")).toBe("0.214");
    // the position's own greeks are a signed sum over its legs, not the short leg's delta
    expect(cellText("h-puts", "delta")).toBe("—");
    // and the leg rule sits under its holding
    expect(row("h-calls").closest("li")!.contains(row("r-leg"))).toBe(true);
  });

  it("gives a 4-leg holding the larger of its two short legs' deltas, in size", () => {
    const leg = (id: string, code: string, type: string, d: number): Entry => ({
      ...QUOTES.find((q) => q.id === "w-lone")!, id, code, option_type: type, held: true, scope: "leg",
      in_combos: [], positions: [{ id: "h-ic", name: "1231_IC" }],
      quote: { name: id, option_delta: d } as Entry["quote"], watched: d,
    });
    const unserved = HOLDINGS.map((h) => ({ ...h, legs_delta: null }));
    render(<DeskBook {...props({ holdings: unserved, quotes: [...QUOTES,
      leg("r-c", "US.SPXW261231C7400000", "CALL", 0.12), leg("r-p", "US.SPXW261231P6300000", "PUT", -0.25)] })} />);
    expect(cellText("h-ic", "delta")).toBe("-0.250");
  });

  it("says a Level reached with a chip in the name cell, which never drops", () => {
    const holdings = HOLDINGS.map((h) => h.id === "h-calls"
      ? { ...h, schedule: { dte_at_open: 45, on_pace: 1.5, pace_gap: 2.9, target: 1, stop: 4,
          target_dte: 11, manage_by_dte: 21, reached: "stop" as const, manage_by_due: false } }
      : h);
    render(<DeskBook {...props({ holdings })} />);
    const chip = cell("h-calls", "name")!.querySelector(".nx-chip")!;
    expect(chip.getAttribute("data-kind")).toBe("stop");
    expect(chip.textContent).toBe("at stop");
  });

  it("hides the money and keeps the share captured when privacy is on", () => {
    render(<DeskBook {...props({ privacy: true })} />);
    for (const m of document.querySelectorAll("[data-money]")) expect(m.textContent).not.toMatch(/\d/);
    expect(cellText("h-puts", "captured")).toBe("50%");
  });
});

describe("how a rule looks in each state", () => {
  it("styles a fired entry signal as an opportunity, a fired risk rule as an alarm", () => {
    render(<DeskBook {...props()} />);
    expect(row("w-dec04").dataset.state).toBe("entry");
    expect(row("w-dec04").querySelector(".nx-chip")!.getAttribute("data-attention")).toBe("entry");
    expect(row("r-calls").dataset.state).toBe("alarm");
    expect(row("r-calls").querySelector(".nx-chip")!.getAttribute("data-attention")).toBe("alarm");
    // calm rows carry no chip at all
    expect(row("w-dec18").dataset.state).toBe("calm");
    expect(row("w-dec18").querySelector(".nx-chip")).toBeNull();
  });

  it("carries the fault chip, and why, on a quarantined rule", () => {
    render(<DeskBook {...props()} />);
    expect(row("q-unknown").dataset.state).toBe("fault");
    expect(row("q-unknown").querySelector(".nx-chip")!.getAttribute("data-attention")).toBe("fault");
    expect(cellText("q-unknown", "alarm")).toBe("|delta| ≥ 0.1 — the provider does not know its contract");
  });

  it("keeps muted and expired rules in a collapsed group, apart from the quarantined", () => {
    render(<DeskBook {...props()} />);
    const group = screen.getByText(/muted and expired/i).closest("details")!;
    expect(group.open).toBe(false);
    const names = [...group.querySelectorAll("li")].map((li) => li.textContent);
    expect(names).toHaveLength(2);
    expect(names.join(" ")).toContain("Muted by you");
    expect(names.join(" ")).toContain("Expired");
    expect(group.textContent).not.toContain("261211");
  });

  it("changes only the fired entry row when entries are set to look like risk", () => {
    const states = () => Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].map((r) => [r.dataset.ref, r.outerHTML]));
    render(<DeskBook {...props()} />);
    const before = states();
    cleanup();
    render(<DeskBook {...props({ entryStyle: "risk" })} />);
    const after = states();
    // the markup is the same: the colour is the page's `data-entry`, which next.css answers, and
    // the browser suite measures; here, nothing in the rows themselves may differ
    expect(after).toEqual(before);
  });
});

describe("the inspector", () => {
  it("opens beside the table on selecting a row, with its legs, figures and Monitors", () => {
    render(<DeskBook {...props()} />);
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_C7300" });
    expect(within(insp).getByRole("heading", { name: "1218_C7300" })).toBeTruthy();
    expect(insp.textContent).toContain("short CALL 7300");
    expect(insp.textContent).toContain("long CALL 7350");
    expect(within(insp).getByText("cost to close").nextElementSibling!.textContent).toBe("4.40");
    // its Monitors, each with its sentence
    expect(insp.textContent).toContain("|spread value| ≥ 4 — now 4.40, past it by 0.40");
    // the condor's other spread is one step away
    fireEvent.click(within(insp).getByRole("button", { name: /condor with 1218_P6400/ }));
    expect(screen.getByRole("complementary", { name: "inspector: 1218_P6400" })).toBeTruthy();
    expect(row("h-puts").dataset.selected).toBe("");
  });

  it("is not modal: the table stays in the page, operable, and Escape or close shuts it", () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(row("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_P7150" });
    expect(insp.getAttribute("aria-modal")).toBeNull();
    expect(insp.closest("[data-poll]")).toBeNull();
    expect(insp.textContent).toContain("|delta| ≥ 0.2 — now -0.170, 0.030 away");
    // another row is still one click away
    fireEvent.click(within(row("w-dec31")).getByRole("button", { name: "1231_C7600" }));
    expect(screen.getByRole("complementary", { name: "inspector: 1231_C7600" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
    fireEvent.click(within(row("w-dec31")).getByRole("button", { name: "1231_C7600" }));
    fireEvent.click(screen.getByRole("button", { name: "close the inspector" }));
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
  });

  it("lists every figure, the ones the columns dropped or the viewer hid included", () => {
    document.cookie = "ui_cols_combo=pnl.legs;path=/";
    render(<DeskBook {...props()} />);
    expect(cell("h-calls", "pnl")).toBeNull();
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const insp = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(insp).getByText("P&L").nextElementSibling!.textContent).toBe("-$240");
  });

  it("closes when its row leaves the book", () => {
    const { rerender } = render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    rerender(<DeskBook {...props({ holdings: HOLDINGS.filter((h) => h.id !== "h-calls") })} />);
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
  });

  it("stays shut when the row comes back, as after one failed valuation", () => {
    const { rerender } = render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    rerender(<DeskBook {...props({ holdings: null, holdingsError: "/positions/values → 502" })} />);
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
    rerender(<DeskBook {...props()} />);
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
  });

  it("leaves an Escape that closes the column picker to the picker", async () => {
    render(<DeskBook {...props()} />);
    await userEvent.click(within(row("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    await userEvent.click(screen.getByRole("button", { name: "book columns" }));
    await screen.findByRole("group", { name: "book columns" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "book columns" })).toBeNull());
    expect(screen.getByRole("complementary", { name: "inspector: 1218_P7150" })).toBeTruthy();
    // and the next Escape, from the table, is the inspector's
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: /inspector/ })).toBeNull();
  });

  it("leaves an Escape inside a dialog drawn outside the desk, as Settings is, to that dialog", async () => {
    render(<><DeskBook {...props()} /><div role="dialog" aria-label="Settings"><input aria-label="code" /></div></>);
    await userEvent.click(within(row("w-dec18")).getByRole("button", { name: "1218_P7150" }));
    await userEvent.click(screen.getByLabelText("code"));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "inspector: 1218_P7150" })).toBeTruthy();
  });

  it("takes the focus when it opens and gives it back to the row when it closes", async () => {
    render(<DeskBook {...props()} />);
    const name = within(row("h-calls")).getByRole("button", { name: "1218_C7300" });
    expect(name.getAttribute("aria-controls")).toBeNull();
    await userEvent.click(name);
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_C7300" });
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(name.getAttribute("aria-controls")).toBe(insp.id);
    expect(insp.contains(document.activeElement)).toBe(true);
    await userEvent.click(within(insp).getByRole("button", { name: "close the inspector" }));
    expect(document.activeElement).toBe(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    // and by Escape
    await userEvent.click(within(row("w-dec31")).getByRole("button", { name: "1231_C7600" }));
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(within(row("w-dec31")).getByRole("button", { name: "1231_C7600" }));
  });

  it("puts no ARIA state on a row that has no role to carry it", () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    for (const r of document.querySelectorAll(".nxd-row")) {
      if (!r.getAttribute("role")) expect(r.getAttribute("aria-selected")).toBeNull();
    }
  });

  it("says how many contracts, and hides the count under privacy, which would give the size away", () => {
    render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-ic")).getByRole("button", { name: "1231_IC" }));
    let insp = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(insp).getByText("contracts").nextElementSibling!.textContent).toBe("×2");
    cleanup();
    render(<DeskBook {...props({ privacy: true })} />);
    fireEvent.click(within(row("h-ic")).getByRole("button", { name: "1231_IC" }));
    insp = screen.getByRole("complementary", { name: /inspector/ });
    expect(within(insp).getByText("contracts").nextElementSibling!.textContent).not.toMatch(/\d/);
    expect(document.querySelector(".nxd")!.textContent).not.toMatch(/×\d/);
  });
});

describe("with the inspector open, the table stays live", () => {
  it("updates a figure in the table, and in the inspector, when new figures arrive", () => {
    const { rerender } = render(<DeskBook {...props()} />);
    fireEvent.click(within(row("h-ic")).getByRole("button", { name: "1231_IC" }));
    const moved = HOLDINGS.map((h) => h.id === "h-calls" ? { ...h, cost_to_close: 5.1, pnl: -310 } : h);
    rerender(<DeskBook {...props({ holdings: moved })} />);
    expect(screen.getByRole("complementary", { name: "inspector: 1231_IC" })).toBeTruthy();
    expect(cellText("h-calls", "value")).toBe("5.10");
    expect(cellText("h-calls", "pnl")).toBe("-$310");
  });

  it("on the page's own poll, in LIVE", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    // a Monday in the session, so the clock picks LIVE; only the clock and the interval are faked
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date("2026-11-09T15:00:00Z") });
    let holdings: Holding[] = HOLDINGS;
    const health = {
      db: true, provider: { name: "moomoo", ok: true },
      monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
      settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
    };
    window.fetch = ((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
        : path === "/health" ? health : path === "/positions/values" ? holdings
          : payoffAnswer(path) ?? volAnswer(path) ?? [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch;
    render(<Next />);
    await waitFor(() => expect(cellText("h-calls", "value")).toBe("4.40"));
    fireEvent.click(within(row("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_C7300" });

    holdings = HOLDINGS.map((h) => h.id === "h-calls" ? { ...h, cost_to_close: 5.1 } : h);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(cellText("h-calls", "value")).toBe("5.10"));
    expect(insp.isConnected).toBe(true);
    expect(within(insp).getByText("cost to close").nextElementSibling!.textContent).toBe("5.10");
  });
});

describe("REVIEW", () => {
  const scheduled: Holding[] = HOLDINGS.map((h) => ({
    ...h, schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4,
      target_dte: 11, manage_by_dte: 21, reached: null, manage_by_due: false },
  }));

  it("swaps the columns to P&L, captured, pace and DTE to Manage-by", () => {
    render(<DeskBook {...props({ mode: "review", holdings: scheduled })} />);
    expect(headers()).toEqual(["name", "legs", "pnl", "captured", "on_pace", "pace_gap", "to_manage", "alarm"]);
  });

  it("says only what the service served: the schedule's own on-pace and pace gap, or a dash", () => {
    const mixed = scheduled.map((h) => h.id === "h-ic" ? { ...h, schedule: null } : h);
    render(<DeskBook {...props({ mode: "review", holdings: mixed })} />);
    expect(cellText("h-calls", "on_pace")).toBe("1.23");
    expect(cellText("h-calls", "pace_gap")).toBe("behind by 0.47");
    expect(cellText("h-calls", "captured")).toBe("50%");
    expect(cellText("h-calls", "to_manage")).toBe("38 → 21");
    // no Opened, no schedule: nothing is drawn in its place
    expect(cellText("h-ic", "on_pace")).toBe("—");
    expect(cellText("h-ic", "pace_gap")).toBe("—");
    expect(cellText("h-ic", "to_manage")).toBe("—");
    expect(cell("h-calls", "value")).toBeNull();
  });

  it("says when the holdings were valued, outside the session, where nothing re-values them", () => {
    render(<DeskBook {...props({ mode: "review", holdingsAt: "23:14:05" })} />);
    expect(screen.getByText("market closed — valued at 23:14")).toBeTruthy();
  });

  it("says it by the session, whichever mode: in Live outside it, and not in Review in it (#371)", () => {
    render(<DeskBook {...props({ mode: "live", session: false, holdingsAt: "23:14:05" })} />);
    expect(screen.getByText("market closed — valued at 23:14")).toBeTruthy();
    cleanup();
    render(<DeskBook {...props({ mode: "review", session: true, holdingsAt: "23:14:05" })} />);
    expect(document.querySelector(".nx-mkt-closed")).toBeNull();
  });
});

describe("the columns", () => {
  it("carry over today's column choice", () => {
    document.cookie = "ui_cols_combo=pnl.legs.delta;path=/";
    render(<DeskBook {...props()} />);
    expect(headers()).toEqual(["name", "value", "captured", "strip", "dte", "manage", "alarm"]);
  });

  it("stop at the first that does not fit, rather than skipping to a narrower one (ADR 0008)", () => {
    // P&L is too wide for what is left; delta, after it, would fit on its own
    const widths: Record<string, number> = { name: 100, value: 50, pnl: 400, delta: 40, dte: 30 };
    const widthOf = (k: string) => widths[k] ?? 60;
    expect(fitColumns("live", 300, new Set(), widthOf).map((c) => c.key)).toEqual(["name", "value"]);
    // hiding P&L is how room is made for what follows it, and the picker offers exactly that
    expect(fitColumns("live", 300, new Set(["pnl"]), widthOf).map((c) => c.key))
      .toEqual(["name", "value", "delta", "dte", "manage"]);
    // the picker offers what ticking would draw: nothing behind P&L until P&L is hidden
    expect(offerable("live", 300, new Set(), widthOf).has("delta")).toBe(false);
    expect(offerable("live", 300, new Set(["pnl"]), widthOf).has("delta")).toBe(true);
  });

  it("are dropped widest last (ADR 0008)", () => {
    const placed = placeBook(QUOTES, HOLDINGS, MONITORS);
    const rows: DeskRow[] = [
      ...placed.holdings.flatMap((g) => g.rows.flat().flatMap((p) => [
        { kind: "holding" as const, holding: p.holding, rules: p.rules },
        ...p.rules.map((entry) => ({ kind: "rule" as const, entry, nested: true })),
      ])),
      ...placed.watchlist.flatMap((g) => g.items.flatMap((i) => [
        { kind: "rule" as const, entry: i.entry, nested: false },
        ...i.under.map((entry) => ({ kind: "rule" as const, entry, nested: true })),
      ])),
      ...placed.quarantined.map((monitor: Monitor) => ({ kind: "quarantined" as const, monitor })),
    ];
    for (const mode of ["live", "review"] as const) {
      const width = (key: string) => charsOf(COLUMNS[mode].find((c) => c.key === key)!, rows, false, mode === "live");
      const order = PRIORITY[mode];
      expect(Math.max(...order.map(width))).toBe(width(order[order.length - 1]!));
      // and every column but the pinned name is in the order exactly once
      expect([...order].sort()).toEqual(COLUMNS[mode].map((c) => c.key).filter((k) => k !== "name").sort());
    }
  });
});

describe("the column choice is shared with /opt, and only the desk's part of it is changed", () => {
  it("puts back only the columns the desk offers on show all", async () => {
    document.cookie = "ui_cols_combo=expiry.gamma.pnl.theta.vega;path=/";
    render(<DeskBook {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "book columns" }));
    const picker = await screen.findByRole("group", { name: "book columns" });
    await userEvent.click(within(picker).getByText("show all"));
    expect([...readHidden()].sort()).toEqual(["expiry", "gamma", "theta", "vega"]);
    expect(headers()).toContain("pnl");
  });

  it("keeps a choice another tab made since this one read the cookie", async () => {
    document.cookie = "ui_cols_combo=pnl;path=/";
    render(<DeskBook {...props()} />);
    document.cookie = "ui_cols_combo=gamma.pnl;path=/";
    await userEvent.click(screen.getByRole("button", { name: "book columns" }));
    const picker = await screen.findByRole("group", { name: "book columns" });
    await userEvent.click(within(picker).getByRole("checkbox", { name: "Δ" }));
    expect([...readHidden()].sort()).toEqual(["delta", "gamma", "pnl"]);
  });
});

describe("what the holdings section says when there are no figures", () => {
  it("says the valuation failed instead of figures, and keeps the rules on held contracts", () => {
    render(<DeskBook {...props({ holdings: null, holdingsError: "/positions/values → 502" })} />);
    expect(screen.getByText("the holdings could not be valued — /positions/values → 502")).toBeTruthy();
    const unplaced = screen.getByTestId("unplaced");
    expect(unplaced.querySelector('[data-ref="r-calls"]')).toBeTruthy();
    expect(unplaced.querySelector('[data-ref="r-ic"]')).toBeTruthy();
  });

  it("says it is valuing, and that nothing is held", () => {
    render(<DeskBook {...props({ holdings: null })} />);
    expect(screen.getByText("valuing…")).toBeTruthy();
    cleanup();
    render(<DeskBook {...props({ holdings: [] })} />);
    expect(screen.getByText("nothing held")).toBeTruthy();
  });
});

describe("a combo that only partly overlaps a holding (#346)", () => {
  const overlap = (over: Partial<BookProps> = {}) =>
    props({ quotes: OVERLAP_QUOTES, holdings: OVERLAP_HOLDINGS, monitors: OVERLAP_MONITORS, ...over });
  const note = (id: string) =>
    row(id).closest("li")!.querySelector<HTMLElement>("[data-overlap]")?.textContent ?? null;

  it("is drawn in the watchlist with its note, and the holding keeps its own rules", () => {
    render(<DeskBook {...overlap()} />);
    expect(order()).toEqual([
      "h-8050", "r-8050", "r-8050-delta", "h-7700", "r-7700", "h-ic", "r-ic-calls", "h-7200",
      "r-8100", "w-8150-delta", "w-7700", "r-ratio",
    ]);
    const watchlist = screen.getByRole("region", { name: "Watchlist" });
    const holdings = screen.getByRole("region", { name: "Holdings" });
    // each names a contract its holding does not hold: C8150, C7750, a second C7250
    for (const id of ["r-8100", "w-7700", "r-ratio"]) expect(watchlist.contains(row(id))).toBe(true);
    // the holding's own value rule, a single contract on its leg, and a wing of a held condor
    for (const id of ["r-8050", "r-8050-delta", "r-ic-calls"]) expect(holdings.contains(row(id))).toBe(true);
    expect(note("r-8100")).toBe("shares C8100 with 1231_8050");
    expect(note("w-7700")).toBe("contains 1231_7700's C7700");
    expect(note("r-ratio")).toBe("contains 1231_7200's C7200 and C7250");
    // and no note on a rule that is drawn where it always was
    expect(note("r-8050")).toBeNull();
    expect(note("r-ic-calls")).toBeNull();
    expect(row("r-8100").dataset.nested).toBeUndefined();
  });

  it("gives its own value, as every watched spread's, not the cost to close of the shared leg", () => {
    render(<DeskBook {...overlap()} />);
    expect(cellText("r-8100", "value")).toBe("-0.60");
    expect(cellText("w-7700", "value")).toBe("-1.50");
    // a ratio IS served a cost to close (its contracts counted once each): drawn as a watched
    // spread, it shows its own value instead
    expect(cellText("r-ratio", "value")).toBe("-0.40");
    // the holding's own value rule still reads its holding's cost to close, and a wing of a held
    // condor its own two contracts' cost to close, not its signed value
    expect(cellText("r-8050", "value")).toBe("1.20");
    expect(cellText("r-ic-calls", "value")).toBe("1.30");
  });

  it("says it in the inspector too, and the note survives privacy, having no $ and no count in it", () => {
    render(<DeskBook {...overlap({ privacy: true })} />);
    expect(note("r-8100")).toBe("shares C8100 with 1231_8050");
    fireEvent.click(within(row("r-8100")).getByRole("button", { name: "1231_8100" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1231_8100" });
    expect(insp.querySelector("[data-overlap]")!.textContent).toBe("shares C8100 with 1231_8050");
  });

  it("is no longer among the holding's Monitors in its inspector", () => {
    render(<DeskBook {...overlap()} />);
    fireEvent.click(within(row("h-8050")).getByRole("button", { name: "1231_8050" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1231_8050" });
    const monitors = within(insp).getByRole("heading", { name: "Monitors" }).parentElement!;
    expect(monitors.querySelectorAll(".nxd-monitor")).toHaveLength(2);
    expect(monitors.textContent).not.toContain("now -0.60");
  });
});
