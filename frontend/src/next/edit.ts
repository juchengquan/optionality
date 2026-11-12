/** Editing a Monitor in place (#292): what a draft is, what it sends, and where a refusal is said.
 *  Pure, so the jsdom suite can hold it without drawing anything; `MonitorEdit.tsx` draws it.
 *
 *  The service judges every change. The only thing decided here is that a threshold is a number at
 *  all — a draft that is not one has nothing to send — and the refusals the service words (a signed
 *  0, a combo on IV, a duplicate) are its own, filed beside the field they are about.
 */
import type { Entry, Monitor } from "../api";
import { entryName, fieldWords, monitorName, ruleWords } from "./needs";

/** A rule as the editor needs it, from either door: a row of `/quotes` (on, with figures) or of
 *  `/monitors` (any state, no figures). */
export interface Rule {
  id: string;
  /** what the page calls it: the combo's name, or the contract */
  name: string;
  code: string;
  field: string;
  direction: string;
  compare: string;
  threshold: number;
  combo: boolean;
  enabled: boolean;
  disabled_reason: string | null;
  strike_date: string;
}

/** `/quotes` serves only the rules that are on. */
export function ruleOfEntry(e: Entry): Rule {
  return {
    id: e.id, name: entryName(e), code: e.code, field: e.field, direction: e.direction,
    compare: e.compare, threshold: e.threshold, combo: Boolean(e.legs), enabled: true,
    disabled_reason: null, strike_date: e.strike_date,
  };
}

export function ruleOfMonitor(m: Monitor): Rule {
  return {
    id: m.id, name: monitorName(m), code: m.code, field: m.field, direction: m.direction,
    compare: m.compare, threshold: m.threshold, combo: Boolean(m.legs), enabled: m.enabled,
    disabled_reason: m.disabled_reason, strike_date: m.strike_date,
  };
}

/** How a rule is named on every control about it: two rules on one contract differ by their field. */
export const ruleLabel = (r: Rule) => `${r.name} ${fieldWords(r.field, r.combo)}`;

/** The draft holds the threshold as TYPED, so "0." and "-" survive between keystrokes. */
export interface Draft {
  field: string;
  direction: string;
  compare: string;
  threshold: string;
}

export const draftOf = (r: Rule): Draft =>
  ({ field: r.field, direction: r.direction, compare: r.compare, threshold: String(r.threshold) });

/** The figures a rule may watch, as `/opt`'s add forms offer them. A combo is a signed sum of its
 *  legs, and IV is intensive — two 20% legs are not a 40% spread — so a combo is never offered it
 *  (CLAUDE.md: Combos; the route refuses it too). A field this list does not know, on a row made
 *  some other way, is kept so the select can still say what the rule watches. */
const FIELDS = [
  "option_delta", "mid_price", "option_implied_volatility", "option_theta", "option_vega", "option_gamma",
];

export function fieldsFor(r: Rule): string[] {
  const offered = r.combo ? FIELDS.filter((f) => f !== "option_implied_volatility") : FIELDS;
  return offered.includes(r.field) ? offered : [r.field, ...offered];
}

/** What `PATCH /monitors/{id}` takes, as `MonitorPatch` in `backend/schemas` declares it. */
export interface PatchBody {
  field?: string;
  direction?: "above" | "below";
  compare?: "abs" | "signed";
  threshold?: number;
  enabled?: boolean;
}

/** Where a refusal is said: beside the field it is about, or by the save button. */
export type Spot = "field" | "direction" | "compare" | "threshold" | "form";

/** The change a draft makes — only the keys that changed, or null for none — or why it cannot be
 *  sent. An absent key is "leave it" to the route, so an unchanged field is never re-sent. */
export function patchOf(r: Rule, d: Draft): { body: PatchBody | null } | { error: string; at: Spot } {
  const typed = d.threshold.trim();
  if (typed === "") return { error: "type a threshold", at: "threshold" };
  const threshold = Number(typed);
  if (!Number.isFinite(threshold)) return { error: "the threshold is not a number", at: "threshold" };
  const body: PatchBody = {};
  if (d.field !== r.field) body.field = d.field;
  if (d.direction !== r.direction) body.direction = d.direction as PatchBody["direction"];
  if (d.compare !== r.compare) body.compare = d.compare as PatchBody["compare"];
  if (threshold !== r.threshold) body.threshold = threshold;
  return { body: Object.keys(body).length === 0 ? null : body };
}

/** The field a refusal from the service is about, read from its words (`monitors.ts`'s PATCH):
 *  the threshold's two faults, and the two refusals of what the rule watches. Anything else — a
 *  rule gone, a service down — is said by the save button. */
export function spotOf(message: string): Spot {
  if (/threshold/i.test(message)) return "threshold";
  if (/cannot watch|already exists/i.test(message)) return "field";
  return "form";
}

/** The draft in words, as the sentence beside a rule words it (`needs.ts`'s `ruleWords`). */
export const draftWords = (r: Rule, d: Draft) =>
  ruleWords(d.field, r.combo, d.compare, d.direction, d.threshold.trim() || "…");

/** The day the sweep deletes an expired rule: it removes one whose expiry is before today less the
 *  retention window (`expiryVerdict`), so the first day it is gone is the expiry plus the window
 *  plus one. Market dates, counted as dates. */
export function deletesOn(strikeDate: string, retentionDays: number): string {
  const d = new Date(`${strikeDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + retentionDays + 1);
  return d.toISOString().slice(0, 10);
}

/** Which of the four a rule is in, for what may be done to it. */
export type RuleState = "on" | "muted" | "quarantined" | "expired";

/** @param today the sweep's day, the UTC date (`sweeper.ts`'s `utcDate`): a rule is past its
 *  expiry from the day after it, and the sweep deletes ANY rule past it once the retention window
 *  is behind it, on or off and whatever switched it off (`expiryVerdict`). So a rule past its expiry
 *  is expired here whatever its reason says — a quarantine or a closed holding included — and is
 *  offered nothing that would switch it back on. */
export function stateOf(r: Rule, today: string): RuleState {
  if (r.strike_date < today || r.disabled_reason === "expired") return "expired";
  if (r.enabled) return "on";
  return r.disabled_reason !== null && r.disabled_reason in QUARANTINE_WHY ? "quarantined" : "muted";
}

/** A quarantine in full: what the service found, and what would fix it. The short words are the
 *  needs-you line's (`needs.ts`'s `QUARANTINED`); these are said before switching one back on. */
export const QUARANTINE_WHY: Record<string, (r: Rule) => string> = {
  "unknown-contract": (r) =>
    `the provider does not know its contract ${r.code}: its strike or its expiry is not one it lists`,
  "no-figure": (r) =>
    `its ${fieldWords(r.field, r.combo)} never arrived, sweep after sweep: what a provider serves depends on the account, so watch a figure it does serve`,
  unreadable: () =>
    "its stored row cannot be read: a leg or an expiry the service cannot make sense of",
};
