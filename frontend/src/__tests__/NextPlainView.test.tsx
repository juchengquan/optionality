/** The saved view as one plain table (#394): what `plainView` says of a book, the picture it draws
 *  (`Still.tsx`) and the Markdown "Copy as text" writes from it (`toMarkdown`), held to each other.
 *  How the picture LOOKS — a light ground, no chip, no bar, nothing clipped, the same from the
 *  desk and the phone — is the browser suite's (`__browser__/NextSnapshot*.test.tsx`).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Health, Holding, Reference } from "../shared/api";
import { Still } from "../snapshot/Still";
import { plainView, takenWords, toMarkdown, type PlainInput } from "../snapshot/plain";
import { needsYou, type Need } from "../needs";
import { entry, holding, HOLDINGS, monitor, MONITORS, QUOTES, side } from "../testing/ownerBook";
import { readMarkdown, readPicture } from "../testing/plainRead";

afterEach(cleanup);

/** Monday 16 Nov 2026, 10:00 New York: in session. */
const MONDAY = new Date("2026-11-16T15:00:00Z");
/** Sunday 15 Nov, 12:00 New York: outside it. */
const SUNDAY = new Date("2026-11-15T17:00:00Z");

const HEALTH = {
  db: true, golden_cases: "x", provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-16 23:00:05+08:00", last_sweep_ok: true, consecutive_failures: 0,
    alarms: { label: "active", bad: false }, fetched_at: "2026-11-16 23:00:05+08:00" },
  settings: { manage_by_dte: 21, sweep_seconds: 15, expired_retention_days: 7, display_tz: "Asia/Singapore" },
} as Health;

const SPX_REF = {
  id: "ref1", code: "US..SPX", label: "S&P 500", source: "moomoo", figure: 7612.25, change: 0.0042,
  field: "mid_price", name: "S&P 500", error: null, last_known: false, delayed: null, delayed_by_minutes: null,
  fetched_at: "2026-11-16 00:59:05+08:00",
} as unknown as Reference;

function input(over: Partial<PlainInput> = {}): PlainInput {
  const holdings = over.holdings === undefined ? HOLDINGS : over.holdings;
  const quotes = over.quotes ?? QUOTES;
  const monitors = over.monitors ?? MONITORS;
  return {
    quotes, monitors, holdings, holdingsError: null, holdingsAt: "23:00:05", holdingsServed: null,
    session: true, privacy: false, needs: needsYou(quotes, monitors, HEALTH, holdings), health: HEALTH,
    polledAt: "23:00:09", error: null, references: [SPX_REF], hidden: new Set(), takenAt: MONDAY, ...over,
  };
}

/** The view's rows of a section, by what each row names. */
function rowsOf(view: ReturnType<typeof plainView>, title: string): string[][] {
  return view.sections.find((s) => s.title === title)!.groups.flatMap((g) => g.rows);
}
/** A row's cell under a column, by the column's label. */
function cell(view: ReturnType<typeof plainView>, name: string, column: string): string {
  const row = view.sections.flatMap((s) => s.groups.flatMap((g) => g.rows)).find((r) => r[1] === name || r[1]!.startsWith(`${name} (`));
  expect(row, `no row for ${name}`).toBeTruthy();
  return row![view.columns.indexOf(column)]!;
}

