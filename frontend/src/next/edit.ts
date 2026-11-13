/** Editing a Monitor in place (#292): what a draft is, what it sends, and where a refusal is said.
 *  Pure, so the jsdom suite can hold it without drawing anything; `MonitorEdit.tsx` draws it.
 *
 *  The service judges every change. The only thing decided here is that a threshold is a number at
 *  all — a draft that is not one has nothing to send — and the refusals the service words (a signed
 *  0, a combo on IV, a duplicate) are its own, filed beside the field they are about.
 */
import type { Entry, Holding, Monitor } from "../api";
import { contractCode, type OptionType, type Side, type SpreadsBody } from "./add";
import { contractBody, contractName, contractReplaces, type ContractSpot } from "./contract";
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
  /** how it covers what it is linked to: "all" for whole holdings (CONTEXT.md: Scope) */
  scope: string | null;
  /** the holdings it is linked to, as the service links them */
  holdings: { id: string; name: string }[];
  /** whether an open holding holds any of its Contracts — `/quotes` says so, `/monitors` does not,
   *  so null there rather than a guess */
  held: boolean | null;
}

/** `/quotes` serves only the rules that are on. */
export function ruleOfEntry(e: Entry): Rule {
  return {
    id: e.id, name: entryName(e), code: e.code, field: e.field, direction: e.direction,
    compare: e.compare, threshold: e.threshold, combo: Boolean(e.legs), enabled: true,
    disabled_reason: null, strike_date: e.strike_date, scope: e.scope, holdings: e.positions, held: e.held,
  };
}

export function ruleOfMonitor(m: Monitor): Rule {
  return {
    id: m.id, name: monitorName(m), code: m.code, field: m.field, direction: m.direction,
    compare: m.compare, threshold: m.threshold, combo: Boolean(m.legs), enabled: m.enabled,
    disabled_reason: m.disabled_reason, strike_date: m.strike_date, scope: m.scope, holdings: m.positions,
    held: null,
  };
}

/** How a rule is named on every control about it: two rules on one contract differ by their field. */
export const ruleLabel = (r: Rule) => `${r.name} ${fieldWords(r.field, r.combo)}`;

/** The draft holds the threshold as TYPED, so "0." and "-" survive between keystrokes. */
export interface Draft {
  /** a combo's name as typed (#336); a single contract's code is its contract's, and never sent */
  name: string;
  field: string;
  direction: string;
  compare: string;
  threshold: string;
}

export const draftOf = (r: Rule): Draft =>
  ({ name: r.code, field: r.field, direction: r.direction, compare: r.compare, threshold: String(r.threshold) });

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
  /** a combo's only: its name IS its code (#336) */
  name?: string;
  field?: string;
  direction?: "above" | "below";
  compare?: "abs" | "signed";
  threshold?: number;
  enabled?: boolean;
}

/** Where a refusal is said: beside the field it is about, or by the save button. */
export type Spot = "name" | "field" | "direction" | "compare" | "threshold" | "form";

const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** The change a draft makes — only the keys that changed, or null for none — or why it cannot be
 *  sent. An absent key is "leave it" to the route, so an unchanged field is never re-sent. */
export function patchOf(r: Rule, d: Draft): { body: PatchBody | null } | { error: string; at: Spot } {
  // the route takes ANY string as a name, a blank one included, and a combo named "" is a row
  // nobody can find again: refused here, before asking
  const name = d.name.trim();
  if (r.combo && name === "") return { error: "type a name", at: "name" };
  const typed = d.threshold.trim();
  if (typed === "") return { error: "type a threshold", at: "threshold" };
  // a plain decimal only — a sign, digits, a fraction: Number() also reads "0x10" as 16, "1e-2" as
  // 0.01 and "Infinity", none of which is a threshold anybody typed on purpose
  if (!PLAIN.test(typed)) return { error: "the threshold is not a number", at: "threshold" };
  const threshold = Number(typed);
  const body: PatchBody = {};
  if (r.combo && name !== r.code) body.name = name;
  if (d.field !== r.field) body.field = d.field;
  if (d.direction !== r.direction) body.direction = d.direction as PatchBody["direction"];
  if (d.compare !== r.compare) body.compare = d.compare as PatchBody["compare"];
  if (threshold !== r.threshold) body.threshold = threshold;
  return { body: Object.keys(body).length === 0 ? null : body };
}

