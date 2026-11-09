/** What a row SAYS, as text — the readers each column's own `text` is built from.
 *
 *  There used to be one `cellValue(entry, key, isCombo)` here, a `switch` over column keys with
 *  three callers: the table draws these cells, the detail sheet lists every column whether or not
 *  the table has room for it (ADR 0008), and the column fitting asks how wide each column needs to
 *  be. One function so that the three could not drift — but the arm was a FOURTH place a column key
 *  had to be written down, and the `default` arm it needed answered a key nobody had written with a
 *  dash, for ever, in the detail sheet. A column's text sits on the column now (`columns.ts`), so
 *  the three callers reach it through the descriptor they already hold and the switch is gone.
 *
 *  What stays here is why this module exists at all. It lived in `WatchlistTable.tsx` and was
 *  imported from there, which put a component module on the measuring path: `useTableFit` runs on
 *  every poll, for both tables, and again on every resize, and it reached one `switch` through a
 *  React tree's worth of module. `columns.ts` dodged that by taking the function as an ARGUMENT
 *  instead, so the workaround was visible in `widthsFromContent`'s signature and every caller had
 *  to carry it. Nothing here renders anything, so nothing here needs React — and `columns.ts`,
 *  which now holds the text, needs none either. `__tests__/Modules.test.ts` holds both.
 */
import type { Entry } from "./api";
import { fmt } from "./format";

/** One greek: the combo's signed sum, or a single leg's own quote.
 *
 *  Which one it is is the whole reason every `text` takes `isCombo`. A combo's greeks are signed
 *  sums under the user's leg signs and never come from a quote, and IV is never summed at all —
 *  so there is no column where reading the wrong source would merely be imprecise.
 */
export function greekText(entry: Entry, isCombo: boolean, name: string, column: string): string {
  if (isCombo) return fmt(entry.combo_greeks?.[name] ?? null, column);
  const quote = entry.quote ?? {};
  return fmt(quote[name as keyof typeof quote] as number | null, column);
}

/** One figure from the contract's own quote — the single-leg table's prices and its IV. */
export function quoteText(entry: Entry, name: string, column: string): string {
  const quote = entry.quote ?? {};
  return fmt((quote[name as keyof typeof quote] as number | null) ?? null, column);
}

/** A figure that belongs to a HOLDING, blank where the rule covers none.
 *
 *  Blank rather than a dash: a rule watching part of someone else's structure has no entry and no
 *  P&L of its own — that figure would be a fraction of their credit (ADR 0003) — and a dash would
 *  read as "the figure has not arrived".
 */
export function heldText(entry: Entry, value: number | null | undefined): string {
  return entry.scope === "all" ? fmt(value ?? null, "mid") : "";
}