describe("the table", () => {
  it("carries every column the viewer ticked, labelled with its unit, between what the row is and its status", () => {
    const view = plainView(input());
    expect(view.columns).toEqual([
      "what", "name", "legs", "value (pts; a holding's cost to close)", "P&L ($)", "captured (%)", "pace gap (pts)",
      "delta (a holding's short leg)", "SPX to the nearest short strike", "DTE (days)", "manage-by", "rule", "status",
    ]);
    const without = plainView(input({ hidden: new Set(["captured", "strip"]) }));
    expect(without.columns).not.toContain("captured (%)");
    expect(without.columns).not.toContain("SPX to the nearest short strike");
    // the name is pinned, as on the desk: a cookie that hides it hides nothing
    expect(plainView(input({ hidden: new Set(["name"]) })).columns).toContain("name");
  });

  it("puts the holdings first, then the watchlist, then the muted and expired, each by expiry", () => {
    const view = plainView(input());
    expect(view.sections.map((s) => s.title)).toEqual(["Holdings", "Watchlist", "Muted and expired"]);
    expect(view.sections[0]!.groups.map((g) => g.heading)).toEqual(["261218 · 38 DTE", "261231 · 38 DTE"]);
    expect(view.sections[1]!.groups.map((g) => g.heading)).toEqual([
      "261204 · 38 DTE", "261218 · 38 DTE", "261231 · 38 DTE", "quarantined — switched off by the service",
    ]);
    // what each row is, in words: the indent and the condor's bracket are gone
    expect(rowsOf(view, "Holdings").map((r) => `${r[0]}: ${r[1]}`)).toEqual([
      "holding, a condor with 1218_P6400: 1218_C7300", "rule on 1218_C7300: 1218_C7300",
      "holding, a condor with 1218_C7300: 1218_P6400",
      "holding: 1231_IC", "rule on 1231_IC: 1231_IC",
    ]);
    expect(rowsOf(view, "Watchlist").map((r) => `${r[0]}: ${r[1]}`)).toEqual([
      "watched spread: 1204_P6900", "watched spread: 1218_P7150", "rule on a leg of 1218_P7150: 261218 7150P",
      "watched spread: 1231_C7600", "watched contract: 261231 8000C", "quarantined rule: 261211 8000C",
    ]);
  });

  it("says each rule in its full sentence, never the screen's short form", () => {
    const view = plainView(input());
    expect(cell(view, "1218_C7300", "rule")).toBe("");
    expect(cell(view, "261218 7150P", "rule")).toBe("|delta| ≥ 0.2 — now -0.170, 0.030 away");
    expect(cell(view, "1204_P6900", "rule")).toBe("|spread value| ≥ 6 — now 6.20, past it by 0.20");
    const rules = rowsOf(view, "Watchlist").map((r) => r[view.columns.indexOf("rule")]!).join(" ");
    // #388's symbols are the screen's: no Δ for a delta, no `val`, no arrows
    expect(rules).not.toMatch(/Δ|\bval\b|[↑↓▲▼]/);
  });

  it("says the pace gap in words, and the distance to the nearest short strike with its strike", () => {
    const behind = holding("h-b", { name: "1218_P6000", strike_date: "2026-12-18",
      legs: [side("short", "PUT", 6000), side("long", "PUT", 5950)],
      schedule: { on_pace: 1, pace_gap: 0.4, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21, reached: null,
        manage_by_due: false, dte_at_open: 45 } as Holding["schedule"] });
    const view = plainView(input({ holdings: [...HOLDINGS, behind] }));
    expect(cell(view, "1218_P6000", "pace gap (pts)")).toBe("behind by 0.40");
    expect(cell(view, "1218_P6400", "SPX to the nearest short strike")).toBe("P6400 500.50 pts · 1.25σ away");
    expect(cell(view, "1218_C7300", "legs")).toBe("-C7300 +C7350");
  });

  it("names, for a combo drawn apart from the holding it partly overlaps, what it shares (#346)", () => {
    const partly = entry("w-part", { code: "1218_C7300x", strike_date: "2026-12-18", held: true,
      legs: [{ sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7400 }] as never,
      positions: [{ id: "h-calls", name: "1218_C7300" }] });
    const view = plainView(input({ quotes: [...QUOTES, partly] }));
    const row = rowsOf(view, "Watchlist").find((r) => r[1]!.startsWith("1218_C7300x"))!;
    expect(row[1]).toBe("1218_C7300x (shares C7300 with 1218_C7300)");
  });
});

