/** The watchlist entries the dashboard and the bot render (ADR 0009, phase 5).
 *
 *  Ported from monitor.py's build_entries and watchlist_quotes. Everything a client needs without
 *  re-deriving it: how long the contract has left, which holdings the rule watches, what they cost
 *  to close, and how close it is to firing. These used to be computed in routes/ui.py and reachable
 *  over no endpoint at all.
 */
import {
  COMBO_GREEK_FIELDS, comboFieldSum, isBreached, monitorLegCodes, monitorValue, thresholdDistance,
  thresholdFill,
} from "optionality/domain/monitor";
import { dteAtOpen, exitLevels, type ExitLevels, type ExitPolicy } from "optionality/domain/exit";
import { daysToExpiry } from "optionality/domain/expiry";
import {
  combinedCostToClose, combinedEntry, combinedPnl, costToCloseOf, holdsAnyOf, positionLegCodes,
} from "optionality/domain/position";
import type { Monitor, MonitorLeg } from "optionality/domain/monitor";
import type { Position } from "optionality/domain/position";
import { buildSpxCode } from "optionality/domain/contract";
import { derivedSpx, strikeDistances, type StrikeDistance } from "optionality/domain/quote";
import type { QuoteRecord } from "optionality/quotes";

export interface WatchlistEntry {
  id: string;
  code: string;
  strike_date: string;
  /** CALL, PUT, or the CMB a combo is stored as — what the monitors column says, passed through.
   *  The dashboard groups by it, and a single-leg row used to carry nothing to group by: only
   *  moomoo's `US.SPXW261130C8100000`, which would have had to be parsed in the browser. */
  option_type: string;
  field: string;
  threshold: number;
  direction: string;
  compare: string;
  /** breaching NOW, by the figures in this same entry — not the alarm engine's stored verdict.
   *  `last_value` used to sit here too, the sweep's figure beside this fetch's; no client read it
   *  and `/monitors` is where the engine's own record belongs. See ADR 0010. */
  triggered: boolean;
  /** the contract's own figures; null for a combo, which has no single contract */
  /** the live figures for this contract, or null for a combo — CONTEXT.md calls this a Quote;
   *  moomoo's "snapshot" stays in opend/, which is where their wire format belongs */
  quote: QuoteRecord | null;
  legs?: MonitorLeg[];
  combo_value?: number | null;
  combo_greeks?: Record<string, number | null>;
  error?: string;
  dte: number;
  scope: string | null;
  positions: { id: string; name: string }[];
  /** whether ANY Contract this rule watches — the one, or any leg of a combo — is a Leg of an OPEN
   *  holding, whether or not the link to one holding is ambiguous (`holdsAnyOf`). A fact about
   *  Contracts, not a guess about what the rule is for: it tells a risk alarm on something owned
   *  from an entry signal on a candidate where `positions` cannot, because the link names nothing
   *  on a roll day, when two holdings share a Contract. It is also true for a candidate that shares
   *  one Contract with a holding, which is a fact about that Contract (ADR 0023). */
  held: boolean;
  /** the combos in this same watchlist whose legs include this row's Contract, by id and sorted:
   *  what lets a short leg's delta rule sit under its spread (ADR 0023). A DISCOVERED link, like
   *  `positions` — worked out from the legs each combo names, never recorded, so it is only ever
   *  as true as those rules are now. Empty on a combo's own row, and for a Contract no enabled
   *  combo holds. */
  in_combos: string[];
  cost_to_close: number | null;
  entry: number | null;
  pnl: number | null;
  fill: number | null;
  /** the figure this row is about — the very reading `fill` and `triggered` are drawn from, so a
   *  sentence built from it cannot disagree with the bar or the bell. The raw, SIGNED figure: under
   *  compare "abs" the bar, the bell and `distance` all measure its magnitude. Null where it was
   *  not priced, and where JSON cannot write it (NaN, ±Infinity) — an infinite reading still rings. */
  watched: number | null;
  /** how far `watched` still has to move to breach, in the field's own units: wherever it is a
   *  number, at or below zero exactly when `triggered` (`thresholdDistance`). Null wherever
   *  `watched` is, which says nothing about the bell. */
  distance: number | null;
  /** the exit schedule, or null where there is no single holding to schedule (ADR 0011).
   *
   *  `position_id` names the holding it is FOR. `positions` happens to hold exactly that one
   *  wherever a schedule exists — a schedule needs `scope: "all"` and one Position — but a client
   *  that read `positions[0]` would be relying on that coincidence, and the next change to either
   *  condition would move the figure onto the wrong holding in silence. */
  schedule: (ExitLevels & { dte_at_open: number; position_id: string }) | null;
  /** SPX's price as THIS batch implies it, from its options' premiums (`derivedSpx`, ADR 0024):
   *  the same on every row, because every row came from the one batch, and on the row so a strike
   *  can be placed against the index of the same instant as its own figures (ADR 0010). Null where
   *  the batch cannot give it; never a Reference's figure (ADR 0018). */
  spx: number | null;
  /** why `spx` is null, in words; null when there is a figure */
  spx_reason: string | null;
  /** a combo's SHORT legs (minus is short) placed against `spx`, in points and σ, with each leg's
   *  own delta from this batch (`strikeDistances`, #297): what the strike strip draws. Empty for a
   *  single contract, which is no spread. */
  short_strikes: StrikeDistance[];
}

