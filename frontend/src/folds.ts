/** The book's expiry groups, folded by the viewer (the owner, 2026-11-21), on the desk and the phone
 *  alike. Each expiry's heading inside Spreads and Contracts folds that group's rows; the sections
 *  themselves never fold.
 *
 *  - **What is folded is the viewer's**, remembered in a cookie (`readFolded`), keyed by the
 *    section AND the expiry — 20261218 folded under Spreads stays open under Contracts — and every
 *    group starts open. A press writes to the cookie as it stands NOW, as the column picker does:
 *    another tab may have folded something since this one read it.
 *  - **An expiry no longer in the book drops out** of the cookie when it is next written — but only
 *    while the holdings are valued: before then the book drawn is missing its held rows, and a group
 *    of holdings alone would be dropped while it is merely not yet drawn.
 *  - **A folded group never reopens by itself**, not when a rule in it rings: its heading says how
 *    many rows it holds and what in it needs the owner, in the chips' own words (`foldedSummary`).
 *  - **The saved picture and "Copy as text" draw every row**: they are built from the book, never
 *    from the screen (`snapshot/plain.ts`), so nothing here reaches them.
 */
import { useCallback, useState } from "react";

import { attentionOf, ATTENTION_WORDS, groupRows, ownAttentionOf } from "./desk/columns";
import { ORDER, type NeedKind } from "./needs";
import type { BookModel, BookSection, ExpiryBook } from "./placement";
import { readFolded, writeFolded } from "./shared/prefs";
import { writtenDate } from "./shared/times";

export type SectionKind = BookSection["kind"];

/** "spreads:20261218": a group as the cookie names it. */
export const foldKey = (kind: SectionKind, expiry: string): string => `${kind}:${writtenDate(expiry)}`;

/** Every group the book draws now, as the cookie names them. */
export function groupsOf(placed: BookModel): Set<string> {
  return new Set(placed.sections.flatMap((s) => s.expiries.map((g) => foldKey(s.kind, g.expiry))));
}

/** The folds after `key` is pressed, from the folds as stored NOW: the key flipped, and — given the
 *  groups the book draws — every fold the book no longer has dropped. */
export function pressed(stored: ReadonlySet<string>, key: string, drawn: ReadonlySet<string> | null): Set<string> {
  const next = new Set(stored);
  if (next.has(key)) next.delete(key); else next.add(key);
  return drawn === null ? next : new Set([...next].filter((k) => drawn.has(k)));
}

/** A count of one of the kinds of attention, as a folded heading draws it: the chip's own words. */
export interface FoldedNeed {
  kind: NeedKind;
  count: number;
  words: string;
}

/** A count's words in the plural where the chip's word takes one; "ringing", "at stop", "at target"
 *  and "manage-by" say two as they say one. */
const PLURAL: Partial<Record<NeedKind, string>> = { fault: "faults", entry: "entry signals" };

const counted = (kind: NeedKind, count: number) => `${count} ${count === 1 ? ATTENTION_WORDS[kind] : PLURAL[kind] ?? ATTENTION_WORDS[kind]}`;

/** What a folded group's heading adds to its date and DTE: its rows, as the desk's table draws them
 *  (each holding, each rule under one, each watched spread or contract — one count on both
 *  arrangements), and every chip those rows carry, counted by kind in the needs-you line's order. */
export function foldedSummary(g: ExpiryBook): { rows: string; needs: FoldedNeed[] } {
  const rows = groupRows(g);
  const kinds: NeedKind[] = rows.flatMap((r) => [attentionOf(r), ownAttentionOf(r)])
    .filter((k): k is NeedKind => k !== null);
  const needs = ORDER.map((kind) => ({ kind, count: kinds.filter((k) => k === kind).length }))
    .filter((n) => n.count > 0)
    .map((n) => ({ ...n, words: counted(n.kind, n.count) }));
  return { rows: `${rows.length} ${rows.length === 1 ? "row" : "rows"}`, needs };
}

/** Which groups are folded, and a press. `complete`: the holdings are valued, so the book drawn is
 *  the whole book and a fold it no longer draws may be dropped. */
export function useFolds(placed: BookModel, complete: boolean): {
  folded: (kind: SectionKind, expiry: string) => boolean;
  toggle: (kind: SectionKind, expiry: string) => void;
} {
  const [folds, setFolds] = useState(() => readFolded());
  const toggle = useCallback((kind: SectionKind, expiry: string) => {
    const next = pressed(readFolded(), foldKey(kind, expiry), complete ? groupsOf(placed) : null);
    writeFolded(next);
    setFolds(next);
  }, [placed, complete]);
  const folded = useCallback((kind: SectionKind, expiry: string) => folds.has(foldKey(kind, expiry)), [folds]);
  return { folded, toggle };
}