describe("the status column says in words what the screen says by colour or chip", () => {
  const sched = (over: Partial<NonNullable<Holding["schedule"]>>) => ({
    on_pace: 1, pace_gap: 0, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21, reached: null,
    manage_by_due: false, dte_at_open: 45, ...over,
  }) as Holding["schedule"];
  const legs = [side("short", "PUT", 6000), side("long", "PUT", 5950)];
  const held = (id: string, schedule: Holding["schedule"], over: Partial<Holding> = {}) =>
    holding(id, { name: id, strike_date: "2026-12-18", legs, schedule, fetched_at: "2026-11-15 23:04:15+08:00", ...over });

  it("for a holding at stop, at target, at its manage-by — and outside the session, which valuation", () => {
    const holdings = [
      held("at-stop", sched({ reached: "stop" })), held("at-target", sched({ reached: "target" })),
      held("due", sched({ manage_by_due: true })), held("calm", sched({})),
      held("closed-close", sched({ reached: "stop" }), { valued_from: "close", valued_timing: "close" } as Partial<Holding>),
    ];
    const live = plainView(input({ holdings, quotes: [], monitors: [] }));
    expect(["at-stop", "at-target", "due", "calm"].map((n) => cell(live, n, "status")))
      .toEqual(["at stop", "at target", "manage-by", ""]);
    const out = plainView(input({ holdings, quotes: [], monitors: [], session: false, takenAt: SUNDAY }));
    expect(cell(out, "at-stop", "status")).toBe("at stop · as valued at Sun 23:04");
    expect(cell(out, "closed-close", "status")).toBe("at stop · as of the close");
  });

  it("for a rule ringing, an entry signal, and a fault with its words", () => {
    const view = plainView(input({
      quotes: [...QUOTES, entry("w-err", { code: "1231_P6000", strike_date: "2026-12-31",
        legs: [{ sign: -1, option_type: "PUT", strike: 6000 }, { sign: 1, option_type: "PUT", strike: 5950 }] as never,
        error: "no quote for US.SPXW261231P6000000" } as Partial<Entry> & { strike_date: string })],
    }));
    // the ringing rule is the one under the held call spread
    const ringing = rowsOf(view, "Holdings").find((r) => r[0] === "rule on 1218_C7300")!;
    expect(ringing.at(-1)).toBe("ringing");
    expect(cell(view, "1204_P6900", "status")).toBe("entry signal");
    expect(cell(view, "1231_P6000", "status")).toBe("fault: no quote for US.SPXW261231P6000000");
    expect(cell(view, "1231_C7600", "status")).toBe("");
  });

  it("for every quarantine, by its reason", () => {
    const off = (id: string, reason: string) =>
      monitor(id, { code: id, strike: 8000 + id.length, enabled: false, disabled_reason: reason });
    const view = plainView(input({ quotes: [], monitors: [
      off("q1", "unknown-contract"), off("q22", "no-figure"), off("q333", "unreadable"),
    ] }));
    expect(rowsOf(view, "Watchlist").map((r) => r.at(-1))).toEqual([
      "quarantined: the provider does not know its contract", "quarantined: its figure never arrives",
      "quarantined: its stored row cannot be read",
    ]);
  });

  it("for a rule muted by hand, expired, off with its holding, or off for no recorded reason", () => {
    const off = (id: string, reason: string | null) =>
      monitor(id, { code: id, strike: 8000 + id.length, enabled: false, disabled_reason: reason });
    const view = plainView(input({ quotes: [], monitors: [
      off("m1", "manual"), off("m22", "expired"), off("m333", "holding-closed"), off("m4444", null),
    ] }));
    const muted = rowsOf(view, "Muted and expired");
    expect(muted.map((r) => r[0])).toEqual(["muted rule", "muted rule", "muted rule", "muted rule"]);
    expect(muted.map((r) => r.at(-1))).toEqual(["muted by you", "expired", "holding closed", "reason not recorded"]);
    // the rule in words, with no figure: nothing watches it
    expect(muted[0]![view.columns.indexOf("rule")]).toBe("|delta| ≥ 0.1");
  });
});

describe("the header block", () => {
  it("says when it was taken, in New York and in DISPLAY_TZ", () => {
    expect(takenWords(MONDAY, "Asia/Singapore")).toBe("Mon 16 Nov 2026 10:00 EST (New York) · Mon 16 Nov 2026 23:00 GMT+8 (Asia/Singapore)");
    // a service that has not said its zone, or says New York's, gives New York's alone
    expect(takenWords(MONDAY, null)).toBe("Mon 16 Nov 2026 10:00 EST (New York)");
    expect(takenWords(MONDAY, "America/New_York")).toBe("Mon 16 Nov 2026 10:00 EST (New York)");
  });

  it("in session: the session, the figures' freshness, the References without a time, every need named", () => {
    const needs = [
      ...input().needs,
      { kind: "manage", text: "1231_IC at its manage-by", ref: "h-ic" },
      { kind: "target", text: "1218_P6400 at target", ref: "h-puts" },
    ] as Need[];
    const view = plainView(input({ needs }));
    expect(view.lines.slice(0, 4)).toEqual([
      { label: "taken", text: "Mon 16 Nov 2026 10:00 EST (New York) · Mon 16 Nov 2026 23:00 GMT+8 (Asia/Singapore)" },
      { label: "session", text: "in session" },
      { label: "figures", text: "fetched at 2026-11-16 23:00:05+08:00 · 10:00:05 EST · screen updated 23:00:09 · service sweeps every 15s" },
      { label: "References", text: "S&P 500 (moomoo) 7,612.25 +0.42%" },
    ]);
    // every item named, in the line's order: a picture cannot be opened to read "+N more"
    expect(needs.length, "too few needs to show none is dropped").toBeGreaterThan(3);
    expect(view.lines[4]).toEqual({
      label: "needs you", text: `${needs.length} need you — ${needs.map((n) => n.text).join(" · ")}`,
    });
  });

  it("outside the session: the market-closed line's words, and each Reference with when it was read", () => {
    const view = plainView(input({ session: false, takenAt: SUNDAY, holdingsServed: "2026-11-15 23:00:05+08:00" }));
    expect(view.lines.find((l) => l.label === "session")!.text).toBe("market closed — valued at Sun 23:00");
    expect(view.lines.find((l) => l.label === "References")!.text).toBe("S&P 500 (moomoo) 7,612.25 +0.42% read at 00:59");
  });

  it("says nothing of needs when nothing needs you, as the page — and a warning when the figures may be stale", () => {
    const view = plainView(input({ needs: [], error: "the service could not be reached" }));
    expect(view.lines.map((l) => l.label)).not.toContain("needs you");
    expect(view.lines.find((l) => l.label === "warning")!.text).toBe("the service could not be reached");
  });
});

