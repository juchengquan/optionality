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
import { isBreached, thresholdDistance, type Monitor } from "./monitor.ts";

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
 *  `combo` rather than the legs, because the words need only whether it is one — a spread's price
 *  is its `val`, a contract's its `mid` — and the expiry notice reads a row it has not hydrated. */
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

/** What a rule watches, as a symbol (#388). Vega is `ν`, the Greek letter the other three are, and
 *  not `V`, which beside `val` would read as a value. An unknown field is written as it is stored. */
function fieldSymbol(field: string, combo: boolean): string {
  switch (field) {
    case "mid_price": return combo ? "val" : "mid";
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
  const symbol = fieldSymbol(rule.field, rule.combo);
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

/** "|Δ| ≥ 0.20", "close ≥ 9.44", "val ≤ −1.50": a rule in symbols, with no figure (#388). */
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
