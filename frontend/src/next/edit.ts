/** Editing a Monitor in place (#292): what a draft is, what it sends, and where a refusal is said.
 *  Pure, so the jsdom suite can hold it without drawing anything; `MonitorEdit.tsx` draws it.
 *
 *  The service judges every change. The only thing decided here is that a threshold is a number at
 *  all — a draft that is not one has nothing to send — and the refusals the service words (a signed
 *  0, a combo on IV, a duplicate) are its own, filed beside the field they are about.
 */
import type { Added, Entry, Holding, Monitor } from "../shared/api";
import { contractCode, type OptionType, type Side, type SpreadsBody } from "./add";
import { contractBody, contractName, type ContractSpot } from "./contract";
import { entryName, fieldWords, monitorName, ruleWords } from "./needs";
import { namesUnheldContract } from "./placement";

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
  const sharing = r.combo ? r.holdings.find((h) => h.name === r.code) : undefined;
  return sharing
    ? `Renames this Monitor only: the holding ${sharing.name} keeps its name — the service never renames a holding.`
    : null;
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

/** Whether the holdings a split spans are held in different numbers of contracts, said in words —
 *  the counts named only where privacy is off, since a count times points is the money it hides.
 *  The service adds their per-contract Entries as they are (`applyTotalEntry`), whatever the count. */
export function splitCounts(r: Rule, holdings: Holding[] | null, privacy: boolean): string | null {
  const held = r.holdings.map((h) => holdings?.find((x) => x.id === h.id)).filter((h) => h !== undefined);
  if (new Set(held.map((h) => h.contracts)).size < 2) return null;
  const counts = privacy ? "" : ` (${held.map((h) => `${h.name} ×${h.contracts}`).join(", ")})`;
  return `These holdings are held in different numbers${counts}: the total is per contract, `
    + "and the service adds their Entries as they are, whatever the count.";
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
  const name = contractName(r.strike_date, c.option_type, c.strike);
  return { side: "short", entry: "", contracts: "1", opened: today, name };
}

/** The holding, as the add form's one-contract draft would post it (`contractBody`): a spread of
 *  one leg, held, carrying THIS rule as it is saved — its field, direction, compare and threshold —
 *  so the route replaces the watch rule with the holding's own, in one transaction, linked to the
 *  new holding alone (#322, #340). Its refusals are that form's, at the same boxes. */
export function holdBody(
  r: Rule, d: HoldDraft, today: string,
): { body: SpreadsBody } | { error: string; at: ContractSpot } {
  const c = contractOfCode(r.code)!;
  return contractBody({
    held: true, rule: true, expiry: r.strike_date, opened: d.opened, option_type: c.option_type,
    strike: String(c.strike), field: r.field, direction: r.direction as "above" | "below",
    compare: r.compare as "abs" | "signed", threshold: String(r.threshold), side: d.side, entry: d.entry,
    contracts: d.contracts, name: d.name,
  }, today);
}


/** `name`, or the first of `name-2`, `name-3`… that no holding on record has: a holding's name is
 *  unique across closed ones too, so a closed `1231_C8000` makes the next one `1231_C8000-2`. */
