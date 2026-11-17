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
import type { Monitor } from "./shared/api";
import { heldLeg, signedLeg, type WrittenLeg } from "./shared/format";
import { writtenDate } from "./shared/times";
import type { ArrangementChoice } from "./shared/prefs";
import { rowName, tableRows, type DeskRow } from "./desk/columns";
import { fieldWords, monitorName } from "./needs";
import { ownRule, type BookModel } from "./placement";

type FindKind =
  | "holding" | "watched spread" | "rule" | "quarantined rule" | "muted rule" | "expired rule";

/** A rule is a "rule" on screen (part G), and was a "Monitor" — the API's and CONTEXT.md's word,
 *  which the owner still types: either finds one. */
const RULE_SYNONYMS = ["rule", "monitor"];

export interface Findable {
  /** the row's id: a holding's, or a rule's */
  ref: string;
  kind: FindKind;
  name: string;
  /** what it is, its expiry and its strikes, in its parts: the legs apart, so the palette draws
   *  each type in its colour (#391) */
  parts: { before: string; legs: WrittenLeg[]; after: string };
  /** the words typed text is matched against, lower case (`tokens`) */
  words: string[];
}

/** A leg; `short` unset for the one contract a rule watches, which is not a position. */
type Leg = WrittenLeg;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The words a text is made of, as typed text is split: lower case, and nothing but letters,
 *  digits and the `_`, `-` and `.` that names, dates and prices are written with. */
export function tokens(text: string): string[] {
  // the true minus the page writes a short leg with is the hyphen-minus a keyboard types
  return text.replaceAll("\u2212", "-").toLowerCase().replace(/[^a-z0-9_.\-]+/g, " ").split(" ").filter(Boolean);
}

/** Every way the owner writes an expiry: `20261218` as the page writes it (2026-11-17), `261218` as
 *  a contract's code and his older names carry it, `2026-12-18`, and `dec 18` (or `dec 04`). */
function dateWords(iso: string): string[] {
  const m = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso];
  return [writtenDate(iso), `${m[1]}${m[2]}${m[3]}`, iso, MONTHS[Number(m[2]) - 1] ?? "", m[3]!, String(Number(m[3]))];
}

/** A strike alone and with its side, `7150` and `p7150`. */
const strikeWords = (legs: Leg[]) => legs.flatMap((l) => [String(l.strike), `${l.option_type[0]}${l.strike}`]);

/** moomoo's `US.SPXW261218P7150000` as the strike it names, or null for anything else. */
function strikeOf(code: string): number | null {
  const m = /[CP](\d{4,})$/.exec(code);
  return m ? Number(m[1]) / 1000 : null;
}

/** What a rule watches, as it is SPOKEN, for finding it: the page writes the field as a symbol
 *  (`fieldWords`, #404), and nobody types "Δ" into a search box. A rule on a spread is found by
 *  "spread" too, which its field's words said ("spread value", "spread delta") until #404. */
const SPOKEN: Record<string, string> = {
  mid_price: "value price mid", option_delta: "delta", option_gamma: "gamma", option_theta: "theta",
  option_vega: "vega", option_implied_volatility: "IV",
};

/** One thing the palette finds. Its words are its name (whole, and in its parts), what it is, its
 *  expiry, its strikes and what it watches, as it is spoken (`SPOKEN`) —
 *  NEVER a contract's code: moomoo writes a strike with three zeros after it (`…P6700000`), so
 *  "7000" found a 6700 put inside one. */
function findable(
  ref: string, kind: FindKind, name: string, date: string, legs: Leg[], storedField: string | null, combo = false,
): Findable {
  const field = storedField === null ? null : fieldWords(storedField);
  // the legs apart, for the palette to draw
  const before = [kind, writtenDate(date)].filter(Boolean).join(" · ");
  const parts = { before: legs.length > 0 ? `${before} · ` : before, legs, after: field ? ` · ${field}` : "" };
  const words = [name, ...tokens(name), ...tokens(kind), ...(kind.endsWith("rule") ? RULE_SYNONYMS : []), ...dateWords(date), ...strikeWords(legs),
    ...tokens(storedField === null ? "" : SPOKEN[storedField] ?? storedField),
    ...(storedField !== null && combo ? ["spread"] : [])]
    .map((w) => w.toLowerCase()).filter(Boolean);
  return { ref, kind, name, parts, words: [...new Set(words)] };
}

