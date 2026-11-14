/** The saved view as ONE plain table (#394): what the picture draws and what "Copy as text" puts on
 *  the clipboard, built once here so the two cannot disagree.
 *
 *  The owner's decision (2026-11-15): the picture is for analysis later, by a person or a model, so
 *  it is the old page's plain table rather than the screen — from the desk and the phone alike, the
 *  same table. Words and numbers only. Everything the screen says by colour, a chip, a bar, a
 *  bracket or a symbol is said here in words: the rule in its full sentence (`sentence`, never the
 *  short form of #388), the pace gap as "behind by 0.40", a row's attention in a STATUS column in
 *  the page's own words (`chipWords`'s, the quarantine reasons, the muted reasons), and what each
 *  row is — a holding, a rule on one, a watched spread — in a column of its own, since the indent
 *  and the condor's bracket are gone.
 *
 *  Pure: no React, no DOM, no cookie and no clock of its own — the caller hands in the columns the
 *  viewer hid and the moment of the press. `Still.tsx` draws a `PlainView`; `toMarkdown` writes it.
 *
 *  Privacy goes in with the figures: every cell is a column's own text with the viewer's setting,
 *  so "$•••" here is "$•••" on the screen.
 */
import type { Entry, Health, Holding, Monitor, Reference } from "../shared/api";
import { DASH, freshnessWords, shortDate } from "../shared/format";
import { GROUPS } from "../shared/groups";
import { drawnReadings, referenceWords } from "../shared/readings";

import { attentionOf, COLUMNS, PINNED, rowName, rowStrip, type DeskColumn, type DeskRow } from "../desk/columns";
import { closedLineText, levelWords } from "../levels";
import { monitorName, QUARANTINED, storedRuleWords, type Need } from "../needs";
import { placeBook, type PlacedHolding } from "../placement";
import { servedWhen } from "../session";
import { distanceWords, nearest, strikeName } from "../strip";

/** What the view is made from: the page's figures as they stood at the press. */
export interface PlainInput {
  quotes: Entry[];
  monitors: Monitor[];
  holdings: Holding[] | null;
  holdingsError: string | null;
  holdingsAt: string | null;
  holdingsServed?: string | null;
  session: boolean;
  privacy: boolean;
  /** the needs-you line as the page draws it now */
  needs: Need[];
  health: Health | null;
  polledAt: string | null;
  /** why the figures may be stale, when they may */
  error: string | null;
  references: Reference[];
  /** the columns the viewer unticked (`ui_cols_combo`), read at the press */
  hidden: ReadonlySet<string>;
  /** the press */
  takenAt: Date;
}

/** A line of the header block: "session: market closed — as of the close, Fri 13 Nov 16:14". */
export interface PlainLine { label: string; text: string }

/** An expiry's rows under its heading ("261218 · 38 DTE"), or a section's rows with none. */
export interface PlainGroup { heading: string | null; rows: string[][] }

export interface PlainSection {
  title: string;
  /** what the section says before its rows: why there are none, or why they are listed apart */
  notes: string[];
  groups: PlainGroup[];
}

export interface PlainView {
  title: string;
  lines: PlainLine[];
  /** the table's header, the same for every section */
  columns: string[];
  sections: PlainSection[];
}

export const TITLE = "optionality";

// ---- the columns

/** What a plain column is called, with its unit: the screen's labels are short, a symbol or none. */
const LABELS: Record<string, string> = {
  name: "name", legs: "legs", value: "value (pts; a holding's cost to close)", pnl: "P&L ($)",
  captured: "captured (%)", pace_gap: "pace gap (pts)", delta: "delta (a holding's short leg)",
  strip: "SPX to the nearest short strike", dte: "DTE (days)", manage: "manage-by", alarm: "rule",
};

/** The nearest short strike, named, and how far SPX is from it in words: "P6400 500.50 pts · 1.25σ
 *  away" — the strip's words (`distanceWords`), where the screen draws a scale and the distance alone. */
function stripWords(row: DeskRow): string {
  const strip = rowStrip(row);
  if (!strip) return "";
  const k = nearest(strip);
  if (k === null) return strip.spx === null && strip.reason ? `${DASH} ${strip.reason}` : DASH;
  return `${strikeName(k)} ${distanceWords(k)}`;
}

/** A column's cell in words: what it MEANS where the screen draws a compact form (`words`: the pace
 *  gap's "behind by 0.40", the rule's sentence), its text otherwise. */
