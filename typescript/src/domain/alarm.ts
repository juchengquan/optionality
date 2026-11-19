/** Whether a reading changes a rule's alarm, and what the owner is told about it.
 *
 *  Lifted out of the middle of `MonitorSweeper.evaluate`, where it was four branches tangled with
 *  a row re-read, a silence count, a transaction and the writes — reachable only by driving a
 *  whole sweep against a database and a fake Provider. The decision itself needs none of those:
 *  the reading, what the database currently says, two knobs and a clock.
 *
 *  In `domain/` since ADR 0017, decisions and their WORDING with them, so the sentence the phone
 *  gets is golden-cased and the Python reproduces it exactly — every rewording is a port. Since
 *  #388 the words are the short form the dashboard writes (`ruleShort`, `figureShort`,
 *  `distanceShort`), and `frontend/src/needs.ts` is held to these cases.
 *
 *  The two kinds of answer are separate on purpose. `triggered` is the state the engine KEEPS and
 *  `notice` is what it SAYS, and they do not move together: inside the cooldown a fresh breach
 *  flips the flag and says nothing, and a persisting breach reminds without the flag changing at
 *  all. Collapsing them is how a throttled alarm re-announces itself on every sweep after — the
 *  flag never got written, so the next sweep sees the breach as fresh again.
 */
import { compactStrikeDate, contractName } from "./contract.ts";
import { isBreached, thresholdDistance, type Monitor } from "./monitor.ts";
import type { Leg } from "./position.ts";

/** What the database says about this rule right now — re-read after the fetch, in the sweep. */
export interface AlarmState {
  triggered: boolean;
  /** when the owner was last told anything about this rule; null if never */
  lastAlarmAt: Date | null;
}

export interface AlarmPolicy {
  /** throttles state-CHANGE messages, so a value sitting on its threshold cannot flap the phone */
  cooldownSeconds: number;
  /** re-reminds about a breach that persists, so one missed message is not the end of it; 0 off */
  repeatSeconds: number;
}

export const alarmPolicy = (
  s: { alarmCooldownSeconds: number; alarmRepeatSeconds: number },
): AlarmPolicy => ({
  cooldownSeconds: s.alarmCooldownSeconds,
  repeatSeconds: s.alarmRepeatSeconds,
});

export interface AlarmDecision {
  /** the flag's new value, or null when this reading does not change it */
  triggered: boolean | null;
  /** what to send, or null for nothing. Non-null is also exactly when the stamp moves. */
  notice: string | null;
}

const UNCHANGED: AlarmDecision = { triggered: null, notice: null };

/** Never alarmed counts as long ago, not as never: a rule whose first breach the cooldown
 *  swallowed has a flag and no stamp, and reading that as "too soon" would silence it for ever. */
function secondsSince(when: Date | null, now: Date): number {
  if (when === null) return Number.POSITIVE_INFINITY;
  return (now.getTime() - when.getTime()) / 1000;
}

export function alarmTransition(
  monitor: Monitor, value: number, name: string,
  state: AlarmState, policy: AlarmPolicy, now: Date,
): AlarmDecision {
  const breached = isBreached(value, monitor.threshold, monitor.direction, monitor.compare);
  const rule = ruleShape(monitor);
  if (breached === state.triggered) {
    // the flag already says this; the only thing left to decide is whether to re-remind
    if (!breached) return UNCHANGED;
    const { repeatSeconds } = policy;
    if (!repeatSeconds || secondsSince(state.lastAlarmAt, now) < repeatSeconds) return UNCHANGED;
    return {
      triggered: null,
      notice: `⚠️ ${name}: ${said(rule, "still")} — ${reading(rule, monitor, value)} (reminder)`,
    };
  }

  // the state changed, and it is written whether or not the owner hears about it
  const quiet = secondsSince(state.lastAlarmAt, now) < policy.cooldownSeconds;
  if (quiet) return { triggered: breached, notice: null };
  const words = breached
    ? `⚠️ ${name}: ${said(rule, saysAbove(rule) ? "crossed" : "fell")} — ${reading(rule, monitor, value)}`
    : `✅ ${name}: ${said(rule, saysAbove(rule) ? "back below" : "back above")} — ${reading(rule, monitor, value)}`;
  return { triggered: breached, notice: words };
}

