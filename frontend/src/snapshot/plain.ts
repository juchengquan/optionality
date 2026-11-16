/** The saved view as ONE plain table (#394): what the picture draws and what "Copy as text" puts on
 *  the clipboard, built once here so the two cannot disagree.
 *
 *  The owner's decision (2026-11-15): the picture is for analysis later, by a person or a model, so
 *  it is the old page's plain table rather than the screen — from the desk and the phone alike, the
 *  same table. Words and numbers only: the rule in its full sentence (`sentence`, never the short
 *  form of #388), the pace gap as "behind by 0.40".
 *
 *  Fewer, shorter columns since #400 (the owner, 2026-11-15): no column saying what each row is and
 *  no status column. A row's attention is said where the page says it — the needs-you line and the
 *  rule's sentence — and what the needs line cannot say is said in the header and the headings
 *  instead: out of the session, a "Levels" line with each holding's Level in its chip's words (the
 *  page's line names none there, #354), and the muted rules grouped under their reasons.
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

import { PINNED, PLAIN_COLUMNS, rowName, rowStrip, type DeskColumn, type DeskRow } from "../desk/columns";
import { closedLineText, levelWords } from "../levels";
import { monitorName, storedRuleWords, type Need } from "../needs";
import { mutedWords } from "../phone/figures";
import { placeBook, type PlacedHolding } from "../placement";
import { servedWhen, type MarketPhase } from "../session";
import { compactWords, nearest, strikeName } from "../strip";

/** What the view is made from: the page's figures as they stood at the press. */
export interface PlainInput {
  quotes: Entry[];
  monitors: Monitor[];
  holdings: Holding[] | null;
  holdingsError: string | null;
  holdingsAt: string | null;
  holdingsServed?: string | null;
  session: boolean;
  /** which of SPX options' sessions (#416), for the session line; absent, regular or closed by
   *  `session` */
  phase?: MarketPhase;
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

/** A line of the header block: "session: market closed — as of the close, Fri 13 Nov 16:14" — or a
 *  list, one item a line under its label, as the References are (#400). */
export interface PlainLine { label: string; text: string; items?: string[] }

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

/** What a plain column is called: short (#400), a unit only where the figure's own form does not
 *  say it. */
const LABELS: Record<string, string> = {
  name: "name", legs: "legs", value: "value", pnl: "P&L ($)", captured: "captured (%)",
  pace_gap: "pace gap (pts)", delta: "Δ", strip: "SPX→short", dte: "DTE", manage: "manage-by", alarm: "rule",
};

/** The nearest short strike, named, and how far SPX is from it: "C8050 488 · 1.64σ" (`compactWords`,
 *  #400), where the screen draws a scale beside the distance. */
function stripWords(row: DeskRow): string {
  const strip = rowStrip(row);
  if (!strip) return "";
  const k = nearest(strip);
  if (k === null) return strip.spx === null && strip.reason ? `${DASH} ${strip.reason}` : DASH;
  return `${strikeName(k)} ${compactWords(k)}`;
}

/** A column's cell in words: what it MEANS where the screen draws a compact form (`words`: the pace
 *  gap's "behind by 0.40", the rule's sentence), its text otherwise. */
function cellOf(column: DeskColumn, row: DeskRow, privacy: boolean): string {
  if (column.key === "strip") return stripWords(row);
  return (column.words ?? column.text)(row, privacy);
}

/** The columns the view carries: the name, then every one the viewer ticked, in the table's order —
 *  the value and the pace gap apart (`PLAIN_COLUMNS`), the gap ticked with the value, the column the
 *  screen draws it in (2026-11-16). A "pace_gap" left in the cookie from before hides nothing. */
function shownColumns(hidden: ReadonlySet<string>): DeskColumn[] {
  return PLAIN_COLUMNS.filter((c) => c.key === PINNED || !hidden.has(c.key === "pace_gap" ? "value" : c.key));
}

// ---- the muted rules, by their reasons

/** Why a rule is off, as the muted rules' heading says it (#400): the phone's words for it. */
const reasonWords = (reason: string | null) => reason === null ? "reason not recorded" : mutedWords(reason);

/** The muted rules grouped by why they are off, in the desk's fold's order (`GROUPS`), and any reason
 *  it does not know after them, so no rule is dropped. */
function byReason(muted: readonly Monitor[]): [string | null, Monitor[]][] {
  const known = GROUPS.map(([r]) => r);
  const reasons = [...known, ...new Set(muted.map((m) => m.disabled_reason ?? null).filter((r) => !known.includes(r)))];
  return reasons.map((r): [string | null, Monitor[]] => [r, muted.filter((m) => (m.disabled_reason ?? null) === r)])
    .filter(([, ms]) => ms.length > 0);
}

// ---- the view

export function plainView(input: PlainInput): PlainView {
  const { privacy } = input;
  const columns = shownColumns(input.hidden);
  const placed = placeBook(input.quotes, input.holdings, input.monitors);

  // a name with no note beside it (#400): the page keeps its overlap note, the table does not
  const row = (r: DeskRow) =>
    columns.map((c) => c.key === PINNED ? rowName(r) : cellOf(c, r, privacy));

  // ---- Holdings
  const holdingNotes: string[] = [];
  if (input.holdingsError !== null) holdingNotes.push(`the holdings could not be valued — ${input.holdingsError}`);
  else if (input.holdings === null) holdingNotes.push("valuing…");
  else if (input.holdings.length === 0) holdingNotes.push("nothing held");
  const holdingGroups: PlainGroup[] = placed.holdings.map(({ expiry, rows }) => ({
    heading: `${shortDate(expiry)} · ${rows[0]![0]!.holding.dte} DTE`,
    rows: rows.flat().flatMap((p: PlacedHolding) => [
      row({ kind: "holding", holding: p.holding, rules: p.rules }),
      ...p.rules.map((e) => row({ kind: "rule", entry: e, nested: true })),
    ]),
  }));
  if (placed.unplaced.length > 0) {
    holdingGroups.push({
      heading: `rules on held contracts — ${input.holdings === null
        ? "the holdings are not valued, so the rules about them are listed on their own"
        : "each watches a held contract that no single holding owns, as on a roll day"}`,
      rows: placed.unplaced.map((e) => row({ kind: "rule", entry: e, nested: false })),
    });
  }

  // ---- Watchlist
  const watchGroups: PlainGroup[] = placed.watchlist.map(({ expiry, items }) => ({
    heading: `${shortDate(expiry)} · ${items[0]!.entry.dte} DTE`,
    rows: items.flatMap(({ entry, under, overlap }) => [
      row({ kind: "rule", entry, nested: false, overlap }),
      ...under.map((e) => row({ kind: "rule", entry: e, nested: true })),
    ]),
  }));
  if (placed.quarantined.length > 0) {
    watchGroups.push({
      heading: "quarantined — switched off by the service",
      rows: placed.quarantined.map((m) => row({ kind: "quarantined", monitor: m })),
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
  // under a heading row per reason, as the expiries are (#400): with no status column, the heading
  // is where why it is off is said
  if (placed.muted.length > 0) {
    sections.push({
      title: "Muted and expired",
      notes: [],
      groups: byReason(placed.muted).map(([reason, ms]) => ({
        heading: reasonWords(reason),
        rows: ms.map((m) => columns.map((c) => c.key === PINNED ? monitorName(m)
          : c.key === "alarm" ? storedRuleWords(m.field, Boolean(m.legs), m.compare, m.direction, m.threshold) : "")),
      })),
    });
  }

  return tidy({
    title: TITLE,
    lines: headerLines(input),
    columns: columns.map((c) => LABELS[c.key] ?? c.label),
    sections,
  });
}

/** Every word of the view on one line, one space between words and none at either end: a name or an
 *  error the service sent with a line break in it would otherwise end a Markdown table row, or a
 *  header line, partway — and the picture, which draws any run of white space as one space, and the
 *  text would read apart. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function tidy(view: PlainView): PlainView {
  return {
    title: oneLine(view.title),
    lines: view.lines.map((l) => ({
      label: oneLine(l.label), text: oneLine(l.text), ...(l.items ? { items: l.items.map(oneLine) } : {}),
    })),
    columns: view.columns.map(oneLine),
    sections: view.sections.map((s) => ({
      title: oneLine(s.title),
      notes: s.notes.map(oneLine),
      groups: s.groups.map((g) => ({
        heading: g.heading === null ? null : oneLine(g.heading), rows: g.rows.map((r) => r.map(oneLine)),
      })),
    })),
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
      // ...and in the Curb and GTH, that the quotes are live and thin (#416)
      text: (input.phase ?? (session ? "regular" : "closed")) === "regular" ? "in session"
        : closedLineText(input.holdings !== null ? input.holdingsAt : null, input.holdingsServed, input.holdings, takenAt,
          input.phase ?? "closed"),
    },
    {
      label: "figures",
      text: freshnessWords(health?.monitor.fetched_at ?? null, input.polledAt, health?.settings.sweep_seconds ?? null),
    },
  ];
  if (input.error) lines.push({ label: "warning", text: input.error });
  // the strip's words: outside the session each with the time it was read (#371), in it none
  // one a line (#400)
  const readings = drawnReadings(input.references, session ? undefined : (s) => servedWhen(s, takenAt));
  if (readings.length > 0) {
    lines.push({ label: "References", text: "", items: readings.map(({ reference, at }) => referenceWords(reference, at)) });
  }
  // outside the session the needs-you line names no holding's Level (#354), and with no status
  // column the table no longer does either: the chips' own words, here (#400)
  const levels = session ? [] : levelLines(input.holdings ?? [], takenAt);
  if (levels.length > 0) lines.push({ label: "Levels", text: levels.join("; ") });
  // as the page: said when something needs you, and nothing otherwise — which is not an all-clear
  if (input.needs.length > 0) lines.push({ label: "needs you", text: needsWords(input.needs) });
  return lines;
}

/** Each holding's Level reached, "1231_8100 at stop · as of the close", in its chip's words
 *  (`levelWords`, outside the session): a Level reached and a manage-by due are both said. */
function levelLines(holdings: readonly Holding[], now: Date): string[] {
  return holdings.flatMap((h) => {
    const s = h.schedule;
    const out: string[] = [];
    if (s?.reached === "stop" || s?.reached === "target") out.push(`${h.name} ${levelWords(s.reached, h, false, now)}`);
    if (s?.manage_by_due) out.push(`${h.name} ${levelWords("manage", h, false, now)}`);
    return out;
  });
}

// ---- the text

/** A cell as Markdown writes it: a pipe would end the cell ("|Δ| ≥ 0.20"), so it is escaped,
 *  and so is the backslash that escapes it. */
const cellText = (s: string) => inline(s).replaceAll("|", "\\|");

/** Text as Markdown writes it inline: a backslash, a backtick and an asterisk escaped, so a name or an
 *  error cannot open code or emphasis. An underscore is left alone — every holding's name has one,
 *  and GitHub's Markdown never reads one inside a word as emphasis. */
const inline = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("*", "\\*");

/** A note on a line of its own: inline, and a first character that would make it a heading, a list
 *  item, a quote or a table row escaped. */
const noteText = (s: string) => inline(s).replace(/^([#>|+-])/, "\\$1");

const tableRow = (cells: string[]) => `| ${cells.map(cellText).join(" | ")} |`;

/** The view as Markdown: the header block as lines above a table per section, an expiry's heading
 *  as a row of its own with the heading in its first cell. */
export function toMarkdown(view: PlainView): string {
  const out = [`# ${view.title}`, ""];
  for (const l of view.lines) {
    // a list is a nested list, an item a line (#400)
    if (l.items) out.push(`- ${l.label}:`, ...l.items.map((i) => `  - ${inline(i)}`));
    else out.push(`- ${l.label}: ${inline(l.text)}`);
  }
  for (const s of view.sections) {
    out.push("", `## ${s.title}`);
    for (const n of s.notes) out.push("", noteText(n));
    if (s.groups.length === 0) continue;
    out.push("", tableRow(view.columns), `|${view.columns.map(() => " --- |").join("")}`);
    for (const g of s.groups) {
      if (g.heading !== null) out.push(tableRow([g.heading, ...view.columns.slice(1).map(() => "")]));
      for (const r of g.rows) out.push(tableRow(r));
    }
  }
  return `${out.join("\n")}\n`;
}