function cellOf(column: DeskColumn, row: DeskRow, privacy: boolean): string {
  if (column.key === "strip") return stripWords(row);
  return (column.words ?? column.text)(row, privacy);
}

/** The columns the view carries: the name, then every one the viewer ticked, in the table's order. */
function shownColumns(hidden: ReadonlySet<string>): DeskColumn[] {
  return COLUMNS.filter((c) => c.key === PINNED || !hidden.has(c.key));
}

// ---- what each row is, and its status

/** Muted, expired, or off with its holding, in the desk's fold's words, lower case. */
const offWords = (m: Monitor) =>
  (GROUPS.find(([r]) => r === (m.disabled_reason ?? null))?.[1] ?? "Reason not recorded").toLowerCase();

/** A row's state in words: what the screen says by its chip and its tint. Blank for a calm row. */
export function statusOf(row: DeskRow, session: boolean, now: Date): string {
  const a = attentionOf(row);
  if (a === null) return "";
  if (row.kind === "quarantined") {
    const why = (row.monitor.disabled_reason && QUARANTINED[row.monitor.disabled_reason]) ?? "switched off by the service";
    return `quarantined: ${why}`;
  }
  if (row.kind === "holding") return levelWords(a as "stop" | "target" | "manage", row.holding, session, now);
  if (a === "fault") return `fault: ${row.entry.error}`;
  return a === "entry" ? "entry signal" : "ringing";
}

// ---- the view

export function plainView(input: PlainInput): PlainView {
  const { privacy, session, takenAt: now } = input;
  const columns = shownColumns(input.hidden);
  const placed = placeBook(input.quotes, input.holdings, input.monitors);

  const row = (what: string, r: DeskRow) => [
    what,
    ...columns.map((c) => c.key === PINNED ? nameOf(r) : cellOf(c, r, privacy)),
    statusOf(r, session, now),
  ];
  /** a combo drawn in the watchlist because it only partly overlaps a holding says what it shares */
  const nameOf = (r: DeskRow) => r.kind === "rule" && r.overlap ? `${rowName(r)} (${r.overlap})` : rowName(r);

  // ---- Holdings
  const holdingNotes: string[] = [];
  if (input.holdingsError !== null) holdingNotes.push(`the holdings could not be valued — ${input.holdingsError}`);
  else if (input.holdings === null) holdingNotes.push("valuing…");
  else if (input.holdings.length === 0) holdingNotes.push("nothing held");
  const holdingGroups: PlainGroup[] = placed.holdings.map(({ expiry, rows }) => ({
    heading: `${shortDate(expiry)} · ${rows[0]![0]!.holding.dte} DTE`,
    rows: rows.flatMap((bracket) => bracket.flatMap((p: PlacedHolding, i) => {
      const partner = bracket.length === 2 ? bracket[1 - i]!.holding.name : null;
      return [
        row(partner ? `holding, a condor with ${partner}` : "holding", { kind: "holding", holding: p.holding, rules: p.rules }),
        ...p.rules.map((e) => row(`rule on ${p.holding.name}`, { kind: "rule", entry: e, nested: true })),
      ];
    })),
  }));
  if (placed.unplaced.length > 0) {
    holdingGroups.push({
      heading: `rules on held contracts — ${input.holdings === null
        ? "the holdings are not valued, so the rules about them are listed on their own"
        : "each watches a held contract that no single holding owns, as on a roll day"}`,
      rows: placed.unplaced.map((e) => row("rule on a held contract", { kind: "rule", entry: e, nested: false })),
    });
  }

  // ---- Watchlist
  const watchGroups: PlainGroup[] = placed.watchlist.map(({ expiry, items }) => ({
    heading: `${shortDate(expiry)} · ${items[0]!.entry.dte} DTE`,
    rows: items.flatMap(({ entry, under, overlap }) => [
      row(entry.legs ? "watched spread" : "watched contract", { kind: "rule", entry, nested: false, overlap }),
      ...under.map((e) => row(`rule on a leg of ${entry.code}`, { kind: "rule", entry: e, nested: true })),
    ]),
  }));
  if (placed.quarantined.length > 0) {
    watchGroups.push({
      heading: "quarantined — switched off by the service",
      rows: placed.quarantined.map((m) => row("quarantined rule", { kind: "quarantined", monitor: m })),
    });
  }

  const sections: PlainSection[] = [
    { title: "Holdings", notes: holdingNotes, groups: holdingGroups },
    {
      title: "Watchlist",
      notes: placed.watchlist.length === 0 && placed.quarantined.length === 0 ? ["nothing watched"] : [],
      groups: watchGroups,
    },
  ];

  // ---- Muted and expired: off by hand, by the calendar, or with their holding — the desk's fold
  if (placed.muted.length > 0) {
    sections.push({
      title: "Muted and expired",
      notes: [],
      groups: [{
        heading: null,
        rows: placed.muted.map((m) => [
          "muted rule",
          ...columns.map((c) => c.key === PINNED ? monitorName(m)
            : c.key === "alarm" ? storedRuleWords(m.field, Boolean(m.legs), m.compare, m.direction, m.threshold) : ""),
          offWords(m),
        ]),
      }],
    });
  }

  return {
    title: TITLE,
    lines: headerLines(input),
    columns: ["what", ...columns.map((c) => LABELS[c.key] ?? c.label), "status"],
    sections,
  };
}