/** The rule, with the message's own word between what it watches and where (#388): "|Δ| crossed ≥
 *  0.30", "|Δ| still ≥ 0.30", "|Δ| back below 0.30" — `ruleShort` with a verb in it. A recovery
 *  names the side it came back to and drops the sign, which would contradict it.
 *
 *  Nothing is mirrored any more. The notice once printed the raw field beside a SIGNED comparison,
 *  so a short put's delta read "option_delta -0.151 crossed ≥ 0.12", false of the number beside
 *  it, and the comparison was mirrored ("fell ≤ -0.12") to make it true. The short form writes a
 *  magnitude rule as one — `|Δ|` — so the relation is about the size, true of a negative figure as
 *  it stands, and the figure itself is still printed as served, matching the dashboard. */
function said(rule: RuleShape, word: string): string {
  const back = word.startsWith("back");
  return `${subjectOf(rule)} ${word}${back ? "" : ` ${saysAbove(rule) ? "≥" : "≤"}`} ${thresholdText(rule)}`;
}

/** "0.420  ▲ past 0.120": the figure as served, then how far it has to go or how far past it is. */
function reading(rule: RuleShape, monitor: Monitor, value: number): string {
  const d = thresholdDistance(value, monitor.threshold, monitor.direction, monitor.compare);
  return d === null ? figureShort(rule, value) : `${figureShort(rule, value)}  ${distanceShort(rule, d)}`;
}

/** A rule as its short form needs it (#388): the five facts of a Monitor that its words turn on.
 *  `combo` rather than the legs, because the words need only whether it is one — only a spread's
 *  price can be a cost to close — and the expiry notice reads a row it has not hydrated. */
export interface RuleShape {
  field: string;
  combo: boolean;
  compare: string;
  direction: string;
  threshold: number;
}

/** A Monitor's shape, as `monitorLegCodes` reads a combo: legs present and not empty. */
export function ruleShape(monitor: Pick<Monitor, "field" | "compare" | "direction" | "threshold" | "legs">): RuleShape {
  return {
    field: monitor.field, combo: Boolean(monitor.legs && monitor.legs.length > 0),
    compare: monitor.compare, direction: monitor.direction, threshold: monitor.threshold,
  };
}

/** What a rule watches, as a symbol (#388): a price is `value`, a spread's and a single
 *  contract's alike (#404) — the name beside it says which — and the Greeks are their letters.
 *  Vega is `ν`, the Greek letter the other three are, and not `V`, which would read as a value.
 *  An unknown field is written as it is stored. The full sentence the page writes uses these words
 *  too (`frontend/src/needs.ts`'s `fieldWords`, held to these cases). */
function fieldSymbol(field: string): string {
  switch (field) {
    case "mid_price": return "value";
    case "option_delta": return "Δ";
    case "option_gamma": return "Γ";
    case "option_theta": return "Θ";
    case "option_vega": return "ν";
    case "option_implied_volatility": return "IV";
    default: return field;
  }
}

/** Fixed places per field, the dashboard's (ADR 0023): a price to the cent, a delta to three so a
 *  rule 0.004 away does not read "0.00", gamma to four. */
const PLACES: Record<string, number> = { option_delta: 3, option_gamma: 4 };
const placesOf = (field: string) => PLACES[field] ?? 2;

/** A held credit's stop, said as the cost to close it watches: a combo's signed mid at or below a
 *  negative figure, since a combo's value is minus what closing it costs (ADR 0013). Said
 *  `close ≥ 9.44`, never as a negative value — and its figure is that cost. */
function isCostToClose(rule: RuleShape): boolean {
  return rule.combo && rule.field === "mid_price" && rule.compare === "signed"
    && rule.direction === "below" && rule.threshold < 0;
}

/** Whether the rule as SAID is an at-or-above one, which every arrow follows: a cost to close is
 *  said `≥` though stored `below`. Anything not "below" is above, as `isBreached` reads it. */
function saysAbove(rule: RuleShape): boolean {
  return isCostToClose(rule) || rule.direction !== "below";
}

/** "|Δ|", "Δ", "close": the left of the rule — bars for a magnitude, as the comparison reads it. */
function subjectOf(rule: RuleShape): string {
  if (isCostToClose(rule)) return "close";
  const symbol = fieldSymbol(rule.field);
  return rule.compare === "abs" ? `|${symbol}|` : symbol;
}

/** A number as the short form writes it: the minus is the real one, U+2212, as the pace gap's. */
function minus(text: string): string {
  return text.startsWith("-") ? `\u2212${text.slice(1)}` : text;
}

/** The places a threshold was typed with: two at least (`0.20`, not `0.2`), and as many more as it
 *  carries, so a delta's 0.125 is never shown as 0.13 — the issue's examples write a delta's 0.2 as
 *  0.20, its field's three places being for the figure, which moves. */
