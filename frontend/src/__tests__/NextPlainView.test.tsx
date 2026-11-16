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
import { entry, holding, HOLDINGS, monitor, MONITORS, QUOTES, served, side } from "../testing/ownerBook";
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
/** A section by its title. */
const sectionOf = (view: ReturnType<typeof plainView>, title: string) => view.sections.find((s) => s.title === title)!;
/** A row's cell under a column, by the column's label in the row's own section. */
function cell(view: ReturnType<typeof plainView>, name: string, column: string): string {
  const s = view.sections.find((x) => x.groups.some((g) => g.rows.some((r) => r[0] === name)));
  expect(s, `no row for ${name}`).toBeTruthy();
  const row = s!.groups.flatMap((g) => g.rows).find((r) => r[0] === name)!;
  expect(s!.columns, `no column ${column} in ${s!.title}`).toContain(column);
  return row[s!.columns.indexOf(column)]!;
}

describe("the table", () => {
  it("carries every column the viewer ticked, under short headers, and no \"what\" or \"status\" (#400)", () => {
    const view = plainView(input());
    // a unit only where the cells do not say it: "+$177" and "38%" say theirs (2026-11-16)
    expect(sectionOf(view, "Holdings").columns).toEqual([
      "name", "legs", "value", "P&L", "captured", "pace gap (pts)", "Δ", "SPX→short", "DTE", "manage-by", "rule",
    ]);
    for (const s of view.sections) for (const g of s.groups) for (const r of g.rows) expect(r).toHaveLength(s.columns.length);
    const without = plainView(input({ hidden: new Set(["captured", "strip"]) }));
    expect(sectionOf(without, "Holdings").columns).not.toContain("captured");
    expect(sectionOf(without, "Holdings").columns).not.toContain("SPX→short");
    // the name is pinned, as on the desk: a cookie that hides it hides nothing
    expect(sectionOf(plainView(input({ hidden: new Set(["name"]) })), "Holdings").columns).toContain("name");
  });

  it("gives the watchlist and the muted rules no column only a holding fills (2026-11-16)", () => {
    const view = plainView(input());
    for (const title of ["Watchlist", "Muted and expired"]) {
      expect(sectionOf(view, title).columns).toEqual(["name", "legs", "value", "Δ", "SPX→short", "DTE", "rule"]);
    }
  });

  it("sets a figure's column to the right and words to the left, in the picture and the Markdown alike", () => {
    const view = plainView(input());
    const holdings = sectionOf(view, "Holdings");
    const right = holdings.columns.filter((_, i) => holdings.align[i] === "right");
    expect(right).toEqual(["value", "P&L", "captured", "Δ", "DTE", "manage-by"]);
    const md = toMarkdown(view);
    expect(md).toContain("| --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |");
    render(<Still {...input()} />);
    const pnl = [...document.querySelectorAll("section")][0]!.querySelector<HTMLElement>("tbody tr:not([data-group]) td:nth-child(4)")!;
    expect(pnl.dataset.align).toBe("right");
  });

  it("keeps the value and the pace gap apart, the gap ticked with the value it is drawn in on screen (2026-11-16)", () => {
    // hiding the value, the desk's one field, hides both here
    const noValue = sectionOf(plainView(input({ hidden: new Set(["value"]) })), "Holdings");
    expect(noValue.columns).not.toContain("value");
    expect(noValue.columns).not.toContain("pace gap (pts)");
    // a cookie from before, when the pace gap had a column of its own on screen, hides nothing
    expect(plainView(input({ hidden: new Set(["pace_gap"]) })).sections.map((s) => s.columns))
      .toEqual(plainView(input()).sections.map((s) => s.columns));
  });

  it("puts the holdings first, then the watchlist, then the muted and expired, each by expiry", () => {
    const view = plainView(input());
    expect(view.sections.map((s) => s.title)).toEqual(["Holdings", "Watchlist", "Muted and expired"]);
    expect(view.sections[0]!.groups.map((g) => g.heading)).toEqual(["261218 · 38 DTE", "261231 · 38 DTE"]);
    expect(view.sections[1]!.groups.map((g) => g.heading)).toEqual([
      "261204 · 38 DTE", "261218 · 38 DTE", "261231 · 38 DTE", "quarantined — switched off by the service",
    ]);
    // each row by its name alone, in the book's order
    expect(rowsOf(view, "Holdings").map((r) => r[0])).toEqual([
      "1218_C7300", "1218_C7300", "1218_P6400", "1231_IC", "1231_IC",
    ]);
    expect(rowsOf(view, "Watchlist").map((r) => r[0])).toEqual([
      "1204_P6900", "1218_P7150", "261218 7150P", "1231_C7600", "261231 8000C", "261211 8000C",
    ]);
  });

  it("says each rule in its full sentence, never the screen's short form", () => {
    const view = plainView(input());
    expect(cell(view, "1218_C7300", "rule")).toBe("");
    expect(cell(view, "261218 7150P", "rule")).toBe("|Δ| ≥ 0.20 — now −0.170, 0.030 away");
    expect(cell(view, "1204_P6900", "rule")).toBe("|value| ≥ 6.00 — now 6.20, past it by 0.20");
    const rules = rowsOf(view, "Watchlist").map((r) => r[sectionOf(view, "Watchlist").columns.indexOf("rule")]!).join(" ");
    // the short form's arrows are the screen's; the field's words are one vocabulary since #404 — Δ
    // for a delta, `value` for a price, never `val` — and its minus is the real one
    expect(rules).not.toMatch(/\bval\b|[↑↓▲▼]|-\d/);
    expect(rules).toMatch(/Δ/);
  });

  it("says the pace gap in words, and the nearest short strike's distance compactly: whole points, σ, signed past it", () => {
    const behind = holding("h-b", { name: "1218_P6000", strike_date: "2026-12-18",
      legs: [side("short", "PUT", 6000), side("long", "PUT", 5950)],
      schedule: { on_pace: 1, pace_gap: 0.4, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21, reached: null,
        manage_by_due: false, dte_at_open: 45 } as Holding["schedule"] });
    // SPX at 6900.50 is 100.50 points PAST a short call at 6800
    const past = holding("h-past", { name: "1218_C6800", strike_date: "2026-12-18",
      legs: [side("short", "CALL", 6800), side("long", "CALL", 6850)],
      short_strikes: [served("2026-12-18", "CALL", 6800, 0.62, 38)] });
    const view = plainView(input({ holdings: [...HOLDINGS, behind, past] }));
    expect(cell(view, "1218_P6000", "pace gap (pts)")).toBe("behind by 0.40");
    // the value and the gap apart, for analysis, where the screen draws them in one field (2026-11-16)
    expect(cell(view, "1218_P6000", "value")).toBe("1.00");
    // 500.50 points away: whole points, no "pts" and no "away"
    expect(cell(view, "1218_P6400", "SPX→short")).toBe("P6400 501 · 1.25σ");
    expect(cell(view, "1218_C6800", "SPX→short")).toBe("C6800 −101 · −0.25σ");
    expect(cell(view, "1218_C7300", "legs")).toBe("−C7300 +C7350");
  });

  it("names a combo drawn apart from the holding it partly overlaps by its name alone, no note (#400)", () => {
    const partly = entry("w-part", { code: "1218_C7300x", strike_date: "2026-12-18", held: true,
      legs: [{ sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7400 }] as never,
      positions: [{ id: "h-calls", name: "1218_C7300" }] });
    const view = plainView(input({ quotes: [...QUOTES, partly] }));
    const names = rowsOf(view, "Watchlist").map((r) => r[0]);
    expect(names).toContain("1218_C7300x");
    expect(names.join(" ")).not.toMatch(/[()]|shares/);
  });
});

