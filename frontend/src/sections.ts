/** The ONE order a holding's or a rule's detail is drawn in, on the desk's inspector and the phone's
 *  sheet alike (the owner's standard of 2026-11-16, part J; ADR 0023).
 *
 *  Both surfaces draw `DetailSections.tsx` from these lists, each section marked `data-section`
 *  with its key, and `NextDetailOrder.test.tsx` holds both drawings to the list and to each other:
 *  a section moved on one surface and not the other is a test failing, not a page that reads two
 *  ways. A surface may leave a section out where it has nothing to draw (a holding with no schedule
 *  has no pace explained), but never draws one out of this order.
 */

/** A holding's sections: its P&L and Level first, because that is what it is opened to see; then
 *  what it is (legs, where they stand against SPX, what they pay at expiry); its figures; its exit
 *  schedule and the pace explained; the rules that watch it; what may be done to it; and its
 *  history, longest and read least often, last. */
export const HOLDING_SECTIONS = [
  "level", "legs", "strip", "payoff", "figures", "schedule", "pace", "rules", "actions", "history",
] as const;

/** A rule's: the same shape — its state where a holding has its Level, and its figures opening with
 *  the "watches" line — with no schedule, no pace and no holding actions, since a rule has none. */
export const RULE_SECTIONS = [
  "level", "legs", "strip", "payoff", "figures", "rules", "history",
] as const;

export type HoldingSection = typeof HOLDING_SECTIONS[number];
export type RuleSection = typeof RULE_SECTIONS[number];

/** The headings a section carries where it has one, sentence case (part H), the same on both. */
export const SECTION_HEADINGS: Partial<Record<HoldingSection | RuleSection, string>> = {
  schedule: "Exit schedule",
  rules: "Rules",
};
