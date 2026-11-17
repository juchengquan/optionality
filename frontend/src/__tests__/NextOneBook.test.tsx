/** ONE book (the owner, 2026-11-17), on every surface that draws it: the desk's table, the phone's
 *  cards, and the saved picture with its Markdown (`snapshot/plain.ts`).
 *
 *  1. No Holdings and Watchlist sections: each expiry's heading once.
 *  2. Under it, the held spreads, then the watched spreads, then a quiet "contracts" label and the
 *     lone watched contracts — the label only where the expiry has some.
 *  3. "held" after a holding's name, heard in its name too; a watched row carries none.
 *  4. A holding's own rule (the combo named as it is) on its row; a second rule still a row under it.
 *  5. A leg's rule under its watched spread; a contract rule on a held leg under its holding.
 *  6. The overlap note beside the holding it names, in the same expiry.
 *  7. One empty-state line for an empty book, none for a book with only one of the two.
 *  The model's order is `NextOneBookModel.test.ts`'s; j and k's is `NextDeskKeys.test.tsx`'s.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { plainView, toMarkdown, type PlainInput } from "../snapshot/plain";
import { tableRows } from "../desk/columns";
import { ownRule, placeBook } from "../placement";
import { entry, holding, HOLDINGS, monitor, MONITORS, QUOTES, side } from "../testing/ownerBook";
import { readMarkdown } from "../testing/plainRead";
import { OVERLAP_HOLDINGS, OVERLAP_MONITORS, OVERLAP_QUOTES } from "../testing/overlapBook";

afterEach(() => {
  cleanup();
  document.cookie = "ui_cols_combo=;path=/;max-age=0";
});

/** A second rule on the held call spread: the delta of its short leg, linked to it. */
const SECOND: Entry = entry("r-calls-short", {
  code: "US.SPXW261218C7300000", strike_date: "2026-12-18", option_type: "CALL", field: "option_delta",
  threshold: 0.3, watched: 0.33, distance: -0.03, held: true, scope: "leg",
  positions: [{ id: "h-calls", name: "1218_C7300" }], quote: { name: "SPXW 261218 7300.00C", option_delta: 0.33 },
});
/** A delta rule on the held put spread's short leg, as the service serves one: held, and linked to
 *  the holding with scope leg (`holdsAnyOf`, `adoptOrphanMonitors`). */
const ON_LEG: Entry = entry("w-p6400", {
  code: "US.SPXW261218P6400000", strike_date: "2026-12-18", option_type: "PUT", field: "option_delta",
  threshold: 0.3, watched: -0.21, distance: 0.09, held: true, scope: "leg",
  positions: [{ id: "h-puts", name: "1218_P6400" }], quote: { name: "SPXW 261218 6400.00P", option_delta: -0.21 },
});
const MORE_QUOTES = [...QUOTES, SECOND, ON_LEG];
const MORE_MONITORS: Monitor[] = [...MONITORS, monitor(SECOND.id, { code: SECOND.code }), monitor(ON_LEG.id, { code: ON_LEG.code })];

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: MORE_QUOTES, monitors: MORE_MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

function plain(over: Partial<BookProps> = {}, hidden: ReadonlySet<string> = new Set()) {
  const p = props(over);
  const input: PlainInput = {
    quotes: p.quotes, monitors: p.monitors, holdings: p.holdings, holdingsError: p.holdingsError,
    holdingsAt: p.holdingsAt, session: p.session, privacy: p.privacy, needs: [], health: null, polledAt: null,
    error: null, references: [], hidden, takenAt: new Date("2026-11-16T15:00:00Z"),
  };
  return plainView(input);
}

// ---- reading each surface back