describe("every state the status column carried is still named, in the header or the rule (#400)", () => {
  const sched = (over: Partial<NonNullable<Holding["schedule"]>>) => ({
    on_pace: 1, pace_gap: 0, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21, reached: null,
    manage_by_due: false, dte_at_open: 45, ...over,
  }) as Holding["schedule"];
  const legs = [side("short", "PUT", 6000), side("long", "PUT", 5950)];
  const held = (id: string, schedule: Holding["schedule"], over: Partial<Holding> = {}) =>
    holding(id, { name: id, strike_date: "2026-12-18", legs, schedule, fetched_at: "2026-11-15 23:04:15+08:00", ...over });
  const holdings = [
    held("at-stop", sched({ reached: "stop" })), held("at-target", sched({ reached: "target" })),
    held("due", sched({ manage_by_due: true })), held("calm", sched({})),
    held("closed-close", sched({ reached: "stop" }), { valued_from: "close", valued_timing: "close" } as Partial<Holding>),
  ];
  const line = (view: ReturnType<typeof plainView>, label: string) => view.lines.find((l) => l.label === label)?.text;

  it("a holding at stop, at target, at its manage-by, in the session: the needs-you line", () => {
    const view = plainView(input({ holdings, quotes: [], monitors: [] }));
    const needs = line(view, "needs you")!;
    for (const words of ["at-stop at stop", "at-target at target", "due at its manage-by", "closed-close at stop"]) {
      expect(needs).toContain(words);
    }
    expect(needs).not.toContain("calm");
  });

  it("a holding's Level in the session is not said again in a Levels line", () => {
    const view = plainView(input({ holdings, quotes: [], monitors: [] }));
    expect(view.lines.map((l) => l.label)).not.toContain("Levels");
  });

  it("outside the session, where the needs-you line names none (#354): a Levels line, in the chips' words", () => {
    // the page's own line out of the session, which says no holding's Level
    const needs = needsYou([], [], HEALTH, null, holdings, false);
    const view = plainView(input({ holdings, quotes: [], monitors: [], needs, session: false, takenAt: SUNDAY }));
    expect(line(view, "needs you")).toBeUndefined();
    expect(line(view, "Levels")).toBe([
      "at-stop at stop · as valued at Sun 23:04", "at-target at target · as valued at Sun 23:04",
      "due manage-by · as valued at Sun 23:04", "closed-close at stop · as of the close",
    ].join("; "));
    // and the Markdown carries it
    expect(toMarkdown(view)).toContain("- Levels: at-stop at stop · as valued at Sun 23:04; ");
  });

  it("a rule ringing, an entry signal, and a fault with its words: the needs-you line", () => {
    const quotes = [...QUOTES, entry("w-err", { code: "1231_P6000", strike_date: "2026-12-31",
      legs: [{ sign: -1, option_type: "PUT", strike: 6000 }, { sign: 1, option_type: "PUT", strike: 5950 }] as never,
      error: "no quote for US.SPXW261231P6000000" } as Partial<Entry> & { strike_date: string })];
    const needs = line(plainView(input({ quotes })), "needs you")!;
    expect(needs).toContain("1218_C7300 ringing");
    expect(needs).toContain("1204_P6900 entry signal");
    expect(needs).toContain("1231_P6000 — no quote for US.SPXW261231P6000000");
  });

  it("every quarantine, by its reason: the needs-you line", () => {
    const off = (id: string, reason: string) =>
      monitor(id, { code: id, strike: 8000 + id.length, enabled: false, disabled_reason: reason });
    const monitors = [off("q1", "unknown-contract"), off("q22", "no-figure"), off("q333", "unreadable")];
    const needs = line(plainView(input({ quotes: [], monitors })), "needs you")!;
    for (const why of ["the provider does not know its contract", "its figure never arrives", "its stored row cannot be read"]) {
      expect(needs).toContain(`quarantined — ${why}`);
    }
  });

  it("a rule's own state at every hour: its sentence", () => {
    const view = plainView(input());
    expect(cell(view, "1204_P6900", "rule")).toBe("|value| ≥ 6.00 — now 6.20, past it by 0.20");
  });

  it("a rule muted by hand, expired, off with its holding, for no recorded reason or an unknown one: a heading per reason", () => {
    const off = (id: string, reason: string | null) =>
      monitor(id, { code: id, strike: 8000 + id.length, enabled: false, disabled_reason: reason });
    const view = plainView(input({ quotes: [], monitors: [
      off("m1", "manual"), off("m22", "expired"), off("m333", "holding-closed"), off("m4444", null), off("m55555", "manual"),
      // a reason the page has no words for is still listed, under its own name, after the rest
      off("m666666", "sunset"),
    ] }));
    const muted = view.sections.find((s) => s.title === "Muted and expired")!;
    // the desk's fold's order, in the phone's words
    expect(muted.groups.map((g) => [g.heading, g.rows.map((r) => r[0])])).toEqual([
      ["expired", ["261218 8003C"]], ["its holding closed", ["261218 8004C"]],
      ["muted by hand", ["261218 8002C", "261218 8006C"]], ["reason not recorded", ["261218 8005C"]],
      ["sunset", ["261218 8007C"]],
    ]);
    // the rule in words, with no figure: nothing watches it
    expect(muted.groups[0]!.rows[0]![muted.columns.indexOf("rule")]).toBe("|Δ| ≥ 0.10");
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
      { label: "References", text: "", items: ["S&P 500 (moomoo) 7612.25 +0.42%"] },
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
    expect(view.lines.find((l) => l.label === "References")!.items).toEqual(["S&P 500 (moomoo) 7612.25 +0.42% read at 00:59"]);
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
    // what the service sends is not ours to trust: a line break, a pipe, a backtick or an asterisk
    // in a name, an error or a note must neither end a row nor open code or emphasis
    ["with a line break and a pipe in a name and an error", {
      quotes: [...QUOTES, entry("w-odd", { code: "1231_A|B\nC `x` *y*", strike_date: "2026-12-31",
        legs: [{ sign: -1, option_type: "PUT", strike: 6000 }, { sign: 1, option_type: "PUT", strike: 5950 }] as never,
        error: " bad | row\r\nsecond `line` *here* " } as Partial<Entry> & { strike_date: string })],
      holdingsError: "# refused\n- by | the service", holdings: null, error: "line one\nline | two",
    }],
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

  it("escapes a pipe in a cell, which would otherwise end it: |Δ| ≥ 0.20", () => {
    const md = toMarkdown(plainView(input()));
    expect(md).toContain("\\|Δ\\| ≥ 0.20 — now −0.170, 0.030 away");
    const rows = readMarkdown(md).sections[1]!.rows;
    // every row as wide as the header: an unescaped pipe would add a cell
    for (const r of rows) expect(r).toHaveLength(rows[0]!.length);
  });

  it("writes the header block as lines above a Markdown table per section", () => {
    const md = toMarkdown(plainView(input()));
    expect(md.split("\n").slice(0, 3)).toEqual(["# optionality", "", "- taken: Mon 16 Nov 2026 10:00 EST (New York) · Mon 16 Nov 2026 23:00 GMT+8 (Asia/Singapore)"]);
    expect(md).toContain("\n## Holdings\n\n| name | legs | value |");
    expect(md).toContain("\n| 261218 · 38 DTE |  |  |");
    // the References a nested list, one a line (#400)
    const twice = toMarkdown(plainView(input({ references: [SPX_REF, { ...SPX_REF, id: "r2", label: "VIX" } as Reference] })));
    expect(twice).toContain("\n- References:\n  - S&P 500 (moomoo) 7612.25 +0.42%\n  - VIX (moomoo) 7612.25 +0.42%\n");
  });
});

describe("text from the service", () => {
  it("is put on one line, with no space at its ends, in the picture and the text alike", () => {
    const view = plainView(input({ quotes: [...QUOTES, entry("w-odd", { code: "1231_A|B\nC", strike_date: "2026-12-31",
      legs: [{ sign: -1, option_type: "PUT", strike: 6000 }, { sign: 1, option_type: "PUT", strike: 5950 }] as never,
      error: " bad\r\nrow " } as Partial<Entry> & { strike_date: string })] }));
    expect(cell(view, "1231_A|B C", "legs")).toBe("−P6000 +P5950");
    const md = toMarkdown(view);
    expect(md).toContain("| 1231_A\\|B C |");
    // neither a backtick nor an asterisk may open code or emphasis in the text
    const marked = toMarkdown(plainView(input({ error: "see `x` and *y*" })));
    expect(marked).toContain("- warning: see \\`x\\` and \\*y\\*");
    // every table row still as wide as its header
    readMarkdown(md).sections.forEach((s, i) => { for (const r of s.rows) expect(r).toHaveLength(view.sections[i]!.columns.length); });
  });

  it("says why a Reference is a dash, as the strip's title does", () => {
    const dashed = { ...SPX_REF, id: "r2", label: "VIX", figure: null, change: null, error: "not entitled" } as Reference;
    const view = plainView(input({ references: [SPX_REF, dashed] }));
    expect(view.lines.find((l) => l.label === "References")!.items).toEqual(["S&P 500 (moomoo) 7612.25 +0.42%", "VIX (moomoo) — (not entitled)"]);
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
