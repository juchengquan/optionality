/** One contract's draft (#331, ADR 0023): a Monitor on a single Contract — any of its six fields,
 *  either direction, either compare — and, when it is held, the lone-contract holding it warns about.
 *
 *  Pure, so what a save posts is decided here and tested here; `AddContract.tsx` only draws it.
 *
 *  - It is saved as a SPREAD OF ONE LEG through `POST /spreads`, with the one Monitor naming that
 *    leg: one request, all of it or none, and the route's linking and replacing are a spread's —
 *    a held contract's rule is linked to ITS holding even where another holding shares the strike,
 *    and a watch rule on the same (contract, field) is replaced rather than refused (#322). The
 *    door scenarios hold what the route does with it.
 *  - Watched, the one Monitor. Held, the Monitor typed, or none if the owner says so; no default
 *    rule is added — #293's defaults (2x the Entry, the short leg at 0.30) are a spread's.
 *  - The Entry is typed as what MOVED, received or paid, and the side signs it: a long's paid 5.00
 *    is stored -5.00, as a Position's Entry is (CONTEXT.md: Entry). Typing it signed as well would
 *    be two signs for one fact, so a minus is refused rather than guessed at.
 *  - Opened starts as the New York trading day, never the local one (ADR 0011), as #293's does.
 */
import type { DraftPayoff, Monitor } from "../api";
import {
  contractCode, derivedName, ruleWords as replacedWords, type OptionType, type Side, type SpreadsBody,
} from "./add";

/** What `POST /monitors` lets one Contract watch, as today's form offers it. IV is offered here and
 *  not to a spread: a spread's figure is a sum and IV is not additive, but one contract's is its own. */
export const CONTRACT_FIELDS = [
  "option_delta", "mid_price", "option_implied_volatility", "option_theta", "option_vega", "option_gamma",
] as const;

export type Direction = "above" | "below";
export type Compare = "abs" | "signed";

export interface ContractDraft {
  held: boolean;
  /** a held contract's Monitor is made unless switched off; a watched one always has it */
  rule: boolean;
  /** YYYY-MM-DD */
  expiry: string;
  /** a held contract's Opened, the New York trading day unless changed */
  opened: string;
  option_type: OptionType;
  /** as typed */
  strike: string;
  field: string;
  direction: Direction;
  compare: Compare;
  /** as typed */
  threshold: string;
  /** a held contract's: which way the money went */
  side: Side;
  /** as typed, unsigned: what was received (short) or paid (long), per contract */
  entry: string;
  contracts: string;
  /** as typed; blank takes `contractName` */
  name: string;
}

/** Where a refusal is said: beside the box it is about, or by the save button. */
export type ContractSpot =
  "expiry" | "opened" | "strike" | "threshold" | "field" | "entry" | "contracts" | "name" | "form";

/** A put's delta, watched — the common case on today's page — opened `today`, a New York trading
 *  day the caller supplies. */
export function newContract(today: string): ContractDraft {
  return {
    held: false, rule: true, expiry: "", opened: today, option_type: "PUT", strike: "", field: "option_delta",
    direction: "above", compare: "abs", threshold: "", side: "short", entry: "", contracts: "1", name: "",
  };
}

/** `1218_P7150`: named as `add.ts` names a spread, with its one leg — the strike as the NUMBER it
 *  parses to, so "+7150", "7150.0" and "07150" all name the one contract they mean. */
export const contractName = (expiry: string, type: OptionType, strike: number) =>
  derivedName(expiry, [{ side: "short", option_type: type, strike: String(strike) }]);

/** A plain decimal only, as the Monitor editor reads one (`edit.ts`): Number() also reads "0x10" as
 *  16 and "1e-2" as 0.01, none of which is a figure anybody typed on purpose. */
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A number as typed, or null for blank or not a plain number. */
function typed(text: string): number | null {
  const t = text.trim();
  return PLAIN.test(t) ? Number(t) : null;
}

/** The threshold the route would refuse (`thresholdFault` in the domain), in the form's words, or
 *  null — said beside the box as it is typed, before anything is sent. */
export function thresholdFault(compare: string, threshold: string): string | null {
  const t = typed(threshold);
  if (t === null) return null;
  if (compare === "signed" && t === 0) return "a signed threshold is never exactly 0: use e.g. ±0.01";
  if (compare === "abs" && t <= 0) return "|x| compares the size, so the threshold is above 0";
  return null;
}

/** The draft as the request that saves it, or the first thing wrong with it and where to say so.
 *  @param today the New York trading day: an expiry before it has passed, and Opened is not after it */
