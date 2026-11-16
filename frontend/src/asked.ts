/** What a holding's once-read figures — its payoff (`Payoff.tsx`), its samples (`History.tsx`) and
 *  its pace split (`PaceExplained.tsx`) — were read FOR: the holding, and every stored fact the
 *  service works them from. Its Entry, its count and Opened, which an Edit changes, and its legs
 *  with their quantities, which a correction changes (#359) — whose stamp, `qty_corrected_at`, the
 *  valuation does not carry, so the corrected legs themselves stand for it.
 *
 *  Each is asked again when this changes, and only then: a poll's new valuation of the same
 *  holding is a new object with the same facts, and asks nothing. Keyed on the id alone, a
 *  correction left the payoff drawing the old curve until the page was reloaded. */
export function askedFor(h: {
  id: string; contracts: number; legs: readonly unknown[]; entry?: number | null; opened_at?: string | null;
}): string {
  return JSON.stringify([h.id, h.entry ?? null, h.contracts, h.opened_at ?? null, h.legs]);
}