function ofRow(row: DeskRow): Findable {
  if (row.kind === "holding") {
    const h = row.holding;
    const legs = h.legs.map(heldLeg);
    const found = findable(h.id, "holding", h.name, h.strike_date, legs, null);
    // its own rule is drawn on its row (2026-11-17), so what that rule watches finds the holding
    // too; its parts stay the holding's
    const own = ownRule(h, row.rules);
    if (!own) return found;
    // and as a rule: "7300 monitor" lands on the row that draws it
    const watches = [...tokens(SPOKEN[own.field] ?? own.field), ...(own.legs ? ["spread"] : []), ...RULE_SYNONYMS];
    return { ...found, words: [...new Set([...found.words, ...watches])] };
  }
  if (row.kind === "rule") {
    const e = row.entry;
    const legs = e.legs
      ? e.legs.map(signedLeg)
      : single(e.option_type, strikeOf(e.code));
    // a spread in the watchlist, the one that only partly overlaps a holding included (#346)
    const kind: FindKind = e.legs && (!e.held || Boolean(row.overlap)) ? "watched spread" : "rule";
    return findable(e.id, kind, rowName(row), e.strike_date, legs, e.field, Boolean(e.legs));
  }
  return ofMonitor(row.monitor, "quarantined rule");
}

function ofMonitor(m: Monitor, kind: FindKind): Findable {
  const legs = m.legs
    ? m.legs.map(signedLeg)
    : single(m.option_type, strikeOf(m.code) ?? m.strike);
  return findable(m.id, kind, monitorName(m), m.strike_date, legs, m.field, Boolean(m.legs));
}

/** The single contract a rule watches, as one leg with no side. */
const single = (type: string, strike: number | null): Leg[] => (strike === null ? [] : [{ option_type: type, strike }]);

/** Everything the palette can find, in the order the desk draws it. */
export function findables(placed: BookModel): Findable[] {
  const all = [
    ...tableRows(placed).map(ofRow),
    ...placed.muted.map((m) => ofMonitor(m, m.disabled_reason === "expired" ? "expired rule" : "muted rule")),
  ];
  // once each: a rule on a condor held as two spreads is drawn under both, and is one rule to find
  // (found by the page walk's palette, review of #420)
  return all.filter((f, i) => all.findIndex((g) => g.ref === f.ref) === i);
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

type ActionKey =
  | "add" | "edit-monitor" | "close-holding" | "save-image" | "copy-text" | "arrange-desk" | "arrange-phone" | "arrange-auto";

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
 *  selection is not what they act on: a holding is not a rule, nor a rule a holding. */
export function paletteActions(s: {
  choice: ArrangementChoice; selected: DeskRow | null;
  /** what holds the desk (`holdOnDesk`): a form whose draft a jump or another form would discard */
  hold?: Hold;
  /** whether "by the screen's width" would make this screen the phone, which unmounts the desk */
  autoIsPhone?: boolean;
}): PaletteAction[] {
  const kind = s.selected?.kind ?? null;
  const name = s.selected ? rowName(s.selected) : "";
  // a holding's own rule is drawn on its row (2026-11-17): selecting the holding selects it too
  const own = s.selected?.kind === "holding" ? ownRule(s.selected.holding, s.selected.rules) : null;
  const isMonitor = kind === "rule" || kind === "quarantined" || own !== null;
  const hold = s.hold ?? null;
  // a form action is fine while ITS form is the one open: that is landing on it again
  const held = (mine: Hold) => (hold !== null && hold !== mine ? HOLD_WHY : null);
  const out: Omit<PaletteAction, "words">[] = [
    { key: "add", label: "Add a spread or contract", detail: "", why: null },
    {
      key: "edit-monitor", label: "Edit the selected rule", detail: isMonitor ? name : "",
      why: kind === null ? "nothing is selected"
        : kind === "holding" && own === null ? "a holding is selected: select one of its rules" : held("edit"),
    },
    {
      key: "close-holding", label: "Close the selected holding", detail: kind === "holding" ? name : "",
      why: kind === null ? "nothing is selected"
        : kind === "holding" ? held("close") : "a rule is selected, not a holding",
    },
    // the header's "save as image" (#300): a picture of the view, which changes nothing in it; and
    // beside it the same table as Markdown on the clipboard (#394)
    { key: "save-image", label: "Save the view as an image", detail: "", why: null },
    { key: "copy-text", label: "Copy the view as text", detail: "", why: null },
    // the desk's own arrangement does not take the desk down, so it waits for no form; the phone's does
    ...ARRANGEMENTS.map(([key, choice, label]) => ({
      key, label, detail: s.choice === choice ? "in use" : "",
      why: hold !== null && (choice === "phone" || (choice === "auto" && s.autoIsPhone)) ? HOLD_WHY : null,
    })),
  ];
  return out.map((a) => ({
    ...a, words: [...tokens(`${a.label} ${a.detail}`), ...(a.key === "edit-monitor" ? ["monitor"] : [])],
  }));
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