/** What buildEntries needs, and deliberately no more: the engine's `triggered` and `last_value`
 *  columns are NOT here, so the entry cannot be built from them. That is the fix made structural
 *  rather than written down — it was a comment before, and the comment was accurate while the code
 *  beside it was not. */
export interface MonitorForEntry extends Monitor {
  id: string;
  scope: string | null;
}

interface EntryInputs {
  monitors: MonitorForEntry[];
  byCode: Record<string, QuoteRecord>;
  /** codes OpenD rejected as unknown */
  bad: Set<string>;
  owned: Record<string, (Position & { id: string })[]>;
  /** every OPEN holding, linked to a rule or not — what `held` is decided against. Required for
   *  the reason `policy` is: a row that says "nothing held" because a caller passed nothing is the
   *  very misfiling the field exists to prevent. */
  holdings: Position[];
  /** injectable so a test can state the date rather than wait for it */
  now?: Date;
  /** REQUIRED rather than optional: a schedule that silently does not appear because a caller
   *  forgot to pass the policy is the shape of bug this project keeps finding. The compiler
   *  names every call site instead. */
  policy: ExitPolicy;
}

/** Watchlist entries for a set of monitors against an already-fetched batch of records.
 *
 *  Combo entries carry their signed sum under `combo_value` and no per-contract quote: summing
 *  other fields under the combo's signs would fabricate plausible-but-wrong aggregates, and IV is
 *  never summed at all (CLAUDE.md).
 */
