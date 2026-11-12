/** The desk's ⌘K palette (ADR 0023, #299) as a model: what it can find, how typed text finds it,
 *  the actions it offers and why one is closed, and the chord that opens it. Pure; `Palette.tsx`
 *  draws it and the page runs what is chosen.
 *
 *  - It finds what the table draws, in the order the table draws it (`tableRows`), and then the
 *    muted and expired rules, which the table folds away but the owner may still be looking for.
 *  - What it says of each is a NAME and words: never a figure. Under privacy the page hides $
 *    amounts and the count of contracts; a finder that never carries either cannot leak them, and a
 *    threshold or a P&L is the table's to say, live, not a list's to freeze at the moment it opened.
 */
import type { Monitor } from "../api";
import { shortDate } from "../format";
import type { ArrangementChoice } from "../prefs";
import { rowName, tableRows, type DeskRow } from "./desk/columns";
import type { Mode } from "./mode";
import { fieldWords, monitorName } from "./needs";
import type { BookModel } from "./placement";

export type FindKind =
  | "holding" | "watched spread" | "Monitor" | "quarantined Monitor" | "muted Monitor" | "expired Monitor";

export interface Findable {
  /** the row's id: a holding's, or a rule's */
  ref: string;
  kind: FindKind;
  name: string;
  /** what it is, its expiry and its strikes, in words */
  detail: string;
  /** everything typed text is matched against, lower case */
  text: string;
}

/** `-P7150 +P7100`: legs as the table writes them, short as minus. */
const legWords = (legs: { short: boolean; type: string; strike: number }[]) =>
  legs.map((l) => `${l.short ? "-" : "+"}${l.type[0]}${l.strike}`).join(" ");

/** moomoo's `US.SPXW261218P7150000` as the strike it names, or null for anything else. */
function strikeOf(code: string): number | null {
  const m = /[CP](\d{4,})$/.exec(code);
  return m ? Number(m[1]) / 1000 : null;
}

function findable(ref: string, kind: FindKind, name: string, date: string, legs: string, extra: string[]): Findable {
  const detail = [kind, shortDate(date), legs, ...extra].filter(Boolean).join(" · ");
  return { ref, kind, name, detail, text: [name, detail, date, ...extra].join(" ").toLowerCase() };
}

function ofRow(row: DeskRow): Findable {
  if (row.kind === "holding") {
    const h = row.holding;
    const legs = legWords(h.legs.map((l) => ({ short: l.side === "short", type: l.option_type, strike: l.strike })));
    return findable(h.id, "holding", h.name, h.strike_date, legs, []);
  }
  if (row.kind === "rule") {
    const e = row.entry;
    const legs = e.legs
      ? legWords(e.legs.map((l) => ({ short: l.sign < 0, type: l.option_type, strike: l.strike })))
      : `${e.option_type[0]}${strikeOf(e.code) ?? ""}`;
    const kind: FindKind = e.legs && !e.held ? "watched spread" : "Monitor";
    return findable(e.id, kind, rowName(row), e.strike_date, legs, [fieldWords(e.field, Boolean(e.legs)), e.code]);
  }
  return ofMonitor(row.monitor, "quarantined Monitor");
}

function ofMonitor(m: Monitor, kind: FindKind): Findable {
  const legs = m.legs
    ? legWords(m.legs.map((l) => ({ short: l.sign < 0, type: l.option_type, strike: l.strike })))
    : `${m.option_type[0]}${strikeOf(m.code) ?? m.strike}`;
  return findable(m.id, kind, monitorName(m), m.strike_date, legs, [fieldWords(m.field, Boolean(m.legs)), m.code]);
}

/** Everything the palette can find, in the order the desk draws it. */
export function findables(placed: BookModel): Findable[] {
  return [
    ...tableRows(placed).map(ofRow),
    ...placed.muted.map((m) => ofMonitor(m, m.disabled_reason === "expired" ? "expired Monitor" : "muted Monitor")),
  ];
}

/** The words typed, each of which must appear; none typed is everything. */
export function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** What `query` finds among `all`, in their order: every word typed, anywhere, in any case. */
export function matching<T extends { text: string }>(all: T[], query: string): T[] {
  const ws = words(query);
  return all.filter((f) => ws.every((w) => f.text.includes(w)));
}

export type ActionKey =
  | "add" | "edit-monitor" | "close-holding" | "mode" | "arrange-desk" | "arrange-phone" | "arrange-auto";

export interface PaletteAction {
  key: ActionKey;
  label: string;
  /** what it acts on, or which is in use; empty when there is nothing to say */
  detail: string;
  /** why it cannot run now, or null when it can */
  why: string | null;
  text: string;
}

const ARRANGEMENTS: [ActionKey, ArrangementChoice, string][] = [
  ["arrange-desk", "desk", "Arrangement: desk"],
  ["arrange-phone", "phone", "Arrangement: phone"],
  ["arrange-auto", "auto", "Arrangement: by the screen's width"],
];

/** The palette's actions. Two act on the selected row and are closed, with the reason, when the
 *  selection is not what they act on: a holding is not a Monitor, nor a Monitor a holding. */
export function paletteActions(s: { mode: Mode; choice: ArrangementChoice; selected: DeskRow | null }): PaletteAction[] {
  const kind = s.selected?.kind ?? null;
  const name = s.selected ? rowName(s.selected) : "";
  const isMonitor = kind === "rule" || kind === "quarantined";
  const out: Omit<PaletteAction, "text">[] = [
    { key: "add", label: "Add a spread", detail: "", why: null },
    {
      key: "edit-monitor", label: "Edit the selected Monitor", detail: isMonitor ? name : "",
      why: kind === null ? "nothing is selected"
        : kind === "holding" ? "a holding is selected: select one of its Monitors" : null,
    },
    {
      key: "close-holding", label: "Close the selected holding", detail: kind === "holding" ? name : "",
      why: kind === null ? "nothing is selected" : kind === "holding" ? null : "a Monitor is selected, not a holding",
    },
    { key: "mode", label: s.mode === "live" ? "Switch to Review" : "Switch to Live", detail: "", why: null },
    ...ARRANGEMENTS.map(([key, choice, label]) => ({
      key, label, detail: s.choice === choice ? "in use" : "", why: null,
    })),
  ];
  return out.map((a) => ({ ...a, text: `${a.label} ${a.detail}`.toLowerCase() }));
}

/** Whether the page is on a Mac, where the palette's chord is ⌘K rather than Ctrl+K. */
export function onMac(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** ⌘K on a Mac, Ctrl+K elsewhere, with no other modifier. Ctrl+K on a Mac is left alone — it is
 *  a text field's kill-to-end-of-line there — and so is any chord with Shift, Alt or both. */
export function isPaletteChord(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