describe("the picture and the text, one builder", () => {
  for (const [name, over] of [
    ["in session", {}],
    ["outside the session", { session: false, takenAt: SUNDAY }],
    ["under privacy", { privacy: true }],
    ["with columns hidden", { hidden: new Set(["pnl", "alarm"]) }],
    ["with nothing valued", { holdings: null }],
    ["with nothing at all", { holdings: [], quotes: [], monitors: [], references: [], needs: [] }],
  ] as [string, Partial<PlainInput>][]) {
    it(`reads back to the same rows and cells, ${name}`, () => {
      const given = input(over);
      render(<Still {...given} />);
      const picture = readPicture(document.querySelector(".nx-still")!);
      const text = readMarkdown(toMarkdown(plainView(given)));
      expect(picture.sections.length, "nothing drawn — nothing compared").toBeGreaterThan(0);
      expect(text).toEqual(picture);
    });
  }

  it("escapes a pipe in a cell, which would otherwise end it: |delta| ≥ 0.2", () => {
    const md = toMarkdown(plainView(input()));
    expect(md).toContain("\\|delta\\| ≥ 0.2 — now -0.170, 0.030 away");
    const rows = readMarkdown(md).sections[1]!.rows;
    // every row as wide as the header: an unescaped pipe would add a cell
    for (const r of rows) expect(r).toHaveLength(rows[0]!.length);
  });

  it("writes the header block as lines above a Markdown table per section", () => {
    const md = toMarkdown(plainView(input()));
    expect(md.split("\n").slice(0, 3)).toEqual(["# optionality", "", "- taken: Mon 16 Nov 2026 10:00 EST (New York) · Mon 16 Nov 2026 23:00 GMT+8 (Asia/Singapore)"]);
    expect(md).toContain("\n## Holdings\n\n| what | name | legs |");
    expect(md).toContain("\n| 261218 · 38 DTE |  |  |");
  });
});

describe("privacy, in both", () => {
  const leaks = (s: string) => [/\$\s*[+-]?\d/, /[+-]\$\d/, /×\s*\d/].filter((p) => p.test(s)).map(String);

  it("hides every $ amount in the picture and the text, with the screen's words", () => {
    const given = input({ privacy: true });
    render(<Still {...given} />);
    const picture = document.querySelector(".nx-still")!.textContent!;
    const md = toMarkdown(plainView(given));
    for (const [what, s] of [["picture", picture], ["text", md]] as [string, string][]) {
      expect(s, `no P&L is drawn in the ${what}, so privacy proves nothing`).toContain("$•••");
      expect(leaks(s), `the ${what} says an amount`).toEqual([]);
    }
  });

  it("says the amounts with privacy off, which is what the test above hides", () => {
    const given = input();
    render(<Still {...given} />);
    expect(document.querySelector(".nx-still")!.textContent).toMatch(/[+-]\$\d/);
    expect(toMarkdown(plainView(given))).toMatch(/[+-]\$\d/);
  });
});

describe("nothing interactive, and nothing of the screen's drawing", () => {
  it("carries no control, no chip, no bar, no bracket and no coloured leg", () => {
    render(<Still {...input()} />);
    const root = document.querySelector(".nx-still")!;
    expect(root.querySelectorAll("button, input, select, a[href], [tabindex], [role=meter], [role=progressbar], svg")).toHaveLength(0);
    expect(root.querySelectorAll(".nx-chip, .nxd-fill, .nxp-progress, .nxd-bracket, .nx-leg, [data-type], [data-outcome]")).toHaveLength(0);
  });
});
