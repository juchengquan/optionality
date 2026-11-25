/** The book's expiry groups, folded by the viewer (the owner, 2026-11-21), on the desk and the phone
 *  alike. Each expiry's heading inside Spreads and Contracts folds that group's rows; the sections
 *  themselves never fold.
 *
 *  - **What is folded is the viewer's**, remembered in a cookie (`readFolded`), keyed by the
 *    section AND the expiry — 20261218 folded under Spreads stays open under Contracts — and every
 *    group starts open. A press writes to the cookie as it stands NOW, as the column picker does:
 *    another tab may have folded something since this one read it, and its folds are kept.
 *  - **An expiry no longer in the book drops out** of the cookie when it is next written — but only
 *    while the holdings are valued and the watchlist was read: before then the book drawn is missing
 *    its held rows or its watched ones — through a Provider outage out of the session the holdings
 *    are drawn from their closes while `/quotes` fails — and a group of either alone would be dropped
 *    while it is merely not drawn.
 *  - **A press folds or opens what THIS tab shows**, applied to the cookie as it stands: another tab
 *    may have opened the very group this one still shows folded, and a flip of the cookie would then
 *    leave it folded here.
 *  - **A folded group never reopens by itself**, not when a rule in it rings: its heading says how
 *    many rows (on the phone, cards) it holds and what in it needs the owner, in the chips' own words
 *    (`foldedSummary`). Only a jump to one of its rows opens it — a banner's tap, the palette, the
 *    price map — written as a press on its heading (`unfold.ts`).
 *  - **The saved picture and "Copy as text" draw every row**: they are built from the book, never
 *    from the screen (`snapshot/plain.ts`), so nothing here reaches them.
 */
import { useCallback, useState } from "react";

import { attentionOf, ATTENTION_WORDS, groupRows, ownAttentionOf } from "./desk/columns";
import { ORDER, type NeedKind } from "./needs";
import type { BookModel, BookSection, ExpiryBook } from "./placement";
import { pressed } from "./shared/folds";
import { readFolded, writeFolded } from "./shared/prefs";
import { writtenDate } from "./shared/times";

export type SectionKind = BookSection["kind"];

/** "spreads:20261218": a group as the cookie names it. */
export const foldKey = (kind: SectionKind, expiry: string): string => `${kind}:${writtenDate(expiry)}`;

/** Every group the book draws now, as the cookie names them. */
export function groupsOf(placed: BookModel): Set<string> {
  return new Set(placed.sections.flatMap((s) => s.expiries.map((g) => foldKey(s.kind, g.expiry))));
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

/** What a folded group's heading adds to its date and DTE: what the arrangement draws of it, counted
 *  (the owner, 2026-11-21) — the desk's rows (each holding, each rule under one, each watched spread
 *  or contract) or the phone's cards (each holding and each watched spread or contract, a holding's
 *  rules lines inside its card) — and every chip those rows carry, the same on both, counted by kind
 *  in the needs-you line's order. */
export function foldedSummary(g: ExpiryBook, counts: "rows" | "cards"): { rows: string; needs: FoldedNeed[] } {
  const rows = groupRows(g);
  const kinds: NeedKind[] = rows.flatMap((r) => [attentionOf(r), ownAttentionOf(r)])
    .filter((k): k is NeedKind => k !== null);
  const needs = ORDER.map((kind) => ({ kind, count: kinds.filter((k) => k === kind).length }))
    .filter((n) => n.count > 0)
    .map((n) => ({ ...n, words: counted(n.kind, n.count) }));
  const n = counts === "rows" ? rows.length : g.held.flat().length + g.spreads.length + g.contracts.length;
  const unit = counts === "rows" ? "row" : "card";
  return { rows: `${n} ${unit}${n === 1 ? "" : "s"}`, needs };
}

/** Which groups are folded, and a press. `complete`: the holdings are valued AND the watchlist was
 *  read, so the book drawn is the whole book and a fold it no longer draws may be dropped. */
export function useFolds(placed: BookModel, complete: boolean): {
  folded: (kind: SectionKind, expiry: string) => boolean;
  toggle: (kind: SectionKind, expiry: string) => void;
} {
  const [folds, setFolds] = useState(() => readFolded());
  const toggle = useCallback((kind: SectionKind, expiry: string) => {
    const key = foldKey(kind, expiry);
    const next = pressed(readFolded(), key, !folds.has(key), complete ? groupsOf(placed) : null);
    writeFolded(next);
    setFolds(next);
  }, [placed, complete, folds]);
  const folded = useCallback((kind: SectionKind, expiry: string) => folds.has(foldKey(kind, expiry)), [folds]);
  return { folded, toggle };
}