export function buildEntries(inputs: EntryInputs): WatchlistEntry[] {
  const { monitors, byCode, bad, owned, holdings, now, policy } = inputs;
  // every combo in this watchlist, by the Contracts its legs name: the spreads a single Contract
  // sits in are found from these, as the holdings a rule watches are found from what is held
  const combos = monitors
    .filter((m) => m.legs && m.legs.length > 0)
    .map((m) => ({ id: m.id, codes: new Set(monitorLegCodes(m)) }));
  // once for the batch: every row was priced by it, so every row carries the same index level
  const spx = derivedSpx(Object.values(byCode));
  return monitors.map((m) => {
    const isCombo = Boolean(m.legs && m.legs.length > 0);
    const positions = owned[m.id] ?? [];
    const quote = isCombo ? null : (byCode[m.code] ?? null);

    const comboValue = isCombo ? monitorValue(m, byCode) : undefined;
    // What it would cost to buy back the options in question (CONTEXT.md) — and "in question"
    // means the Contracts this Monitor NAMES, not the holding's Legs. A Monitor watches Contracts,
    // never a Position; the holding is found afterwards.
    //
    // So an alarm on the call side of a condor costs the call side. It used to be compared against
    // the whole condor's cost: you named two options and it fired on four. For an alarm covering
    // the holding whole this is the same number it always gave.
    //
    // A single Contract reports the figure only when it IS the whole holding — otherwise the row
    // is about one option and the holding's cost belongs on the holding's own row.
    //
    // Only where you hold the Contracts: buying back something you do not have is not a cost, and
    // an unheld combo is still shown and measured on its own signed sum.
    let costToClose: number | null = null;
    if (positions.length > 0) {
      if (isCombo) {
        // costed from the holding's SIDES, restricted to the Contracts this Monitor names — not
        // from the combo's own signed sum. That sum is in the Monitor's own field, which may be
        // delta, and its sign depends on which of the two leg conventions the legs were entered
        // under (#97): derived from signs this figure is inverted under one of them.
        costToClose = costToCloseOf(positions, byCode, monitorLegCodes(m));
      } else if (m.scope === "all") {
        costToClose = combinedCostToClose(positions, byCode, m.scope);
      }
    }
    // only a rule that covers whole positions has an entry to speak of; a leg rule watches part of
    // a structure and its P&L would be a fraction of someone else's credit
    const whole = m.scope === "all" ? positions : [];

    const entry: WatchlistEntry = {
      id: m.id,
      code: m.code,
      strike_date: m.strike_date,
      option_type: m.option_type,
      field: m.field,
      threshold: m.threshold,
      direction: m.direction,
      compare: m.compare,
      // derived below, from the figure this row actually shows
      triggered: false,
      quote,
      dte: daysToExpiry(m.strike_date, now),
      scope: m.scope,
      positions: positions.map((p) => ({ id: p.id, name: p.name })),
      held: holdsAnyOf(holdings, monitorLegCodes(m)),
      in_combos: isCombo ? [] : combos.filter((c) => c.codes.has(m.code)).map((c) => c.id).sort(),
      cost_to_close: costToClose,
      entry: whole.length > 0 ? combinedEntry(whole) : null,
      pnl: whole.length > 0 ? combinedPnl(whole, byCode) : null,
      // these three are derived below, from the one figure this row is about
      fill: null,
      watched: null,
      distance: null,
      // ONE holding only. Two Positions put on different days have no single DTE at entry, and a
      // blended pace line would hide that rather than say it — ADR 0004 allows a rule to span
      // them, and this declines to guess rather than averaging two trades into one.
      schedule: null,
      spx: spx.price,
      spx_reason: spx.reason,
      short_strikes: isCombo
        ? strikeDistances(
          m.legs!.filter((l) => l.sign < 0).map((l) => buildSpxCode(m.strike_date, l.option_type, l.strike)),
          byCode, spx.price, daysToExpiry(m.strike_date, now))
        : [],
    };

    if (isCombo) {
      entry.legs = m.legs!;
      entry.combo_value = comboValue;
      entry.combo_greeks = Object.fromEntries(
        COMBO_GREEK_FIELDS.map((f) => [f, comboFieldSum(m, byCode, f)]),
      );
    }
    if (monitorLegCodes(m).some((c) => bad.has(c))) entry.error = "unknown contract";

    // The figure this row is about, read ONCE and then used for both the fill bar and the bell.
    // They are one claim drawn twice and must not be able to disagree: the bell came from the
    // sweep's stored column while every figure beside it came from this fetch, so a row could show
    // a value past its threshold with no bell, or a bell beside a value well inside it (ADR 0010).
    //
    // It is the rule's OWN field, under the rule's own direction and compare — `monitorValue`,
    // which is the very call the sweep evaluates every rule with. A held combo used to be measured
    // on its cost to close instead, with above/abs forced: that is a PRICE, which a delta rule's
    // threshold is not, so a delta alarm rang here for ever while the sweep stayed silent. Its cost
    // to close is still shown, in its own column; it is not what any alarm is decided by.
    //
    // The price cases are unchanged: under compare 'abs' the sign washes out, so a combo summing to
    // -4.00 and a 4.00 cost to close give the same bell and the same bar.
    //
    // A single Contract's figure was CAST rather than read through `monitorValue`, which made no
    // difference while only the bar and the bell used it — `Math.abs` and `>=` coerce as `Number()`
    // does — and would have served text as the figure once it was served itself.
    const read = isCombo ? comboValue : monitorValue(m, byCode);
    const watched = read ?? null;
    entry.fill = thresholdFill(watched, m.threshold, m.direction, m.compare);
    // An unreadable figure is neither calm nor breaching, so no bell beside a dash — otherwise the
    // stored state would be back, by the other door. isBreached is the ENGINE's own predicate fed
    // the ENGINE's own value, so the bell flips at the exact threshold and cannot drift from how an
    // alarm is decided. A NaN is unreadable and rings nothing, as the sweep's own comparison says.
    entry.triggered = watched !== null && isBreached(watched, m.threshold, m.direction, m.compare);
    // The figure and its distance are SERVED only where JSON can write them. A NaN or an infinite
    // reading in the reply fails its schema and takes every other row of the watchlist down with
    // it, so it is served as no figure — a field the quote schema does not type can carry either.
    // The bar and the bell above are still decided on it: an infinite reading rings, as the sweep
    // alarms on it, and its row shows a bell with no figure and no distance beside it.
    entry.watched = servable(watched);
    entry.distance = entry.watched === null
      ? null
      : servable(thresholdDistance(entry.watched, m.threshold, m.direction, m.compare));

    // Built from THIS entry's own cost to close, so the gap is the gap against the figure the row
    // shows. Fetching /positions/values beside it on the dashboard would compute it against a
    // different instant, which is the fault ADR 0010 settled.
    const held = whole.length === 1 ? whole[0]! : undefined;
    if (held?.opened_at) {
      const openedDte = dteAtOpen(held.strike_date, held.opened_at);
      const levels = exitLevels(held.entry, openedDte, entry.dte, policy, entry.cost_to_close);
      if (levels !== null) entry.schedule = { dte_at_open: openedDte, position_id: held.id, ...levels };
    }
    return entry;
  });
}

/** A figure as the reply can carry it: a finite number, or null. */
function servable(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/** Every code a batch has to carry for these monitors and the positions they watch.
 *
 *  A Position can hold legs no Monitor names — a rule watching one wing of a condor, say. Without
 *  them the cost to close would be a partial sum, so they join the batch instead. */
export function codesFor(
  monitors: MonitorForEntry[], owned: Record<string, (Position & { id: string })[]>,
): string[] {
  const codes = new Set<string>();
  for (const m of monitors) for (const c of monitorLegCodes(m)) codes.add(c);
  for (const positions of Object.values(owned)) {
    for (const p of positions) for (const c of positionLegCodes(p)) codes.add(c);
  }
  return [...codes].sort();
}