function typedPlaces(threshold: number): number {
  let places = 2;
  while (places < 10 && Number(threshold.toFixed(places)) !== threshold) places++;
  return places;
}

/** The places a figure and its distance are written to: the field's, or the threshold's where it
 *  was typed finer — a mid of 4.506 against 4.505 is not "4.51, past 0.00" (review of #388). */
const shownPlaces = (rule: RuleShape) => Math.max(placesOf(rule.field), typedPlaces(rule.threshold));

function thresholdText(rule: RuleShape): string {
  const t = isCostToClose(rule) ? -rule.threshold : rule.threshold;
  return minus(t.toFixed(typedPlaces(t)));
}

/** A distance's size, never written as zero when it is not: one too small for the places in use is
 *  "<0.001", since "↑0.000" reads as at the threshold and the bell has not rung. */
function sizeText(size: number, places: number): string {
  return Number(size.toFixed(places)) === 0 ? `<${(10 ** -places).toFixed(places)}` : size.toFixed(places);
}

/** "|Δ| ≥ 0.20", "close ≥ 9.44", "value ≤ −1.50": a rule in symbols, with no figure (#388). */
export function ruleShort(rule: RuleShape): string {
  return `${subjectOf(rule)} ${saysAbove(rule) ? "≥" : "≤"} ${thresholdText(rule)}`;
}

/** The figure as served, to its field's places (or the threshold's, if finer), with a real minus — or, for a cost to close, that
 *  cost. Never made absolute: `|Δ|` beside −0.087 is true of its size. */
export function figureShort(rule: RuleShape, value: number): string {
  return minus((isCostToClose(rule) ? -value : value).toFixed(shownPlaces(rule)));
}

/** How far a figure still has to go, from `thresholdDistance`'s answer: "↑2.41" — an arrow the way
 *  the figure must move to reach the threshold, the way its SIZE must under `abs`, which is the
 *  way the rule's sign points — then, at it, "▲ at", and past it "▲ past 0.050" (`▼` for a rule
 *  said `≤`). The distance is already measured as the rule compares, so this only says it. */
export function distanceShort(rule: RuleShape, distance: number): string {
  const up = saysAbove(rule);
  const places = shownPlaces(rule);
  if (distance > 0) return `${up ? "↑" : "↓"}${sizeText(distance, places)}`;
  if (distance === 0) return `${up ? "▲" : "▼"} at`;
  return `${up ? "▲" : "▼"} past ${sizeText(-distance, places)}`;
}

/** A rule as the notice of an agent's write reads it (#456, ADR 0028): its short form's five facts,
 *  the code it is named by, and whether it is on. */
export interface AgentRule extends RuleShape {
  code: string;
  enabled: boolean;
  /** the names of the holdings the rule watches, as the route links it; absent or empty for none */
  holdings?: string[];
}

/** The one line the owner's phone gets for a write an agent made over MCP (#456, ADR 0028): `before`
 *  null for a rule added, else the rule as it was and as the write left it. In the alarms' short form
 *  (#388), the rule named as every alarm names it (`contractName`), prefixed `🤖 agent`:
 *
 *    🤖 agent added 1218-6750 |value| ≥ 3.00
 *    🤖 agent muted 20261218 P6800 |Δ| ≥ 0.20        (and `unmuted`)
 *    🤖 agent: 1218-6800 |value| ≥ 4.51 → ≥ 4.80     (the subject said once where it is the same)
 *    🤖 agent: 1218-6800 → dec-puts |value| ≥ 4.51   (a rename)
 *    🤖 agent: 1218-6800 |value| ≥ 4.51, unchanged   (an edit that changed nothing said here)
 *
 *  An edit making several changes says each: `🤖 agent muted 1218-6800 |value| ≥ 4.51 → ≥ 4.80`.
 *  A rule added that the route linked to holdings names them, sorted by name (in UTF-16 code units, as
 *  `sort` orders strings): `🤖 agent added 20261218 P7100 |Δ| ≥ 0.20 on 1016_IC` (review of #457). An
 *  edit names none: `edit_rule` changes only a rule that watches no holding. */
