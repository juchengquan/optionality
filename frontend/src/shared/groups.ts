/** Why a rule is off, in ONE set of words (the owner's standard of 2026-11-16, part I; ADR 0023):
 *  the desk's muted fold, its quarantined rows, the phone's switched-off cards, the needs-you line,
 *  a closed holding's account of its rules and the saved picture all read them here, so a rule
 *  muted by hand cannot be "muted by you" on the desk and "muted by hand" on the phone.
 *
 *  Each reason has a LABEL, the few words a list or a group says it in — "muted by you" — and a WHY,
 *  the clause a sentence about the rule ends in: "AAPL quarantined — its figure never arrives".
 *  Labels are written lower case, as a figure's label is; a heading made of one takes its capital
 *  where it is drawn (`headingOf`).
 *
 *  Most alarming first: the three Quarantines — the service's own doing, where a rule cannot be
 *  evaluated at all — then expiry, then a holding's close, then the rules you muted yourself.
 *
 *  Held by `Groups.test.ts` against the backend's `DISABLED_REASONS`. A reason with no entry here
 *  renders in NO group, so the row would disappear from the page while sitting disabled in the
 *  database (#167).
 */
export interface Reason {
  reason: string | null;
  /** switched off by the service because it cannot evaluate the rule (CONTEXT.md: Quarantine) */
  quarantine: boolean;
  label: string;
  why: string;
}

export const REASONS: readonly Reason[] = [
  { reason: "unknown-contract", quarantine: true, label: "unknown contract", why: "the provider does not know its contract" },
  { reason: "no-figure", quarantine: true, label: "figure never arrived", why: "its figure never arrives" },
  { reason: "unreadable", quarantine: true, label: "could not be read", why: "its stored row cannot be read" },
  { reason: "expired", quarantine: false, label: "expired", why: "its expiry has passed" },
  // switched off by closing the holding they watched (ADR 0022): the owner's doing, so beside the
  // rules muted by hand rather than among the faults
  { reason: "holding-closed", quarantine: false, label: "holding closed", why: "its holding closed" },
  { reason: "manual", quarantine: false, label: "muted by you", why: "you muted it" },
  { reason: null, quarantine: false, label: "reason not recorded", why: "no reason was recorded" },
];

const byReason = new Map(REASONS.map((r) => [r.reason, r]));

/** The label for a reason; a reason this page does not know, as the service wrote it. */
export function reasonLabel(reason: string | null | undefined): string {
  return byReason.get(reason ?? null)?.label ?? String(reason);
}

/** The clause for a reason; a reason this page does not know, as the service wrote it. */
export function reasonWhy(reason: string | null | undefined): string {
  return byReason.get(reason ?? null)?.why ?? String(reason);
}

/** Whether a reason is a Quarantine. */
export function isQuarantine(reason: string | null | undefined): boolean {
  return byReason.get(reason ?? null)?.quarantine ?? false;
}

/** A label as a heading: its first letter a capital, the rest as written (part H). */
export const headingOf = (label: string): string => label.charAt(0).toUpperCase() + label.slice(1);

/** The groups, in order, each a reason and its heading — the picture's muted sections. */
export const GROUPS: [string | null, string][] = REASONS.map((r) => [r.reason, headingOf(r.label)]);