/** The field a refusal from the service is about, read from its words (`monitors.ts`'s PATCH):
 *  the threshold's two faults, the two refusals of a name, and the two of what the rule watches.
 *  Anything else — a rule gone, a service down — is said by the save button.
 *
 *  A taken name and a taken field are the same sentence, `monitor for (CODE, FIELD) already
 *  exists`. The route checks the name first, against the rule's OWN field, so that sentence about
 *  the name sent and the field as saved is the name's; one naming a new field is the field's. */
export function spotOf(message: string, sent?: PatchBody, r?: Rule): Spot {
  if (/can be renamed/.test(message)) return "name";
  if (sent?.name !== undefined && r && message === `monitor for (${sent.name}, ${r.field}) already exists`) {
    return "name";
  }
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

/** What a rename does NOT do, said where the name is typed: the service renames the Monitor and
 *  nothing else (`PATCH /monitors/{id}`), and `PATCH /positions/{id}` takes no name at all, so a
 *  holding recorded under the same name — as #293 records a held spread's — keeps it. Null for a
 *  combo no holding is linked to. */
export function renameNote(r: Rule): string | null {
  if (!r.combo || r.holdings.length === 0) return null;
  const names = r.holdings.map((h) => h.name);
  const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  return names.length === 1
    ? `Renames this Monitor only: the holding ${listed} keeps its name — the service never renames a holding.`
    : `Renames this Monitor only: the holdings ${listed} keep their names — the service never renames a holding.`;
}

// ---- splitting a total entry (#336), through `POST /monitors/{id}/total-entry`

/** Offered on a rule covering more than one WHOLE holding, as today's page offers the total: a
 *  rule over one holding has that holding's own Entry, edited on the holding (#294), and a rule over
 *  part of one has none — its figure would be a fraction of someone else's credit. */
export const splitOffered = (r: Rule) => r.scope === "all" && r.holdings.length > 1;

/** A total as typed: a plain decimal, signed as an Entry is — received positive, paid negative. */
export function totalOf(text: string): { entry: number } | { error: string } {
  const t = text.trim().replace(/^\u2212/, "-");
  if (t === "") return { error: "type the total entry" };
  if (!PLAIN.test(t)) return { error: "the total entry is not a number" };
  return { entry: Number(t) };
}

export interface SplitRow {
  id: string;
  name: string;
  /** its Entry as the page last read it; undefined where the page has not read it */
  now: number | null | undefined;
  /** what the split leaves it: the same, or for the one the split derives, the rest */
  after: number | null | undefined;
  /** the one holding the split writes */
  derived: boolean;
}

/** What each holding gets, worked out as the service works it (`applyTotalEntry`), and why the
 *  service would refuse, in its words. The route writes ONE holding: the only one that no rule
 *  watches alone (a rule of scope "all" linked to it and nothing else), which takes the total less
 *  the others' Entries. The preview says what the service will do; the service still decides.
 *
 *  @param total null while nothing is typed
 *  @param holdings the page's valued holdings, or null where it has none */
export function splitPreview(
  r: Rule, total: number | null, monitors: Monitor[], holdings: Holding[] | null,
): { rows: SplitRow[]; why: string | null } {
  const solely = new Set(monitors.filter((m) => m.scope === "all" && m.positions.length === 1)
    .map((m) => m.positions[0]!.id));
  const targets = r.holdings.filter((h) => !solely.has(h.id));
  const entryOf = (id: string): number | null | undefined => holdings?.find((h) => h.id === id)?.entry;
  const target = targets.length === 1 ? targets[0]! : null;
  const others = r.holdings.filter((h) => h.id !== target?.id).map((h) => entryOf(h.id));
  const why = targets.length === 0 ? "every wing here has a rule of its own — set them individually"
    : targets.length > 1 ? `cannot split a total across ${targets.length} wings that have no rule of their own`
      : others.some((e) => e === null) ? "set the other wings' credits first" : null;
  const known = others.every((e) => typeof e === "number");
  const rest = known ? (others as number[]).reduce((a, b) => a + b, 0) : null;
  return {
    why,
    rows: r.holdings.map((h) => {
      const now = entryOf(h.id);
      const derived = h.id === target?.id;
      if (!derived) return { id: h.id, name: h.name, now, after: now, derived };
      // `round4`: to four places, as the service stores a derived figure
      const after = why === null && total !== null && rest !== null && now !== undefined
        ? Number((total - rest).toFixed(4)) : undefined;
      return { id: h.id, name: h.name, now, after, derived };
    }),
  };
}

// ---- recording a holding of a watched contract (#336), through `POST /spreads`

/** The Contract a single-leg rule watches, read back from its code as the service builds it
 *  (`contractCode`), or null for a combo's name. */
export function contractOfCode(code: string): { option_type: OptionType; strike: number } | null {
  const m = /^US\.SPXW\d{6}([CP])(\d+)000$/.exec(code);
  return m ? { option_type: m[1] === "C" ? "CALL" : "PUT", strike: Number(m[2]) } : null;
}

/** Offered on a single contract nothing holds and that is on — the WATCH rule the owner has now
 *  bought or sold. A spread is #293's: added again as held, it replaces its watch rule. A contract
 *  already held is someone else's leg, and `/monitors` says nothing of holding, so a rule switched
 *  off is not offered it rather than guessed at. */
export const holdOffered = (r: Rule) =>
  !r.combo && r.enabled && r.held === false && contractOfCode(r.code) !== null;

export interface HoldDraft {
  side: Side;
  /** as typed, unsigned: what was received (short) or paid (long), per contract */
  entry: string;
  contracts: string;
  /** a New York trading day */
  opened: string;
  name: string;
}

/** A short, opened today, named as the add form names one contract (`contractName`). */
export function holdDraft(r: Rule, today: string): HoldDraft {
  const c = contractOfCode(r.code)!;
  return { side: "short", entry: "", contracts: "1", opened: today, name: contractName(r.strike_date, c.option_type, c.strike) };
}

/** The holding, as the add form's one-contract draft would post it (`contractBody`): a spread of
 *  one leg, held, carrying THIS rule as it is saved — its field, direction, compare and threshold —
 *  so the route replaces the watch rule with the holding's own, in one transaction, linked to the
 *  new holding alone (#322, #340). Its refusals are that form's, at the same boxes. */
export function holdBody(r: Rule, d: HoldDraft, today: string): { body: SpreadsBody } | { error: string; at: ContractSpot } {
  const c = contractOfCode(r.code)!;
  return contractBody({
    held: true, rule: true, expiry: r.strike_date, opened: d.opened, option_type: c.option_type,
    strike: String(c.strike), field: r.field, direction: r.direction as "above" | "below",
    compare: r.compare as "abs" | "signed", threshold: String(r.threshold), side: d.side, entry: d.entry,
    contracts: d.contracts, name: d.name,
  }, today);
}

/** The watch rules a save replaces, in the add form's words: this rule, read from `/monitors`. */
export function holdReplaces(r: Rule, monitors: Monitor[]): string[] {
  const c = contractOfCode(r.code);
  if (!c) return [];
  const code = contractCode(r.strike_date, c.option_type, c.strike);
  return code === r.code ? contractReplaces({
    held: true, rule: true, expiry: r.strike_date, opened: "", option_type: c.option_type,
    strike: String(c.strike), field: r.field, direction: "above", compare: "abs", threshold: "",
    side: "short", entry: "", contracts: "1", name: "",
  }, monitors) : [];
}