const deskRows = () => [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")];
const deskRow = (id: string) => deskRows().find((r) => r.dataset.ref === id) ?? null;
const deskHeadings = () => [...document.querySelectorAll(".nxd-expiry h3")].map((h) => h.textContent);
/** Each expiry group's rows and labels, in order: a row by its ref, the label as `[contracts]`. */
const deskGroups = () => [...document.querySelectorAll<HTMLElement>(".nxd-expiry[data-expiry]")].map((g) => [
  g.dataset.expiry,
  ...[...g.querySelectorAll<HTMLElement>(".nxd-row[data-ref], [data-sub]")]
    .map((el) => (el.dataset.sub ? `[${el.dataset.sub}]` : el.dataset.ref!)),
]);

const phoneGroups = () => [...document.querySelectorAll<HTMLElement>(".nxp-expiry[data-expiry]")].map((g) => [
  g.dataset.expiry,
  ...[...g.querySelectorAll<HTMLElement>("article[data-ref], .nxp-rule[data-ref], [data-sub]")]
    .map((el) => (el.dataset.sub ? `[${el.dataset.sub}]` : el.dataset.ref!)),
]);
const card = (id: string) => document.querySelector<HTMLElement>(`article[data-ref="${id}"]`)!;

/** The book's rows in the picture, as their name cells. */
const plainNames = (view: ReturnType<typeof plain>) => view.sections[0]!.groups.map((g) => [g.heading, ...g.rows.map((r) => r[0])]);

// the one book's groups, by ref, on the fixture above
const GROUPS = [
  ["2026-12-04", "w-dec04"],
  ["2026-12-18", "h-calls", "r-calls-short", "h-puts", "w-p6400", "w-dec18", "w-dec18-delta"],
  ["2026-12-31", "h-ic", "w-dec31", "[contracts]", "w-lone"],
];

describe("1–2. each expiry once: held spreads, watched spreads, then the lone contracts", () => {
  it("on the desk", () => {
    render(<DeskBook {...props()} />);
    expect(deskHeadings()).toEqual(["20261204 · 38 DTE", "20261218 · 38 DTE", "20261231 · 38 DTE"]);
    expect(deskGroups()).toEqual(GROUPS);
    expect(screen.queryByRole("region", { name: /Holdings|Watchlist/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Book" })).toBeTruthy();
  });

  it("on the phone, each holding's rules inside its card", () => {
    render(<PhoneBook {...props()} />);
    expect([...document.querySelectorAll(".nxp-expiry h3")].map((h) => h.textContent))
      .toEqual(["20261204 · 38 DTE", "20261218 · 38 DTE", "20261231 · 38 DTE"]);
    expect(phoneGroups()).toEqual([
      ["2026-12-04", "w-dec04"],
      // the own rule is on the card, first, as the desk draws it on the row
      ["2026-12-18", "h-calls", "r-calls", "r-calls-short", "h-puts", "w-p6400", "w-dec18", "w-dec18-delta"],
      ["2026-12-31", "h-ic", "r-ic", "w-dec31", "[contracts]", "w-lone"],
    ]);
    expect(screen.queryByRole("region", { name: /Holdings|Watchlist/ })).toBeNull();
  });

  it("in the picture and the text", () => {
    const view = plain();
    expect(view.sections.map((s) => s.title)).toEqual(["Book", "Muted and expired"]);
    expect(plainNames(view)).toEqual([
      ["20261204 · 38 DTE", "1204_P6900"],
      ["20261218 · 38 DTE", "1218_C7300 held", "20261218 7300C", "1218_P6400 held", "20261218 6400P", "1218_P7150", "20261218 7150P"],
      ["20261231 · 38 DTE", "1231_IC held", "1231_C7600", "contracts", "20261231 8000C"],
      ["Quarantined — switched off by the service", "20261211 8000C"],
    ]);
    const md = toMarkdown(view);
    for (const day of ["20261204", "20261218", "20261231"]) expect(md.match(new RegExp(`\\n\\| ${day} · `, "g"))).toHaveLength(1);
  });

  it("draws no contracts label on an expiry with no lone contract, on any surface", () => {
    const noLone = MORE_QUOTES.filter((q) => q.id !== "w-lone");
    render(<DeskBook {...props({ quotes: noLone })} />);
    expect(document.querySelectorAll("[data-sub]")).toHaveLength(0);
    cleanup();
    render(<PhoneBook {...props({ quotes: noLone })} />);
    expect(document.querySelectorAll("[data-sub]")).toHaveLength(0);
    expect(plain({ quotes: noLone }).sections[0]!.groups.flatMap((g) => g.rows).some((r) => r[0] === "contracts")).toBe(false);
  });
});

describe("3. \"held\" after a holding's name, and in what a reader hears", () => {
  it("on the desk: the row's button is named with it, and a watched row's is not", () => {
    render(<DeskBook {...props()} />);
    for (const [id, name] of [["h-calls", "1218_C7300"], ["h-puts", "1218_P6400"], ["h-ic", "1231_IC"]] as const) {
      expect(within(deskRow(id)!).getByRole("button", { name: `${name} held` })).toBeTruthy();
      expect(deskRow(id)!.querySelector("[data-held]")!.textContent).toBe("held");
    }
    for (const [id, name] of [["w-dec18", "1218_P7150"], ["w-lone", "20261231 8000C"], ["w-dec18-delta", "20261218 7150P"]] as const) {
      expect(within(deskRow(id)!).getByRole("button", { name })).toBeTruthy();
      expect(deskRow(id)!.querySelector("[data-held]")).toBeNull();
    }
    // the inspector keeps the holding's own name
    fireEvent.click(within(deskRow("h-calls")!).getByRole("button", { name: "1218_C7300 held" }));
    expect(screen.getByRole("complementary", { name: "inspector: 1218_C7300" })).toBeTruthy();
  });

  it("on the phone: the card's name and the button that opens it", () => {
    render(<PhoneBook {...props()} />);
    expect(within(card("h-calls")).getByRole("button", { name: "details of 1218_C7300 held" })).toBeTruthy();
    expect(card("h-calls").querySelector(".nxp-name")!.textContent).toBe("1218_C7300 held");
    expect(within(card("w-dec18")).getByRole("button", { name: "details of 1218_P7150" })).toBeTruthy();
    expect(card("w-dec18").querySelector("[data-held]")).toBeNull();
  });

  it("in the picture: in the name cell, and on no watched row", () => {
    const names = plain().sections[0]!.groups.flatMap((g) => g.rows.map((r) => r[0]!));
    expect(names.filter((n) => n.endsWith(" held"))).toEqual(["1218_C7300 held", "1218_P6400 held", "1231_IC held"]);
  });
});

describe("4. a holding's own rule on its row, a second rule still a row under it", () => {
  const ruleCell = (id: string) => deskRow(id)!.querySelector<HTMLElement>('[data-col="alarm"] .nxd-v')!;

  it("on the desk: the rule cell draws the own rule's short form and distance, and no row is named as the holding", () => {
    render(<DeskBook {...props()} />);
    expect(deskRow("r-calls")).toBeNull();
    expect(deskRow("r-ic")).toBeNull();
    expect(ruleCell("h-calls").textContent).toBe("|value| ≥ 4.00   4.40  ▲ past 0.40");
    expect(ruleCell("h-calls").title).toBe("|value| ≥ 4.00 — now 4.40, past it by 0.40");
    expect(ruleCell("h-ic").textContent).toMatch(/^\|value\| ≥ 6\.00 .*↑3\.60$/);
    // a holding with no own rule has an empty rule cell
    expect(deskRow("h-puts")!.querySelector('[data-col="alarm"] .nxd-v')).toBeNull();
    // the second rule is a row of its own, under the holding
    expect(deskRow("r-calls-short")!.dataset.nested).toBe("");
    expect(deskRow("h-calls")!.closest("li")!.contains(deskRow("r-calls-short"))).toBe(true);
    // no two rows named the same in one expiry
    const names = deskRows().map((r) => r.querySelector(".nxd-name")!.textContent!.replace(/ held$/, ""));
    expect(new Set(names).size).toBe(names.length);
  });

  it("on the desk, where the rule's column drops: the own rule's arrowed distance in the name cell", () => {
    document.cookie = "ui_cols_combo=alarm;path=/";
    render(<DeskBook {...props()} />);
    expect(document.querySelector('.nxd-head [data-col="alarm"]')).toBeNull();
    const distance = deskRow("h-calls")!.querySelector<HTMLElement>("[data-distance]")!;
    expect(distance.querySelector('[aria-hidden="true"]')!.textContent).toBe("▲ past 0.40");
    expect(distance.querySelector(".sr-only")!.textContent).toBe(" rule |value| ≥ 4.00 — now 4.40, past it by 0.40");
    // none for a holding with no rule of its own
    expect(deskRow("h-puts")!.querySelector("[data-distance]")).toBeNull();
  });

  it("on the desk: the own rule ringing is said on the holding's row, beside its Level", () => {
    const atStop = HOLDINGS.map((h) => (h.id === "h-calls"
      ? { ...h, schedule: { dte_at_open: 45, on_pace: 1, pace_gap: 0, target: 1, stop: 4, target_dte: 10,
        manage_by_dte: 21, reached: "stop" as const, manage_by_due: false } } : h));
    render(<DeskBook {...props({ holdings: atStop })} />);
    const chips = [...deskRow("h-calls")!.querySelectorAll(".nx-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["at stop", "ringing"]);
  });

  it("on the phone: the own rule's line first on the card, unnamed, and the second rule after it, named", () => {
    render(<PhoneBook {...props()} />);
    const lines = [...card("h-calls").querySelectorAll<HTMLElement>(".nxp-rule")];
    expect(lines.map((l) => l.dataset.ref)).toEqual(["r-calls", "r-calls-short"]);
    expect(lines[0]!.querySelector(".nxp-rule-name")).toBeNull();
    expect(lines[1]!.querySelector(".nxp-rule-name")!.textContent).toBe("20261218 7300C");
  });

  it("in the picture: the own rule's sentence in the holding's rule cell, the second a row under it", () => {
    const view = plain();
    const s = view.sections[0]!;
    const rows = s.groups.flatMap((g) => g.rows);
    const rule = s.columns.indexOf("rule");
    expect(rows.find((r) => r[0] === "1218_C7300 held")![rule]).toBe("|value| ≥ 4.00 — now 4.40, past it by 0.40");
    expect(rows.filter((r) => r[0] === "1218_C7300")).toEqual([]);
    expect(rows.find((r) => r[0] === "20261218 7300C")![rule]).toMatch(/^\|Δ\| ≥ 0\.30 — now 0\.330/);
  });
});

describe("5. a leg's rule under its spread, and a contract rule on a held leg under the holding", () => {
  it("on the desk", () => {
    render(<DeskBook {...props()} />);
    expect(deskRow("w-dec18")!.closest("li")!.contains(deskRow("w-dec18-delta"))).toBe(true);
    expect(deskRow("h-puts")!.closest("li")!.contains(deskRow("w-p6400"))).toBe(true);
    expect(deskRow("w-p6400")!.dataset.nested).toBe("");
  });

  it("on the phone", () => {
    render(<PhoneBook {...props()} />);
    expect(card("w-dec18").querySelector('[data-ref="w-dec18-delta"]')).toBeTruthy();
    expect(card("h-puts").querySelector('[data-ref="w-p6400"]')).toBeTruthy();
  });
});

describe("6. the overlap note beside the holding it names, in its expiry", () => {
  const overlap = { quotes: OVERLAP_QUOTES, holdings: OVERLAP_HOLDINGS, monitors: OVERLAP_MONITORS };

  it("on the desk: under the watched spread, in the same expiry group as 1231_8050", () => {
    render(<DeskBook {...props(overlap)} />);
    const group = deskRow("h-8050")!.closest(".nxd-expiry")!;
    const note = group.querySelector<HTMLElement>("[data-overlap]")!;
    expect(note.textContent).toBe("shares C8100 with 1231_8050");
    expect(deskRow("r-8100")!.closest("li")!.contains(note)).toBe(true);
    expect(group.contains(deskRow("r-8100"))).toBe(true);
  });

  it("on the phone: on the watched spread's card, in the same expiry as 1231_8050's", () => {
    render(<PhoneBook {...props(overlap)} />);
    const group = card("h-8050").closest(".nxp-expiry")!;
    expect(group.contains(card("r-8100"))).toBe(true);
    expect(card("r-8100").querySelector("[data-overlap]")!.textContent).toBe("shares C8100 with 1231_8050");
  });
});

describe("7. one line for an empty book, none for a book with one half", () => {
  const lines = () => [...document.querySelectorAll(".nxd-note, .nxp-meta")].map((n) => n.textContent)
    .filter((t) => /^nothing|valuing/.test(t ?? ""));
  const cases: [string, Partial<BookProps>, string[]][] = [
    ["nothing at all", { holdings: [], quotes: [], monitors: [] }, ["nothing held or watched"]],
    ["nothing held", { holdings: [] }, []],
    ["nothing watched", { quotes: MORE_QUOTES.filter((q) => q.held), monitors: [] }, []],
    ["not valued yet", { holdings: null, quotes: [], monitors: [] }, ["valuing…"]],
  ];
  for (const [what, over, said] of cases) {
    it(`${what}: on the desk, the phone and in the picture`, () => {
      render(<DeskBook {...props(over)} />);
      expect(lines(), "desk").toEqual(said);
      cleanup();
      render(<PhoneBook {...props(over)} />);
      expect(lines(), "phone").toEqual(said);
      expect(plain(over).sections[0]!.notes, "picture").toEqual(said);
    });
  }
});

describe("4. a holding's own rule in the picture, where the rule's column is hidden", () => {
  it("is said in the holding's name cell, in its sentence; with the column shown, in its rule cell alone", () => {
    const hidden = plain({}, new Set(["alarm"]));
    const rows = hidden.sections[0]!.groups.flatMap((g) => g.rows);
    expect(hidden.sections[0]!.columns).not.toContain("rule");
    expect(rows.map((r) => r[0])).toContain("1218_C7300 held — |value| ≥ 4.00 — now 4.40, past it by 0.40");
    // a holding with no own rule says its name alone, and a rule's own row is unchanged
    expect(rows.map((r) => r[0])).toContain("1218_P6400 held");
    expect(rows.map((r) => r[0])).toContain("20261218 7300C");
    const text = toMarkdown(hidden);
    expect(text).toContain("| 1218_C7300 held — \\|value\\| ≥ 4.00 — now 4.40, past it by 0.40 |");
    // shown, the name is the name
    expect(plain().sections[0]!.groups.flatMap((g) => g.rows).map((r) => r[0])).toContain("1218_C7300 held");
  });
});

describe("the row's colour: the most serious of the holding's Level and its own rule (the owner, 2026-11-17)", () => {
  type Level = "stop" | "target" | "manage" | null;
  type Own = "ringing" | "fault" | null;
  const schedule = (level: Level) => (level === null ? null : {
    dte_at_open: 45, on_pace: 1, pace_gap: 0, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21,
    reached: level === "manage" ? null : level, manage_by_due: level === "manage",
  });
  const book = (level: Level, own: Own) => props({
    holdings: HOLDINGS.map((h) => (h.id === "h-calls" ? { ...h, schedule: schedule(level) } as Holding : h)),
    quotes: MORE_QUOTES.map((q) => (q.id === "r-calls"
      ? { ...q, triggered: own === "ringing", error: own === "fault" ? "its figure never arrives" : undefined } : q)),
  });
  const cases: [Level, Own, string][] = [
    [null, null, "calm"], ["target", null, "target"], ["manage", null, "manage"], ["stop", null, "stop"],
    [null, "ringing", "alarm"], [null, "fault", "fault"],
    ["target", "ringing", "alarm"], ["manage", "ringing", "alarm"], ["stop", "ringing", "stop"],
    ["target", "fault", "fault"], ["manage", "fault", "fault"], ["stop", "fault", "fault"],
  ];
  for (const [level, own, state] of cases) {
    it(`${level ?? "no Level"} with its own rule ${own ?? "calm"}: ${state}, on the desk and the phone`, () => {
      render(<DeskBook {...book(level, own)} />);
      expect(deskRow("h-calls")!.dataset.state).toBe(state);
      cleanup();
      render(<PhoneBook {...book(level, own)} />);
      // the phone tints a stop as it does a ring; a calm Level is no state of its own there either
      expect(card("h-calls").dataset.state).toBe(state);
    });
  }
});

describe("6. each rule drawn once, its second place a note (the owner, 2026-11-17)", () => {
  const OTHER = { ...QUOTES.find((q) => q.id === "w-dec18")!, id: "w-dec18b", code: "1218_P7150b",
    legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7050 }] } as Entry;
  const twoSpreads = [...MORE_QUOTES.map((q) => (q.id === "w-dec18-delta" ? { ...q, in_combos: ["w-dec18", "w-dec18b"] } : q)), OTHER];
  const CONDOR = entry("r-condor", { code: "1218_IC", strike_date: "2026-12-18", held: true, scope: "all",
    legs: [{ sign: -1, option_type: "CALL", strike: 7300 }, { sign: 1, option_type: "CALL", strike: 7350 },
           { sign: -1, option_type: "PUT", strike: 6400 }, { sign: 1, option_type: "PUT", strike: 6350 }] as never,
    positions: [{ id: "h-calls", name: "1218_C7300" }, { id: "h-puts", name: "1218_P6400" }] });

  it("on the desk: one row, under the first; a quiet note under the second, not a row", () => {
    render(<DeskBook {...props({ quotes: [...twoSpreads, CONDOR] })} />);
    for (const id of ["w-dec18-delta", "r-condor"]) {
      expect(deskRows().filter((r) => r.dataset.ref === id)).toHaveLength(1);
    }
    expect(deskRow("w-dec18")!.closest("li")!.contains(deskRow("w-dec18-delta"))).toBe(true);
    expect(deskRow("h-calls")!.closest("li")!.contains(deskRow("r-condor"))).toBe(true);
    const notes = [...document.querySelectorAll<HTMLElement>("[data-also]")];
    expect(notes.map((n) => n.textContent)).toEqual(["1218_IC also in 1218_C7300", "20261218 7150P also in 1218_P7150"]);
    expect(deskRow("h-puts")!.closest("li")!.contains(notes[0]!)).toBe(true);
    expect(deskRow("w-dec18b")!.closest("li")!.contains(notes[1]!)).toBe(true);
    for (const n of notes) {
      expect(n.closest("[data-ref]")).toBeNull();
      expect(n.querySelector("button, [tabindex]")).toBeNull();
    }
  });

  it("on the phone: one line, on the first card; a note on the second", () => {
    render(<PhoneBook {...props({ quotes: [...twoSpreads, CONDOR] })} />);
    for (const id of ["w-dec18-delta", "r-condor"]) {
      expect([...document.querySelectorAll<HTMLElement>("[data-ref]")].filter((e) => e.dataset.ref === id)).toHaveLength(1);
    }
    expect(card("h-puts").querySelector("[data-also]")!.textContent).toBe("1218_IC also in 1218_C7300");
    expect(card("w-dec18b").querySelector("[data-also]")!.textContent).toBe("20261218 7150P also in 1218_P7150");
  });

  it("in the inspector, still listed under each: it is a rule about both", () => {
    render(<DeskBook {...props({ quotes: [...twoSpreads, CONDOR] })} />);
    fireEvent.click(within(deskRow("h-puts")!).getByRole("button", { name: "1218_P6400 held" }));
    const insp = screen.getByRole("complementary", { name: "inspector: 1218_P6400" });
    expect(insp.textContent).toContain("|value| ≥ 6.00");
  });
});

// ---- every rule and holding once, on every surface, over books shaped as the service shapes them

/** A small seeded generator, so a failure names a book that can be made again. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

function serviceBook(seed: number): { quotes: Entry[]; holdings: Holding[]; monitors: Monitor[] } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const dates = ["2026-12-04", "2026-12-18", "2026-12-31"];
  const code = (date: string, t: "CALL" | "PUT", k: number) => `US.SPXW${date.slice(2).replaceAll("-", "")}${t[0]}${k}000`;
  const contract = (id: string, date: string, t: "CALL" | "PUT", k: number, over: Partial<Entry> = {}) => entry(id, {
    code: code(date, t, k), strike_date: date, option_type: t, field: "option_delta", threshold: 0.2, watched: 0.1,
    distance: 0.1, quote: { name: `SPXW ${date.slice(2).replaceAll("-", "")} ${k}.00${t[0]}`, option_delta: 0.1 }, ...over,
  });
  const holdings: Holding[] = [];
  const quotes: Entry[] = [];
  let k = 6000;
  for (let i = 0; i < Math.floor(r() * 5); i++) {
    const date = pick(dates);
    const t = r() < 0.5 ? "CALL" : "PUT";
    k += 50;
    const h = holding(`h${i}`, { name: `H${i}`, strike_date: date, legs: [side("short", t, k), side("long", t, k + 50)] });
    holdings.push(h);
    const to = [{ id: h.id, name: h.name }];
    const legs = [{ sign: -1, option_type: t, strike: k }, { sign: 1, option_type: t, strike: k + 50 }];
    // its value rule, named as it or renamed; sometimes a delta rule over all of it as well
    if (r() < 0.8) quotes.push(entry(`own${i}`, { code: r() < 0.7 ? h.name : `stop ${i}`, strike_date: date, legs: legs as never, held: true, scope: "all", positions: to }));
    if (r() < 0.3) quotes.push(entry(`d${i}`, { code: `${h.name} delta`, field: "option_delta", strike_date: date, legs: legs as never, held: true, scope: "all", positions: to }));
    // a rule on its short leg, held and linked
    if (r() < 0.5) quotes.push(contract(`leg${i}`, date, t, k, { held: true, scope: "leg", positions: to }));
  }
  // a rule over two holdings on one expiry: a condor held as two spreads
  for (const date of dates) {
    const two = holdings.filter((h) => h.strike_date === date).slice(0, 2);
    if (two.length === 2 && r() < 0.7) {
      quotes.push(entry(`c-${date}`, { code: `IC ${date}`, strike_date: date, held: true, scope: "all",
        legs: [...two[0]!.legs, ...two[1]!.legs].map((l) => ({ sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike })) as never,
        positions: two.map((h) => ({ id: h.id, name: h.name })) }));
    }
  }
  // watched spreads, their leg rules (in one or two of them), and lone contracts
  const watched: Entry[] = [];
  for (let i = 0; i < Math.floor(r() * 5); i++) {
    const date = pick(dates);
    k += 50;
    const w = entry(`w${i}`, { code: `W${i}`, strike_date: date,
      legs: [{ sign: -1, option_type: "PUT", strike: k }, { sign: 1, option_type: "PUT", strike: k - 50 }] as never });
    watched.push(w);
    quotes.push(w);
  }
  for (let i = 0; i < Math.floor(r() * 4); i++) {
    const date = pick(dates);
    const homes = watched.filter((w) => w.strike_date === date);
    const into = homes.filter(() => r() < 0.6).map((w) => w.id);
    k += 50;
    quotes.push(contract(`c${i}`, date, "PUT", k, { in_combos: into }));
  }
  const monitors = quotes.map((q) => monitor(q.id, { code: q.code, strike_date: q.strike_date }));
  return { quotes, holdings, monitors };
}

describe("6. every rule and every holding once, on the desk, the phone, the picture and the text", () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`book ${seed}`, () => {
      const b = serviceBook(seed);
      const all = new Set([...b.holdings.map((h) => h.id), ...b.quotes.map((q) => q.id)]);
      const placed = placeBook(b.quotes, b.holdings, b.monitors);
      const own = new Set(placed.book.flatMap((g) => g.held.flat())
        .map((p) => ownRule(p.holding, p.rules)?.id).filter((x): x is string => Boolean(x)));
      const once = (ids: string[], what: string) => {
        expect(ids.length, `${what}: an id twice\n${ids.join(" ")}`).toBe(new Set(ids).size);
      };
      // j and k walk these
      const keyed = tableRows(placed).map((r) => (r.kind === "holding" ? r.holding.id : r.kind === "rule" ? r.entry.id : r.monitor.id));
      once(keyed, "rows");
      render(<DeskBook {...props(b)} />);
      const desk = deskRows().map((r) => r.dataset.ref!);
      once(desk, "desk");
      expect(desk).toEqual(keyed);
      expect(new Set([...desk, ...own])).toEqual(all);
      for (const id of own) expect(desk).not.toContain(id);
      cleanup();
      render(<PhoneBook {...props(b)} />);
      const phone = [...document.querySelectorAll<HTMLElement>(".nxp-book [data-ref]")].map((e) => e.dataset.ref!);
      once(phone, "phone");
      expect(new Set(phone)).toEqual(all);
      cleanup();
      const view = plain(b);
      const rows = view.sections[0]!.groups.flatMap((g) => g.rows).filter((r) => r[0] !== "contracts");
      expect(rows.length, "picture").toBe(all.size - own.size);
      const text = readMarkdown(toMarkdown(view)).sections[0]!.rows;
      const headings = view.sections[0]!.groups.filter((g) => g.heading !== null).length;
      const labels = view.sections[0]!.groups.flatMap((g) => g.rows).length - rows.length;
      // the header row, a row per heading and per label, and the rows
      const groups = view.sections[0]!.groups.length;
      expect(text.length, "text").toBe(groups === 0 ? 0 : 1 + headings + labels + rows.length);
    });
  }
});
