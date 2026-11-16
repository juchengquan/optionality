/** The page's words for a figure, one set for the desk, the phone and the saved picture (the owner's
 *  standard of 2026-11-16, ADR 0023).
 *
 *  Δ is said three ways, by what it is the delta OF, and the same way wherever it is said:
 *  - `short Δ` on a holding: its short leg's delta — the figure the owner manages a credit spread by;
 *  - `Δ` on a spread or a contract: the rule's own, a spread's summed under its legs' signs;
 *  - `position Δ` for a holding's net delta, beside its other net greeks.
 *
 *  The greeks are their symbols, written literally — Δ Γ Θ ν — and a label carrying one is never
 *  set in capitals by CSS: an upper-case ν is "Ν", which reads as the letter N (`NumberFormat` and
 *  `GreekLabels` tests).
 */

export const SHORT_DELTA = "short Δ";

/** A holding's net greeks, in the order every list of them gives: field, label. */
export const POSITION_GREEKS: readonly (readonly [string, string])[] = [
  ["option_delta", "position Δ"],
  ["option_gamma", "position Γ"],
  ["option_theta", "position Θ"],
  ["option_vega", "position ν"],
];