// ---- the header block

const WALL = (timeZone: string) => new Intl.DateTimeFormat("en-US", {
  timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
});

/** "Sun 15 Nov 2026 12:00 EST", in a zone; null for a zone the browser does not know. */
function wallTime(at: Date, timeZone: string): string | null {
  try {
    const p = Object.fromEntries(WALL(timeZone).formatToParts(at).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  } catch {
    return null;
  }
}

const NEW_YORK = "America/New_York";

/** When the view was taken: on New York's clock, which the session is, and on DISPLAY_TZ's, which
 *  every time the service states is in — the second left out where the service has not said its
 *  zone, or it is New York's. */
export function takenWords(at: Date, displayTz: string | null): string {
  const ny = `${wallTime(at, NEW_YORK)} (New York)`;
  const there = displayTz && displayTz !== NEW_YORK ? wallTime(at, displayTz) : null;
  return there ? `${ny} · ${there} (${displayTz})` : ny;
}

/** The needs-you line in words, every item named: a picture cannot be opened to read "+2 more". */
function needsWords(needs: Need[]): string {
  const count = needs.length === 1 ? "1 needs you" : `${needs.length} need you`;
  return `${count} — ${needs.map((n) => n.text).join(" · ")}`;
}

function headerLines(input: PlainInput): PlainLine[] {
  const { health, session, takenAt } = input;
  const lines: PlainLine[] = [
    { label: "taken", text: takenWords(takenAt, health?.settings.display_tz ?? null) },
    {
      label: "session",
      // the market-closed line's own words outside the session (#371, #380)
      text: session ? "in session"
        : closedLineText(input.holdings !== null ? input.holdingsAt : null, input.holdingsServed, input.holdings, takenAt),
    },
    {
      label: "figures",
      text: freshnessWords(health?.monitor.fetched_at ?? null, input.polledAt, health?.settings.sweep_seconds ?? null),
    },
  ];
  if (input.error) lines.push({ label: "warning", text: input.error });
  // the strip's words: outside the session each with the time it was read (#371), in it none
  const readings = drawnReadings(input.references, session ? undefined : (s) => servedWhen(s, takenAt));
  if (readings.length > 0) {
    lines.push({ label: "References", text: readings.map(({ reference, at }) => referenceWords(reference, at)).join(" · ") });
  }
  // as the page: said when something needs you, and nothing otherwise — which is not an all-clear
  if (input.needs.length > 0) lines.push({ label: "needs you", text: needsWords(input.needs) });
  return lines;
}

// ---- the text

/** A cell as Markdown writes it: a pipe would end the cell ("|delta| ≥ 0.20"), so it is escaped,
 *  and so is the backslash that escapes it. */
const cellText = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("|", "\\|");

const tableRow = (cells: string[]) => `| ${cells.map(cellText).join(" | ")} |`;

/** The view as Markdown: the header block as lines above a table per section, an expiry's heading
 *  as a row of its own with the heading in its first cell. */
export function toMarkdown(view: PlainView): string {
  const out = [`# ${view.title}`, "", ...view.lines.map((l) => `- ${l.label}: ${l.text}`)];
  for (const s of view.sections) {
    out.push("", `## ${s.title}`);
    for (const n of s.notes) out.push("", n);
    if (s.groups.length === 0) continue;
    out.push("", tableRow(view.columns), `|${view.columns.map(() => " --- |").join("")}`);
    for (const g of s.groups) {
      if (g.heading !== null) out.push(tableRow([g.heading, ...view.columns.slice(1).map(() => "")]));
      for (const r of g.rows) out.push(tableRow(r));
    }
  }
  return `${out.join("\n")}\n`;
}