export function uniqueName(name: string, taken: string[]): string {
  const names = new Set(taken);
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name}-${n}`)) n += 1;
  return `${name}-${n}`;
}

/** The Contracts a holding's legs are, as the service codes them. */
const legCodes = (h: Pick<Holding, "strike_date" | "legs">) =>
  h.legs.map((l) => contractCode(h.strike_date, l.option_type as OptionType, l.strike));

/** The Contracts a rule watches (`monitorLegCodes`): its legs, or its one contract. */
const ruleCodes = (m: Monitor) => m.legs
  ? m.legs.map((l) => contractCode(m.strike_date, l.option_type as OptionType, l.strike)) : [m.code];

export interface HoldLinks {
  /** the watch rules the save deletes and makes again as the holding's */
  replaced: Monitor[];
  /** every OTHER rule linked to no holding that the new holding takes, and as what: the whole of
   *  it, or one leg of something larger — and whether the page will then draw it in the Watchlist,
   *  as a combo naming a contract the holdings it is linked to do not hold (`namesUnheldContract`,
   *  #346) */
  linked: { monitor: Monitor; scope: "all" | "leg"; watchlist: boolean }[];
  /** false where the holdings have not been read: which rules it takes depends on all of them */
  known: boolean;
}

/** What recording the holding does to the rules besides its own, worked out as the service works
 *  it, so the form can say it before the save. `POST /spreads` replaces the watch rule on the same
 *  (contract, field), then ADOPTS every rule linked to no holding (`adoptOrphanMonitors`), each by
 *  `positionsHolding` against every open holding, the new one included: a rule whose Contracts any
 *  holding holds twice is linked to nothing; otherwise to every holding holding one of them, as
 *  covering the whole where it watches every leg of each. A watched spread containing the contract
 *  is therefore linked to a lone-contract holding as covering all of it (#336). Held to the backend
 *  by the door scenarios (`NextRuleWritesModel.test.ts`). */
export function holdLinks(
  r: Rule, monitors: Monitor[], holdings: Pick<Holding, "id" | "strike_date" | "legs">[] | null,
): HoldLinks {
  const replaced = monitors.filter((m) => m.code === r.code && m.field === r.field && m.positions.length === 0);
  if (holdings === null) return { replaced, linked: [], known: false };
  const NEW = "\u0000new";
  const owners = new Map<string, string[]>();
  for (const h of [...holdings, { id: NEW, strike_date: r.strike_date, legs: [] }]) {
    const codes = h.id === NEW ? [r.code] : legCodes(h);
    for (const c of codes) owners.set(c, [...(owners.get(c) ?? []), h.id]);
  }
  const gone = new Set(replaced.map((m) => m.id));
  const linked: HoldLinks["linked"] = [];
  for (const m of monitors) {
    if (m.positions.length > 0 || gone.has(m.id)) continue;
    const codes = ruleCodes(m);
    if (codes.some((c) => (owners.get(c)?.length ?? 0) > 1)) continue;
    const found = new Set(codes.flatMap((c) => owners.get(c) ?? []));
    if (!found.has(NEW)) continue;
    const watched = new Set(codes);
    const covered = [...found].every((id) => id === NEW
      ? watched.has(r.code) : legCodes(holdings.find((h) => h.id === id)!).every((c) => watched.has(c)));
    // what each holding it is linked to holds, the new one as the contract the rule is on
    const held = [...found].map((id) => id === NEW
      ? { strike_date: r.strike_date, legs: contractOfCode(r.code) ? [contractOfCode(r.code)!] : [] }
      : holdings.find((h) => h.id === id)!);
    const watchlist = Boolean(m.legs) && namesUnheldContract({ strike_date: m.strike_date, legs: m.legs! }, held);
    linked.push({ monitor: m, scope: covered ? "all" : "leg", watchlist });
  }
  return { replaced, linked, known: true };
}

/** What a recorded holding made, in the toast: the service's answer, and the rules linked to the new
 *  holding as `/monitors` reads AFTER the save — the service's word for what it adopted, never the
 *  preview's. Null for `after` where that read failed. */
export function holdToast(added: Added, after: Monitor[] | null): string {
  const r = added.replaced.length;
  const made = new Set(added.monitors.map((m) => m.id));
  const ids = new Set(added.positions.map((p) => p.id));
  const linked = (after ?? []).filter((m) => !made.has(m.id) && m.positions.some((p) => ids.has(p.id)));
  return `recorded ${added.positions.map((p) => p.name).join(", ")}`
    + (r ? `, replacing ${r} watch rule${r === 1 ? "" : "s"}` : "")
    + (linked.length ? `; also linked to it: ${linked.map((m) => ruleLabel(ruleOfMonitor(m))).join(", ")}` : "");
}
