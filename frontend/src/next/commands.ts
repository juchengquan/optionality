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
import type { Monitor } from "../shared/api";
import { shortDate } from "../shared/format";
import type { ArrangementChoice } from "../shared/prefs";
import { rowName, tableRows, type DeskRow } from "./desk/columns";
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
  /** the words typed text is matched against, lower case (`tokens`) */
  words: string[];
}

/** A leg; `short` unset for the one contract a rule watches, which is not a position. */
type Leg = { short?: boolean; type: string; strike: number; qty?: number };

/** `-2P7150 +P7100`: legs as the table writes them, short as minus and a quantity where it is not 1
 *  (#351); `P7150` for a rule's contract. */
const legWords = (legs: Leg[]) =>
  legs.map((l) => `${l.short === undefined ? "" : l.short ? "-" : "+"}${(l.qty ?? 1) === 1 ? "" : l.qty}${l.type[0]}${l.strike}`)
    .join(" ");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The words a text is made of, as typed text is split: lower case, and nothing but letters,
 *  digits and the `_`, `-` and `.` that names, dates and prices are written with. */
export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_.\-]+/g, " ").split(" ").filter(Boolean);
}

/** Every way the owner writes an expiry: `261218`, `2026-12-18`, and `dec 18` (or `dec 04`). */
function dateWords(iso: string): string[] {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso];
  return [shortDate(iso), iso, MONTHS[Number(m[1]) - 1] ?? "", m[2]!, String(Number(m[2]))];
}

/** A strike alone and with its side, `7150` and `p7150`. */
const strikeWords = (legs: Leg[]) => legs.flatMap((l) => [String(l.strike), `${l.type[0]}${l.strike}`]);

/** moomoo's `US.SPXW261218P7150000` as the strike it names, or null for anything else. */
function strikeOf(code: string): number | null {
  const m = /[CP](\d{4,})$/.exec(code);
  return m ? Number(m[1]) / 1000 : null;
}

/** One thing the palette finds. Its words are its name (whole, and in its parts), what it is, its
 *  expiry, its strikes and what it watches — NEVER a contract's code: moomoo writes a strike with
 *  three zeros after it (`…P6700000`), so "7000" found a 6700 put inside one. */
function findable(ref: string, kind: FindKind, name: string, date: string, legs: Leg[], field: string | null): Findable {
  const detail = [kind, shortDate(date), legWords(legs), field].filter(Boolean).join(" · ");
  const words = [name, ...tokens(name), ...tokens(kind), ...dateWords(date), ...strikeWords(legs), ...tokens(field ?? "")]
    .map((w) => w.toLowerCase()).filter(Boolean);
  return { ref, kind, name, detail, words: [...new Set(words)] };
}

function ofRow(row: DeskRow): Findable {
  if (row.kind === "holding") {
    const h = row.holding;
    const legs = h.legs.map((l) => ({ short: l.side === "short", type: l.option_type, strike: l.strike, qty: l.qty }));
    return findable(h.id, "holding", h.name, h.strike_date, legs, null);
  }
  if (row.kind === "rule") {
    const e = row.entry;
    const legs = e.legs
      ? e.legs.map((l) => ({ short: l.sign < 0, type: l.option_type, strike: l.strike, qty: l.qty }))
      : single(e.option_type, strikeOf(e.code));
    // a spread in the watchlist, the one that only partly overlaps a holding included (#346)
    const kind: FindKind = e.legs && (!e.held || Boolean(row.overlap)) ? "watched spread" : "Monitor";
    return findable(e.id, kind, rowName(row), e.strike_date, legs, fieldWords(e.field, Boolean(e.legs)));
  }
  return ofMonitor(row.monitor, "quarantined Monitor");
}

function ofMonitor(m: Monitor, kind: FindKind): Findable {
  const legs = m.legs
    ? m.legs.map((l) => ({ short: l.sign < 0, type: l.option_type, strike: l.strike, qty: l.qty }))
    : single(m.option_type, strikeOf(m.code) ?? m.strike);
  return findable(m.id, kind, monitorName(m), m.strike_date, legs, fieldWords(m.field, Boolean(m.legs)));
}