export function agentNotice(before: AgentRule | null, after: AgentRule): string {
  const nameOf = (rule: AgentRule) => contractName(rule.code, rule.code);
  if (before === null) {
    const held = [...(after.holdings ?? [])].sort();
    return `🤖 agent added ${nameOf(after)} ${ruleShort(after)}${held.length > 0 ? ` on ${held.join(", ")}` : ""}`;
  }
  const verb = before.enabled && !after.enabled ? "muted" : !before.enabled && after.enabled ? "unmuted" : null;
  const name = before.code === after.code ? nameOf(after) : `${nameOf(before)} → ${nameOf(after)}`;
  const was = ruleShort(before);
  const now = ruleShort(after);
  // the relation alone where the subject is the same, else the whole rule
  const then = subjectOf(before) === subjectOf(after) ? `${saysAbove(after) ? "≥" : "≤"} ${thresholdText(after)}` : now;
  const rule = was === now ? now : `${was} → ${then}`;
  const changed = verb !== null || before.code !== after.code || was !== now;
  return `${verb === null ? "🤖 agent:" : `🤖 agent ${verb}`} ${name} ${rule}${changed ? "" : ", unchanged"}`;
}

/** A holding as the notice of an agent's write to the book reads it (#458, ADR 0029): what it was
 *  recorded with, and its close. Dates as the route serves them, YYYY-MM-DD (either spelling reads). */
export interface AgentHolding {
  name: string;
  strike_date: string;
  legs: Leg[];
  entry: number | null;
  contracts: number;
  opened_at: string | null;
  exit: number | null;
  closed_on: string | null;
}

/** A leg as every place writes it: its sign (a real minus for a short), a quantity of more than one
 *  between the sign and the contract, the type's letter and the strike — `−2P6800`, `+C7350`. */
function legShort(leg: Leg): string {
  const many = leg.qty !== undefined && leg.qty !== 1 ? String(leg.qty) : "";
  return `${leg.side === "short" ? "\u2212" : "+"}${many}${leg.option_type === "CALL" ? "C" : "P"}${leg.strike}`;
}

/** A price a person typed — an entry, an exit — to its typed places (two at least), a real minus. */
const typedPrice = (value: number) => minus(value.toFixed(typedPlaces(value)));

/** "A", "A and B", "A, B and C". */
function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The one line the owner's phone gets for a write an agent made to the BOOK over MCP (#458, ADR 0029):
 *  `before` null for a holding recorded, else the holding as it was and as the write left it, whose close
 *  was corrected. Prefixed `🤖 agent`, as `agentNotice`'s are:
 *
 *    🤖 agent recorded dec-condor 20261218 −P6800 +P6750 ×2 @ 1.25, opened 20261119
 *    🤖 agent corrected the close of dec-condor: exit 0.40 → 0.35, closed 20261118 → 20261119
 *
 *  A record writes the legs short first, each as every place writes a leg, `×` the contracts, `@` the
 *  entry and the day it was opened, each left out where it is null; and where the route linked
 *  existing rules to the new holding (`taken`), it names them in the alarms' short form, sorted (in
 *  UTF-16 code units, as `sort` orders strings): `…, taking over 1218-6800 |value| ≥ 4.51`. A
 *  correction says only what changed — a blank exit is `—` — and `unchanged` where nothing did. */
export function agentHoldingNotice(before: AgentHolding | null, after: AgentHolding, taken: AgentRule[] = []): string {
  if (before === null) {
    const legs = [...after.legs.filter((l) => l.side === "short"), ...after.legs.filter((l) => l.side !== "short")];
    const parts = [`🤖 agent recorded ${after.name} ${compactStrikeDate(after.strike_date)} ${legs.map(legShort).join(" ")} ×${after.contracts}`];
    if (after.entry !== null) parts[0] += ` @ ${typedPrice(after.entry)}`;
    if (after.opened_at !== null) parts.push(`opened ${compactStrikeDate(after.opened_at)}`);
    const rules = taken.map((r) => `${contractName(r.code, r.code)} ${ruleShort(r)}`).sort();
    if (rules.length > 0) parts.push(`taking over ${listed(rules)}`);
    return parts.join(", ");
  }
  const exitText = (exit: number | null) => (exit === null ? "—" : typedPrice(exit));
  const dayText = (day: string | null) => (day === null ? "—" : compactStrikeDate(day));
  const changed: string[] = [];
  if (before.exit !== after.exit) changed.push(`exit ${exitText(before.exit)} → ${exitText(after.exit)}`);
  if (dayText(before.closed_on) !== dayText(after.closed_on)) {
    changed.push(`closed ${dayText(before.closed_on)} → ${dayText(after.closed_on)}`);
  }
  return `🤖 agent corrected the close of ${after.name}: ${changed.length > 0 ? changed.join(", ") : "unchanged"}`;
}