export function contractBody(d: ContractDraft, today: string): { body: SpreadsBody } | { error: string; at: ContractSpot } {
  if (d.expiry.trim() === "") return { error: "type the expiry", at: "expiry" };
  if (d.expiry < today) return { error: "that expiry has passed", at: "expiry" };
  const strike = typed(d.strike);
  if (strike === null || strike <= 0) return { error: "type the strike", at: "strike" };
  const leg = { side: d.side, option_type: d.option_type, strike };
  const name = d.name.trim() || contractName(d.expiry, d.option_type, strike);

  const monitors: SpreadsBody["spreads"][number]["monitors"] = [];
  if (d.rule || !d.held) {
    if (d.threshold.trim() === "") return { error: "type a threshold", at: "threshold" };
    const threshold = typed(d.threshold);
    if (threshold === null) return { error: "the threshold is not a number", at: "threshold" };
    const fault = thresholdFault(d.compare, d.threshold);
    if (fault) return { error: fault, at: "threshold" };
    monitors.push({
      option_type: d.option_type, strike, field: d.field, threshold, direction: d.direction, compare: d.compare,
    });
  }
  if (!d.held) {
    return { body: { strike_date: d.expiry, spreads: [{ name, held: false, legs: [leg], monitors }] } };
  }

  const opened = d.opened.trim();
  if (opened !== "" && opened > d.expiry) return { error: "Opened is after the expiry", at: "opened" };
  if (opened !== "" && opened > today) return { error: "Opened is after today's New York trading day", at: "opened" };
  let entry: number | null = null;
  if (d.entry.trim() !== "") {
    entry = typed(d.entry);
    if (entry === null) return { error: "the Entry is not a number", at: "entry" };
    if (entry < 0 || Object.is(entry, -0)) {
      return { error: `type the Entry as what was ${d.side === "short" ? "received" : "paid"}: the side signs it`, at: "entry" };
    }
  }
  const contracts = typed(d.contracts);
  if (contracts === null || !Number.isInteger(contracts) || contracts < 1) {
    return { error: "contracts is a whole number, 1 or more", at: "contracts" };
  }
  return {
    body: {
      strike_date: d.expiry,
      spreads: [{
        name, held: true, legs: [leg],
        // a null has no sign to flip, and 0 is a real Entry of nothing whichever way it went
        entry: entry === null ? null : signed(d.side, entry),
        contracts, opened_at: opened === "" ? null : opened, monitors,
      }],
    },
  };
}

/** Where `POST /spreads`'s refusal is said, read from its words — which are the older routes',
 *  word for word (`create-spread.ts`): a threshold's fault beside the threshold, a rule already on
 *  that figure beside what it watches, a holding's name taken beside the name, and anything else —
 *  an unknown contract, a service down — by the button. */
export function refusalSpot(text: string): ContractSpot {
  if (/threshold/i.test(text)) return "threshold";
  if (/^position '.*' already exists/.test(text)) return "name";
  if (/already exists|cannot watch/i.test(text)) return "field";
  return "form";
}

/** The WATCH rules saving this will replace, in the words the spread form uses: a Monitor already on
 *  the (contract, field) a HELD contract's rule makes, owned by no holding (#322). A watched
 *  contract, or a holding with no rule, replaces nothing. Read from the `/monitors` the page has. */
export function contractReplaces(d: ContractDraft, monitors: Monitor[]): string[] {
  const strike = typed(d.strike);
  if (!d.held || !d.rule || strike === null || strike <= 0 || d.expiry.length < 10) return [];
  const code = contractCode(d.expiry, d.option_type, strike);
  return monitors.filter((m) => m.code === code && m.field === d.field && m.positions.length === 0).map(replacedWords);
}

/** What moved, signed as a Position's Entry: received positive, paid negative; never -0. */
const signed = (side: Side, amount: number) => (side === "long" ? -amount : amount) || 0;

/** A held contract's payoff at expiry, PER CONTRACT as the spread form's is (privacy hides the
 *  count), at its Entry — or null: a watched contract has no side to draw, and none before its
 *  strike is typed. */
export function contractPreview(d: ContractDraft): DraftPayoff | null {
  const strike = typed(d.strike);
  if (!d.held || strike === null || strike <= 0) return null;
  const entry = typed(d.entry);
  return {
    legs: [{ side: d.side, option_type: d.option_type, strike }],
    entry: entry === null || entry < 0 ? 0 : signed(d.side, entry),
    contracts: 1,
  };
}

/** The words under the preview: per contract, at what — or that no Entry was given, rather than a
 *  credit of nothing nobody typed. */
export function contractNote(d: ContractDraft): string {
  const entry = typed(d.entry);
  if (entry === null || entry < 0) return "per contract — no Entry given, so drawn at 0";
  return `per contract, at a ${d.side === "long" ? "debit" : "credit"} of ${entry.toFixed(2)}`;
}

/** What a save will make, said on its button: a holding and a Monitor, never contracts. */
export const contractSaveWords = (d: ContractDraft) =>
  !d.held ? "Watch it + 1 Monitor" : d.rule ? "Record holding + 1 Monitor" : "Record holding";
