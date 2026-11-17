/** ONE book (the owner, 2026-11-17), on every surface that draws it: the desk's table, the phone's
 *  cards, and the saved picture with its Markdown (`snapshot/plain.ts`).
 *
 *  1. No Holdings and Watchlist sections: each expiry's heading once.
 *  2. Under it, the held spreads, then the watched spreads, then a quiet "contracts" label and the
 *     lone watched contracts — the label only where the expiry has some.
 *  3. "held" after a holding's name, heard in its name too; a watched row carries none.
 *  4. A holding's own rule (the combo named as it is) on its row; a second rule still a row under it.
 *  5. A leg's rule under its watched spread, and a watched contract on a HOLDING's leg under it.
 *  6. The overlap note beside the holding it names, in the same expiry.
 *  7. One empty-state line for an empty book, none for a book with only one of the two.
 *  The model's order is `NextOneBookModel.test.ts`'s; j and k's is `NextDeskKeys.test.tsx`'s.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Monitor } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { plainView, toMarkdown, type PlainInput } from "../snapshot/plain";
import { entry, HOLDINGS, monitor, MONITORS, QUOTES } from "../testing/ownerBook";
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
/** A watched contract on the held put spread's short leg, which the service links to nothing. */
const ON_LEG: Entry = entry("w-p6400", {
  code: "US.SPXW261218P6400000", strike_date: "2026-12-18", option_type: "PUT", field: "option_delta",
  threshold: 0.3, watched: -0.21, distance: 0.09, quote: { name: "SPXW 261218 6400.00P", option_delta: -0.21 },
});
const MORE_QUOTES = [...QUOTES, SECOND, ON_LEG];
const MORE_MONITORS: Monitor[] = [...MONITORS, monitor(SECOND.id, { code: SECOND.code }), monitor(ON_LEG.id, { code: ON_LEG.code })];

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: MORE_QUOTES, monitors: MORE_MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

function plain(over: Partial<BookProps> = {}) {
  const p = props(over);
  const input: PlainInput = {
    quotes: p.quotes, monitors: p.monitors, holdings: p.holdings, holdingsError: p.holdingsError,
    holdingsAt: p.holdingsAt, session: p.session, privacy: p.privacy, needs: [], health: null, polledAt: null,
    error: null, references: [], hidden: new Set(), takenAt: new Date("2026-11-16T15:00:00Z"),
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

describe("5. a leg's rule under its spread, and a watched contract on a held leg under the holding", () => {
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
