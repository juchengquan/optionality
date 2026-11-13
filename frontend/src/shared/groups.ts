/** The groups a disabled rule is shown under, by its `disabled_reason` (ADR 0023): the book's
 *  muted section and a holding's detail. */

/** Most alarming first: the two Quarantines — the service's own doing, where a rule cannot be
 *  evaluated at all — then expiry, then the rules you muted yourself.
 *
 *  Held by `Groups.test.ts` against the backend's `DISABLED_REASONS`. A reason
 *  with no group here renders in NO group, so the row would disappear from the page while sitting
 *  disabled in the database (#167).
 */
export const GROUPS: [string | null, string][] = [
  ["unknown-contract", "Unknown contract"],
  ["no-figure", "Figure never arrived"],
  ["unreadable", "Could not be read"],
  ["expired", "Expired"],
  // switched off by closing the holding they watched (ADR 0022): the owner's doing, so beside the
  // rules muted by hand rather than among the faults
  ["holding-closed", "Holding closed"],
  ["manual", "Muted by you"],
  [null, "Reason not recorded"],
];