/** The single contract a rule watches, as one leg with no side. */
const single = (type: string, strike: number | null): Leg[] => (strike === null ? [] : [{ type, strike }]);

/** Everything the palette can find, in the order the desk draws it. */
export function findables(placed: BookModel): Findable[] {
  return [
    ...tableRows(placed).map(ofRow),
    ...placed.muted.map((m) => ofMonitor(m, m.disabled_reason === "expired" ? "expired Monitor" : "muted Monitor")),
  ];
}

/** What `query` finds among `all`, in their order: every word typed must START one of an item's
 *  words, in any order and any case — the start, so a word finds as it is typed ("715" already
 *  narrows to 7150), and a WORD, so a strike is never found in the middle of another number. */
export function matching<T extends { words: string[] }>(all: T[], query: string): T[] {
  const ws = tokens(query);
  return all.filter((f) => ws.every((w) => f.words.some((t) => t.startsWith(w))));
}

/** What holds the desk, for the palette: nothing; the selected rule's own editor; the selected
 *  holding's close form; or some other form — any of which a jump elsewhere would discard. */
export type Hold = "edit" | "close" | "other" | null;

export const HOLD_WHY = "finish or cancel the open form first";

export type ActionKey =
  | "add" | "edit-monitor" | "close-holding" | "save-image" | "arrange-desk" | "arrange-phone" | "arrange-auto";

export interface PaletteAction {
  key: ActionKey;
  label: string;
  /** what it acts on, or which is in use; empty when there is nothing to say */
  detail: string;
  /** why it cannot run now, or null when it can */
  why: string | null;
  words: string[];
}

const ARRANGEMENTS: [ActionKey, ArrangementChoice, string][] = [
  ["arrange-desk", "desk", "Arrangement: desk"],
  ["arrange-phone", "phone", "Arrangement: phone"],
  ["arrange-auto", "auto", "Arrangement: by the screen's width"],
];

/** The palette's actions. Two act on the selected row and are closed, with the reason, when the
 *  selection is not what they act on: a holding is not a Monitor, nor a Monitor a holding. */
export function paletteActions(s: {
  choice: ArrangementChoice; selected: DeskRow | null;
  /** what holds the desk (`holdOnDesk`): a form whose draft a jump or another form would discard */
  hold?: Hold;
  /** whether "by the screen's width" would make this screen the phone, which unmounts the desk */
  autoIsPhone?: boolean;
}): PaletteAction[] {
  const kind = s.selected?.kind ?? null;
  const name = s.selected ? rowName(s.selected) : "";
  const isMonitor = kind === "rule" || kind === "quarantined";
  const hold = s.hold ?? null;
  // a form action is fine while ITS form is the one open: that is landing on it again
  const held = (mine: Hold) => (hold !== null && hold !== mine ? HOLD_WHY : null);
  const out: Omit<PaletteAction, "words">[] = [
    { key: "add", label: "Add a spread or contract", detail: "", why: null },
    {
      key: "edit-monitor", label: "Edit the selected Monitor", detail: isMonitor ? name : "",
      why: kind === null ? "nothing is selected"
        : kind === "holding" ? "a holding is selected: select one of its Monitors" : held("edit"),
    },
    {
      key: "close-holding", label: "Close the selected holding", detail: kind === "holding" ? name : "",
      why: kind === null ? "nothing is selected"
        : kind === "holding" ? held("close") : "a Monitor is selected, not a holding",
    },
    // the header's "save as image" (#300): a picture of the view, which changes nothing in it
    { key: "save-image", label: "Save the view as an image", detail: "", why: null },
    // the desk's own arrangement does not take the desk down, so it waits for no form; the phone's does
    ...ARRANGEMENTS.map(([key, choice, label]) => ({
      key, label, detail: s.choice === choice ? "in use" : "",
      why: hold !== null && (choice === "phone" || (choice === "auto" && s.autoIsPhone)) ? HOLD_WHY : null,
    })),
  ];
  return out.map((a) => ({ ...a, words: tokens(`${a.label} ${a.detail}`) }));
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
